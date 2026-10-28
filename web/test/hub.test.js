import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import * as hub from "../lib/hub.js";
import { magicPacket, parseMAC } from "../lib/wol.js";
import { startFakeUpstash } from "../scripts/fake-upstash.js";

let fake;
const env = {
  APP_KEY: "a".repeat(40),
  AGENT_KEY: "b".repeat(40),
  WOL_MAC: "AA:BB:CC:DD:EE:FF",
  WOL_HOST: "127.0.0.1",
};

before(async () => {
  fake = await startFakeUpstash("token");
  env.KV_REST_API_URL = fake.url;
  env.KV_REST_API_TOKEN = fake.token;
});
after(() => fake.close());
const store = { clear: () => fake.store.clear(), delete: (k) => fake.store.delete(k), has: (k) => fake.store.has(k) };

const req = (path, key, body) =>
  new Request(`https://x${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: key ? { Authorization: `Bearer ${key}`, "x-forwarded-for": "1.2.3.4" } : { "x-forwarded-for": "5.6.7.8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const app = (path, body) => req(path, env.APP_KEY, body);
const agent = (path, body) => req(path, env.AGENT_KEY, body);

test("health reports what is configured", async () => {
  const res = await (await hub.health(req("/api/health"), env)).json();
  assert.deepEqual(res, { ok: true, poll: true, keys: true, database: true, wake: true });
});

test("status is offline until the agent polls, then online", async () => {
  store.clear();
  let s = await (await hub.status(app("/api/status"), env)).json();
  assert.equal(s.phase, "offline");

  const poll = await (await hub.agentPoll(agent("/api/agent/poll", { hostname: "PC", steamRunning: true, uptimeSeconds: 99, agentVersion: "1" }), env)).json();
  assert.deepEqual(poll, { command: null, pollSeconds: hub.POLL_FAST_S }); // the app just looked

  s = await (await hub.status(app("/api/status"), env)).json();
  assert.equal(s.phase, "online");
  assert.equal(s.steamRunning, true);
  assert.equal(s.hostname, "PC");
});

test("agent polls slowly when nobody is looking", async () => {
  store.delete("hd:viewer");
  const poll = await (await hub.agentPoll(agent("/api/agent/poll", {}), env)).json();
  assert.equal(poll.pollSeconds, hub.POLL_IDLE_S);
});

test("a command reaches the agent once and its answer comes back", async () => {
  const pending = hub.sendCommand(app("/api/command", { action: "sleep" }), env, { waitMs: 3000, stepMs: 20 });
  await new Promise((r) => setTimeout(r, 50));
  const poll = await (await hub.agentPoll(agent("/api/agent/poll", { hostname: "PC" }), env)).json();
  assert.equal(poll.command.action, "sleep");
  const again = await (await hub.agentPoll(agent("/api/agent/poll", { hostname: "PC" }), env)).json();
  assert.equal(again.command, null);

  await hub.agentResult(agent("/api/agent/result", { id: poll.command.id, action: "sleep", ok: true }), env);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const s = await (await hub.status(app("/api/status"), env)).json();
  assert.equal(s.phase, "sleeping");
});

test("a command nobody picks up is taken back", async () => {
  store.delete("hd:power");
  const res = await hub.sendCommand(app("/api/command", { action: "reboot" }), env, { waitMs: 60, stepMs: 20 });
  assert.equal(res.status, 504);
  assert.equal(store.has("hd:cmd"), false);
});

test("commands are refused while the PC is offline, and unknown ones always", async () => {
  store.clear();
  assert.equal((await hub.sendCommand(app("/api/command", { action: "sleep" }), env)).status, 409);
  assert.equal((await hub.sendCommand(app("/api/command", { action: "format_c" }), env)).status, 400);
});

test("wake sends a magic packet to the configured host and port", async () => {
  const sock = dgram.createSocket("udp4");
  await new Promise((r) => sock.bind(0, "127.0.0.1", r));
  const got = new Promise((r) => sock.once("message", r));
  const res = await hub.wake(app("/api/wake", {}), { ...env, WOL_PORT: String(sock.address().port) });
  assert.equal(res.status, 200);
  assert.deepEqual(await got, magicPacket(parseMAC(env.WOL_MAC)));
  sock.close();
  const s = await (await hub.status(app("/api/status"), env)).json();
  assert.equal(s.phase, "waking");
});

test("wrong keys are rejected, and repeated failures lock the address out", async () => {
  assert.equal((await hub.status(req("/api/status"), env)).status, 401);
  assert.equal((await hub.agentPoll(app("/api/agent/poll", {}), env)).status, 401); // app key can't act as agent
  for (let i = 0; i < 10; i++) await hub.status(req("/api/status"), env);
  assert.equal((await hub.status(req("/api/status"), env)).status, 429);
});

test("setup code carries the server address and agent key, for app key holders only", async () => {
  assert.ok([401, 429].includes((await hub.setup(req("/api/setup"), env)).status));
  const { code } = await (await hub.setup(app("/api/setup"), env)).json();
  assert.ok(code.startsWith(hub.SETUP_PREFIX));
  const decoded = JSON.parse(Buffer.from(code.slice(hub.SETUP_PREFIX.length), "base64url").toString());
  assert.deepEqual(decoded, { server: "https://x", key: env.AGENT_KEY });
});

test("missing configuration is explained", async () => {
  const res = await hub.status(app("/api/status"), { APP_KEY: env.APP_KEY });
  assert.equal(res.status, 500);
});
