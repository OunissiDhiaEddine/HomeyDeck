import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { startRedisRest } from "../scripts/redis-rest.js";
import { magicPacket, parseMAC } from "../lib/wol.js";

const ADMIN_PASSWORD = "correct horse battery staple";
let db;
let routes;
let pcsLib;
let httpLib;

before(async () => {
  db = await startRedisRest();
  Object.assign(process.env, {
    KV_REST_API_URL: db.url,
    KV_REST_API_TOKEN: db.token,
    ADMIN_USERNAME: "Boss",
    ADMIN_PASSWORD,
    DATA_KEY: "d".repeat(44),
  });
  delete process.env.MAX_PCS_PER_USER;
  routes = {
    "/api/health": await import("../api/health.js"),
    "/api/session": await import("../api/session.js"),
    "/api/account": await import("../api/account.js"),
    "/api/admin": await import("../api/admin.js"),
    "/api/pcs": await import("../api/pcs.js"),
    "/api/status": await import("../api/status.js"),
    "/api/command": await import("../api/command.js"),
    "/api/agent/pair": await import("../api/agent/pair.js"),
    "/api/agent/poll": await import("../api/agent/poll.js"),
    "/api/agent/result": await import("../api/agent/result.js"),
  };
  pcsLib = await import("../lib/pcs.js");
  httpLib = await import("../lib/http.js");
});
after(() => db.close());

const ORIGIN = "https://deck.test";

/** A browser with its own cookie jar. */
class Browser {
  cookie = "";
  request(path, body, { method = body === undefined ? "GET" : "POST", headers = {} } = {}) {
    return new Request(ORIGIN + path, {
      method,
      headers: { Origin: ORIGIN, Host: "deck.test", "Content-Type": "application/json", Cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async send(path, body, opts) {
    const req = this.request(path, body, opts);
    const res = await routes[new URL(req.url).pathname][req.method](req);
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    return { status: res.status, data: await res.json() };
  }
  login(username, password) {
    return this.send("/api/session", { action: "login", username, password });
  }
}

const agentRequest = (path, token, body) =>
  new Request(ORIGIN + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const agent = async (path, token, body = {}) => {
  const res = await routes[path].POST(agentRequest(path, token, body));
  return { status: res.status, data: await res.json() };
};

async function adminBrowser() {
  const b = new Browser();
  const res = await b.login("boss", ADMIN_PASSWORD);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return b;
}

async function newUser(admin, name) {
  const { data } = await admin.send("/api/admin", { action: "invite_create" });
  const b = new Browser();
  const res = await b.send("/api/session", { action: "signup", invite: data.code, username: name, password: "a long enough password" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return b;
}

async function pairPc(browser, fields = {}) {
  const add = await browser.send("/api/pcs", { action: "add", name: "Gaming PC", mac: "aa-bb-cc-dd-ee-ff", host: "127.0.0.1", port: 9, ...fields });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const paired = await agent("/api/agent/pair", "", { code: add.data.code.toLowerCase(), hostname: "DESKTOP-1" });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
  const me = await browser.send("/api/session");
  return { token: paired.data.token, pc: me.data.pcs.at(-1).id, code: add.data.code, text: add.data.text };
}

test("health reports what is configured, never values", async () => {
  const res = await (await routes["/api/health"].GET()).json();
  assert.deepEqual(res, { ok: true, database: true, dataKey: true, admin: true, adminPasswordSet: true, maxPcs: 3 });
});

test("the admin account is created on its first sign-in from the env vars", async () => {
  await db.flush();
  const b = new Browser();
  assert.equal((await b.login("boss", "wrong password!!")).status, 401);
  const ok = await b.login("BOSS", ADMIN_PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, "admin");
  const me = await b.send("/api/session");
  assert.equal(me.data.user.name, "BOSS");
  assert.deepEqual(me.data.pcs, []);
  // Only once: a second admin can't be minted.
  assert.equal((await new Browser().login("boss", ADMIN_PASSWORD)).status, 200);
  assert.equal(await db.raw(["SCARD", "users"]), 1);
});

test("signup needs a valid, unused, unexpired invite", async () => {
  const admin = await adminBrowser();
  const b = new Browser();
  const signup = (invite, username = "alice") => b.send("/api/session", { action: "signup", invite, username, password: "a long enough password" });
  assert.equal((await signup("NOPE-NOPE-NOPE")).status, 403);

  const { data } = await admin.send("/api/admin", { action: "invite_create", days: 7 });
  assert.match(data.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await b.send("/api/session", { action: "signup", invite: data.code, username: "al", password: "a long enough password" })).status, 400);
  assert.equal((await b.send("/api/session", { action: "signup", invite: data.code, username: "alice", password: "short" })).status, 400);
  assert.equal((await signup(data.code, "boss")).status, 409); // the admin's name is reserved
  assert.equal((await signup(data.code.toLowerCase().replace(/-/g, " "))).status, 200);
  assert.equal((await new Browser().send("/api/session", { action: "signup", invite: data.code, username: "bob", password: "a long enough password" })).status, 403);

  const second = await admin.send("/api/admin", { action: "invite_create" });
  assert.equal((await new Browser().send("/api/session", { action: "signup", invite: second.data.code, username: "ALICE", password: "a long enough password" })).status, 409);

  const expired = await admin.send("/api/admin", { action: "invite_create", days: 1 });
  const list = await admin.send("/api/admin");
  const inv = list.data.invites.find((i) => i.state === "open" && i.expires);
  await db.raw(["HSET", `invite:${inv.id}`, "exp", Date.now() - 1000]);
  assert.equal((await new Browser().send("/api/session", { action: "signup", invite: expired.data.code, username: "carol", password: "a long enough password" })).status, 403);

  const after = await admin.send("/api/admin");
  assert.deepEqual(after.data.invites.map((i) => i.state).sort(), ["expired", "open", "used"]);
  assert.equal(after.data.invites.find((i) => i.state === "used").usedBy, "alice");
  assert.equal((await b.login("Alice", "a long enough password")).status, 200);
});

test("cross-site and non-JSON requests are refused", async () => {
  const b = await adminBrowser();
  assert.equal((await b.send("/api/admin", { action: "invite_create" }, { headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await b.send("/api/admin", { action: "invite_create" }, { headers: { Origin: "" } })).status, 403);
  assert.equal((await b.send("/api/admin", { action: "invite_create" }, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await new Browser().send("/api/session")).status, 401);
  assert.equal((await new Browser().send("/api/admin")).status, 401);
});

test("pairing: a single-use code turns into a PC with encrypted wake details", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const alice = await newUser(admin, "alice");
  const { token, pc, code, text } = await pairPc(alice);
  assert.equal(text, `homeydeck-pair:deck.test/${code}`);
  assert.equal((await agent("/api/agent/pair", "", { code, hostname: "x" })).status, 404);

  const me = await alice.send("/api/session");
  assert.deepEqual(me.data.pcs.map(({ name, wake, port }) => ({ name, wake, port })), [{ name: "Gaming PC", wake: true, port: 9 }]);
  const uid = me.data.user.id;
  const stored = await db.raw(["HGETALL", `pc:${uid}:${pc}`]);
  assert.ok(!stored.join(" ").includes("AA:BB") && !stored.join(" ").includes("127.0.0.1"), "MAC and host are stored encrypted");
  const details = await alice.send("/api/pcs", { action: "details", pc });
  assert.deepEqual(details.data, { ok: true, name: "Gaming PC", mac: "AA:BB:CC:DD:EE:FF", host: "127.0.0.1", port: 9 });
  assert.ok(token.startsWith(`${uid}.`));

  const status = await alice.send(`/api/status?pc=${pc}`);
  assert.equal(status.data.phase, "offline");
  assert.equal(status.data.hostname, "DESKTOP-1");
});

test("an agent poll costs one database command, a status check two", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const { token, pc } = await pairPc(admin);

  db.resetCount();
  const poll = await agent("/api/agent/poll", token, { hostname: "PC", steamRunning: true, uptimeSeconds: 99, agentVersion: "1" });
  assert.equal(db.commands, 1);
  assert.deepEqual(poll.data, { commands: [], pollSeconds: pcsLib.POLL_IDLE_S, fastUntil: 0 });

  db.resetCount();
  let s = await admin.send(`/api/status?pc=${pc}`);
  assert.equal(db.commands, 2);
  assert.equal(s.data.phase, "online");
  assert.equal(s.data.steamRunning, true);

  // Watching asks the agent to speed up, once.
  db.resetCount();
  await admin.send(`/api/status?pc=${pc}&watch=1`);
  await admin.send(`/api/status?pc=${pc}&watch=1`);
  assert.equal(db.commands, 5);
  const fast = await agent("/api/agent/poll", token, {});
  assert.equal(fast.data.pollSeconds, pcsLib.POLL_FAST_S);
  // The agent echoes fastUntil back, so watching costs nothing extra while it lasts.
  await agent("/api/agent/poll", token, { fastUntil: fast.data.fastUntil });
  db.resetCount();
  await admin.send(`/api/status?pc=${pc}&watch=1`);
  assert.equal(db.commands, 2);
  const still = await agent("/api/agent/poll", token, { fastUntil: fast.data.fastUntil });
  assert.equal(still.data.pollSeconds, pcsLib.POLL_FAST_S);
  // Without it the agent drops back to idle.
  assert.equal((await agent("/api/agent/poll", token, {})).data.pollSeconds, pcsLib.POLL_IDLE_S);
});

const sendCommand = (browser, body, opts) => httpLib.route(pcsLib.sendCommand)(browser.request("/api/command", body), process.env, opts);

test("a command reaches the agent once and its answer comes back", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const { token, pc } = await pairPc(admin);
  await agent("/api/agent/poll", token, { hostname: "PC" });

  const pending = sendCommand(admin, { pc, action: "sleep" }, { waitMs: 3000, stepMs: 20 });
  await new Promise((r) => setTimeout(r, 50));
  const poll = await agent("/api/agent/poll", token, { hostname: "PC" });
  assert.equal(poll.data.commands.length, 1);
  assert.equal(poll.data.commands[0].action, "sleep");
  assert.equal(poll.data.pollSeconds, pcsLib.POLL_FAST_S);
  assert.deepEqual((await agent("/api/agent/poll", token, { hostname: "PC" })).data.commands, []);

  await agent("/api/agent/result", token, { id: poll.data.commands[0].id, action: "sleep", ok: true });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await admin.send(`/api/status?pc=${pc}`)).data.phase, "sleeping");
});

test("sleep shows as asleep once the PC stops checking in, a restart until it's back", () => {
  const now = Date.now();
  const power = (action, ago) => ({ action, at: now - ago });
  const fast = (ago) => ({ lastSeen: now - ago, fastUntil: now + 60_000 });
  const idle = (ago) => ({ lastSeen: now - ago });
  assert.equal(pcsLib.statusView(fast(1000), null, power("sleep", 2000)).phase, "sleeping");
  // A fast-polling PC that goes quiet for a few polls is asleep, not still going.
  assert.equal(pcsLib.statusView(fast(15_000), null, power("sleep", 16_000)).phase, "offline");
  assert.equal(pcsLib.statusView(fast(15_000), null, null).phase, "offline");
  assert.equal(pcsLib.statusView(idle(15_000), null, null).phase, "online");
  assert.equal(pcsLib.statusView(idle(60_000), null, null).phase, "offline");
  assert.equal(pcsLib.statusView(fast(15_000), { at: now }, power("sleep", 60_000)).phase, "waking");
  assert.equal(pcsLib.statusView(fast(15_000), null, power("reboot", 16_000)).phase, "restarting");
  assert.equal(pcsLib.statusView(fast(1000), null, power("reboot", 30_000)).phase, "online");
});

test("a command the agent doesn't pick up in time stays queued briefly, then is dropped", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const { token, pc } = await pairPc(admin);
  await agent("/api/agent/poll", token, {});
  const res = await sendCommand(admin, { pc, action: "reboot" }, { waitMs: 40, stepMs: 20 });
  assert.deepEqual(await res.json(), { ok: true, pending: true });

  // Pretend it was queued two minutes ago.
  const uid = (await admin.send("/api/session")).data.user.id;
  const live = await db.raw(["GET", `live:${uid}:${pc}`]);
  await db.raw(["SET", `live:${uid}:${pc}`, live.replace(/"at":\d+/, `"at":${Date.now() - 120_000}`)]);
  assert.deepEqual((await agent("/api/agent/poll", token, {})).data.commands, []);
});

test("commands are refused while the PC is offline, and unknown ones always", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const { pc } = await pairPc(admin);
  assert.equal((await admin.send("/api/command", { pc, action: "sleep" })).status, 409);
  assert.equal((await admin.send("/api/command", { pc, action: "format_c" })).status, 400);
});

test("wake sends a magic packet to the PC's own address and port", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const sock = dgram.createSocket("udp4");
  await new Promise((r) => sock.bind(0, "127.0.0.1", r));
  const got = new Promise((r) => sock.once("message", r));
  const { pc } = await pairPc(admin, { port: sock.address().port });
  const res = await admin.send("/api/command", { pc, action: "wake" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(await got, magicPacket(parseMAC("AA:BB:CC:DD:EE:FF")));
  sock.close();
  assert.equal((await admin.send(`/api/status?pc=${pc}`)).data.phase, "waking");

  const bare = await pairPc(admin, { mac: "", host: "" });
  assert.equal((await admin.send("/api/command", { pc: bare.pc, action: "wake" })).status, 409);
});

test("accounts can't see, wake, command or change each other's PCs", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const alice = await newUser(admin, "alice");
  const mallory = await newUser(admin, "mallory");
  const { token, pc } = await pairPc(alice);
  await agent("/api/agent/poll", token, {});

  assert.equal((await mallory.send(`/api/status?pc=${pc}`)).status, 404);
  assert.equal((await mallory.send("/api/command", { pc, action: "wake" })).status, 404);
  assert.equal((await mallory.send("/api/command", { pc, action: "reboot" })).status, 404);
  assert.equal((await mallory.send("/api/pcs", { action: "details", pc })).status, 404);
  assert.equal((await mallory.send("/api/pcs", { action: "update", pc, name: "pwned" })).status, 404);
  await mallory.send("/api/pcs", { action: "remove", pc });
  assert.deepEqual((await mallory.send("/api/session")).data.pcs, []);
  const mine = await alice.send("/api/session");
  assert.equal(mine.data.pcs[0].name, "Gaming PC");
  assert.equal((await alice.send(`/api/status?pc=${pc}`)).data.phase, "online");

  // A made-up token for alice's account finds nothing.
  const uid = mine.data.user.id;
  assert.equal((await agent("/api/agent/poll", `${uid}.${"x".repeat(43)}`, {})).status, 401);
  assert.equal((await agent("/api/agent/poll", "garbage", {})).status, 401);
  // Non-admins can't reach the admin page.
  assert.equal((await alice.send("/api/admin")).status, 403);
  assert.equal((await alice.send("/api/admin", { action: "invite_create" })).status, 403);
});

test("removing a PC locks its agent out", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const { token, pc } = await pairPc(admin);
  assert.equal((await agent("/api/agent/poll", token, {})).status, 200);
  await admin.send("/api/pcs", { action: "remove", pc });
  const res = await agent("/api/agent/poll", token, {});
  assert.equal(res.status, 401);
  assert.equal(res.data.code, "pc_removed");
  assert.equal((await admin.send(`/api/status?pc=${pc}`)).data.code, "pc_removed");
});

test("each account can have 3 PCs unless MAX_PCS_PER_USER says otherwise", async () => {
  await db.flush();
  const admin = await adminBrowser();
  for (let i = 0; i < 3; i++) await pairPc(admin);
  assert.equal((await admin.send("/api/pcs", { action: "add", name: "4th" })).status, 409);
  process.env.MAX_PCS_PER_USER = "4";
  try {
    // A code made before the limit was reached is checked again when used.
    const add = await admin.send("/api/pcs", { action: "add" });
    await pairPc(admin);
    assert.equal((await agent("/api/agent/pair", "", { code: add.data.code })).status, 409);
  } finally {
    delete process.env.MAX_PCS_PER_USER;
  }
});

test("wake details are checked and can be edited", async () => {
  await db.flush();
  const admin = await adminBrowser();
  assert.equal((await admin.send("/api/pcs", { action: "add", mac: "nope", host: "x.ddns.net" })).status, 400);
  assert.equal((await admin.send("/api/pcs", { action: "add", mac: "AABBCCDDEEFF", host: "bad host!" })).status, 400);
  assert.equal((await admin.send("/api/pcs", { action: "add", mac: "AABBCCDDEEFF", host: "x.ddns.net", port: 70000 })).status, 400);
  const { pc } = await pairPc(admin, { mac: "", host: "" });
  const upd = await admin.send("/api/pcs", { action: "update", pc, name: "Den", mac: "a1b2c3d4e5f6", host: "https://home.example.net/", port: 4009 });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const details = await admin.send("/api/pcs", { action: "details", pc });
  assert.deepEqual(details.data, { ok: true, name: "Den", mac: "A1:B2:C3:D4:E5:F6", host: "home.example.net", port: 4009 });
});

test("the admin resets, disables and deletes users", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const alice = await newUser(admin, "alice");
  const aliceId = (await alice.send("/api/session")).data.user.id;
  const { token } = await pairPc(alice);

  const reset = await admin.send("/api/admin", { action: "user_reset", user: aliceId });
  assert.equal((await alice.send("/api/session")).status, 401); // signed out everywhere
  const login = await alice.login("alice", reset.data.password);
  assert.equal(login.data.user.mustChange, true);
  assert.equal((await alice.send("/api/account", { action: "password", next: "my new password" })).status, 200);
  assert.equal((await alice.send("/api/session")).data.user.mustChange, false);

  await admin.send("/api/admin", { action: "user_disable", user: aliceId, disabled: true });
  assert.equal((await alice.send("/api/session")).status, 401);
  assert.equal((await alice.login("alice", "my new password")).status, 403);
  await admin.send("/api/admin", { action: "user_disable", user: aliceId, disabled: false });
  assert.equal((await alice.login("alice", "my new password")).status, 200);

  const list = await admin.send("/api/admin");
  assert.deepEqual(list.data.users.map((u) => [u.name, u.role, u.pcs]), [["boss", "admin", 0], ["alice", "user", 1]]);
  assert.equal(list.data.adminPasswordSet, true);
  assert.equal((await admin.send("/api/admin", { action: "user_delete", user: list.data.users[0].id })).status, 409);

  await admin.send("/api/admin", { action: "user_delete", user: aliceId });
  assert.equal((await alice.send("/api/session")).status, 401);
  assert.equal((await agent("/api/agent/poll", token, {})).status, 401);
  const left = (await db.raw(["KEYS", "*"])).filter((k) => k.includes(aliceId) || k === "uname:alice");
  assert.deepEqual(left, []);
});

test("changing the password signs out other devices; users can delete themselves", async () => {
  await db.flush();
  const admin = await adminBrowser();
  const phone = await newUser(admin, "dana");
  const laptop = new Browser();
  await laptop.login("dana", "a long enough password");
  assert.equal((await phone.send("/api/account", { action: "password", current: "wrong", next: "another long one" })).status, 403);
  assert.equal((await phone.send("/api/account", { action: "password", current: "a long enough password", next: "another long one" })).status, 200);
  assert.equal((await phone.send("/api/session")).status, 200);
  assert.equal((await laptop.send("/api/session")).status, 401);

  await phone.send("/api/account", { action: "logout_all" });
  assert.equal(phone.cookie, "");
  await phone.login("dana", "another long one");
  assert.equal((await phone.send("/api/account", { action: "delete", password: "nope" })).status, 403);
  assert.equal((await phone.send("/api/account", { action: "delete", password: "another long one" })).status, 200);
  assert.equal((await phone.login("dana", "another long one")).status, 401);
  assert.equal((await admin.send("/api/account", { action: "delete", password: ADMIN_PASSWORD })).status, 409);

  await admin.send("/api/session", { action: "logout" });
  assert.equal((await admin.send("/api/session")).status, 401);
});
