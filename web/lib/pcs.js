/**
 * PCs: pairing, status, wake, commands and the agent's polling.
 *
 * Every key is scoped to the owner's uid and the PC's id, which is the
 * SHA-256 of the agent's secret. The agent's token is "<uid>.<secret>", so
 * the server can name the agent's keys straight from the token, and a
 * request for another user's PC simply finds no key.
 *
 *   pcs:{uid}             set of the user's PC ids
 *   pc:{uid}:{pc}         hash: name, hostname, mac and host (encrypted), port, created
 *   live:{uid}:{pc}       what the agent last reported, then one line per signal
 *                         for it ("viewer", or "cmd {json}") appended by the app
 *   woke:{uid}:{pc}       when a wake packet was last sent (3 minutes)
 *   power:{uid}:{pc}      a sleep or restart that just succeeded (10 minutes)
 *   res:{uid}:{pc}:{id}   the agent's answer to one command (60 seconds)
 *   pair:{sha256(code)}   a pairing code waiting for the agent (10 minutes)
 *
 * Upstash bills per command, and the agent polls all day, so a poll is a
 * single command: SET live ... XX GET. XX makes it fail for a removed PC (so
 * it also checks the token), and GET hands back the signals the app appended
 * since the last poll, which the same write clears. A status check from the
 * app is two commands in one round trip.
 */

import crypto from "node:crypto";
import { pipeline, command, hash } from "./redis.js";
import { HttpError, json, body, parse, str } from "./http.js";
import { randomId, sha256, humanCode, normalizeCode, seal, unseal, hasDataKey } from "./secrets.js";
import { requireUser, sessionParts, maxPcs } from "./accounts.js";
import { parseMAC, sendMagicPacket } from "./wol.js";

export const ACTIONS = ["launch_steam", "sleep", "reboot"];

export const POLL_IDLE_S = 60;
export const POLL_FAST_S = 2;
const FAST_FOR_MS = 90_000; // fast polling lasts this long after the app last asked
const REFRESH_FAST_MS = 30_000; // ask again when less than this is left
const STALE_AFTER_MS = 80_000; // one missed idle poll and a bit
const COMMAND_TTL_MS = 90_000; // a command not picked up by then is dropped, never run late
const COMMAND_WAIT_MS = 25_000;
const POWER_TTL_S = 600;
const POWER_SETTLE_MS = 20_000; // a poll this long after sleep/restart means it's back
const WAKE_TTL_S = 180;
const PAIR_TTL_S = 600;
const PC_RE = /^[A-Za-z0-9_-]{43}$/;

export const PAIR_PREFIX = "homeydeck-pair:"; // keep in step with pairPrefix in agent/main.go

const keysFor = (uid, pc) => ({
  meta: `pc:${uid}:${pc}`,
  live: `live:${uid}:${pc}`,
  woke: `woke:${uid}:${pc}`,
  power: `power:${uid}:${pc}`,
});

/** Commands that delete everything about one PC. */
export function deletePcKeys(uid, pc) {
  const k = keysFor(uid, pc);
  return [["DEL", k.meta, k.live, k.woke, k.power], ["SREM", `pcs:${uid}`, pc]];
}

function pcId(value) {
  const pc = String(value ?? "");
  if (!PC_RE.test(pc)) throw new HttpError(400, "unknown PC");
  return pc;
}

// --- wake details ------------------------------------------------------------

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$/;

/** Checks the MAC, address and port the user typed. All three blank is fine. */
function wakeFields(data, env) {
  const macText = str(data.mac, 40);
  const host = str(data.host, 253).replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
  const port = data.port === undefined || data.port === "" ? 9 : Number(data.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "the port must be a number from 1 to 65535");
  if (!macText && !host) return { mac: "", host: "", port };
  const mac = parseMAC(macText);
  if (!mac) throw new HttpError(400, "the MAC address should look like AA:BB:CC:DD:EE:FF");
  if (!HOST_RE.test(host)) throw new HttpError(400, "the address should be a DDNS name like myhome.ddns.net, or an IP address");
  if (!hasDataKey(env)) throw new HttpError(500, "the server's DATA_KEY isn't set, so wake details can't be saved yet");
  const pretty = mac.toString("hex").toUpperCase().match(/../g).join(":");
  return { mac: seal(pretty, env), host: seal(host, env), port };
}

function cleanName(value) {
  return str(value, 40).replace(/[\u0000-\u001f]/g, "");
}

// --- the app's PC routes (POST /api/pcs) -------------------------------------

export async function pcsPost(request, env) {
  const { uid } = await requireUser(request, env);
  const data = await body(request);

  if (data.action === "add") {
    // Pairing creates the PC; this only parks what the user typed with a code.
    const count = await command(["SCARD", `pcs:${uid}`], env);
    if (count >= maxPcs(env)) throw new HttpError(409, `an account can have up to ${maxPcs(env)} PCs; remove one first`);
    const wake = wakeFields(data, env);
    const code = humanCode();
    const pending = { uid, name: cleanName(data.name), ...wake };
    await command(["SET", `pair:${sha256(normalizeCode(code))}`, JSON.stringify(pending), "EX", PAIR_TTL_S], env);
    const host = new URL(request.url).host;
    return json({ ok: true, code, text: `${PAIR_PREFIX}${host}/${code}`, expiresIn: PAIR_TTL_S });
  }

  if (data.action === "pair_status") {
    // Still waiting while the code exists; it's deleted the moment the agent uses it.
    const waiting = await command(["EXISTS", `pair:${sha256(normalizeCode(data.code))}`], env);
    return json({ ok: true, waiting: waiting === 1 });
  }

  const pc = pcId(data.pc);
  const k = keysFor(uid, pc);

  if (data.action === "update") {
    if ((await command(["EXISTS", k.meta], env)) !== 1) throw new HttpError(404, "that PC was removed");
    const fields = { name: cleanName(data.name) };
    if (data.mac !== undefined || data.host !== undefined || data.port !== undefined) Object.assign(fields, wakeFields(data, env));
    await command(["HSET", k.meta, ...Object.entries(fields).flat()], env);
    return json({ ok: true });
  }

  if (data.action === "details") {
    // The decrypted wake details, only when the user opens a PC's settings.
    const meta = hash(await command(["HGETALL", k.meta], env));
    if (!meta) throw new HttpError(404, "that PC was removed");
    return json({ ok: true, name: meta.name ?? "", mac: unseal(meta.mac, env), host: unseal(meta.host, env), port: Number(meta.port) || 9 });
  }

  if (data.action === "remove") {
    // The agent's next poll fails, and it removes itself from the PC.
    await pipeline(deletePcKeys(uid, pc), env);
    return json({ ok: true });
  }

  throw new HttpError(400, "unknown action");
}

// --- status (GET /api/status?pc=…&watch=1) -----------------------------------

/** Splits a live value into the agent's report and the app's pending signals. */
function readLive(raw) {
  const [first = "", ...lines] = String(raw ?? "").split("\n");
  const report = parse(first) ?? {};
  const commands = [];
  let viewer = false;
  for (const line of lines) {
    if (line === "viewer") viewer = true;
    else if (line.startsWith("cmd ")) {
      const cmd = parse(line.slice(4));
      if (cmd?.id && ACTIONS.includes(cmd.action)) commands.push(cmd);
    }
  }
  return { report, commands, viewer };
}

/** The session check and the PC's state in one round trip (2 commands). */
async function loadPc(request, env, pc) {
  const { uid, key } = sessionParts(request);
  const k = keysFor(uid, pc);
  const [owner, [live, woke, power]] = await pipeline([["GET", key], ["MGET", k.live, k.woke, k.power]], env);
  if (owner !== uid) throw new HttpError(401, "please sign in", "signed_out");
  if (live === null) throw new HttpError(404, "that PC was removed from your account", "pc_removed");
  return { uid, k, live: readLive(live), woke: parse(woke), power: parse(power) };
}

export async function status(request, env) {
  const url = new URL(request.url);
  const pc = pcId(url.searchParams.get("pc"));
  const { k, live, woke, power } = await loadPc(request, env, pc);

  // While the app is being watched, ask the agent to poll fast, unless it
  // already is or has a request waiting. Usually costs nothing.
  const now = Date.now();
  if (url.searchParams.get("watch") === "1" && !live.viewer && !(live.report.fastUntil > now + REFRESH_FAST_MS)) {
    await command(["APPEND", k.live, "\nviewer"], env);
  }
  return json(statusView(live.report, woke, power));
}

function isFresh(s) {
  return Boolean(s?.lastSeen) && Date.now() - s.lastSeen < STALE_AFTER_MS;
}

/**
 * phase is what the app shows: online, offline, waking (a wake packet went
 * out recently), sleeping or restarting (the PC confirmed the command).
 */
export function statusView(s, woke, power) {
  const fresh = isFresh(s);
  const back = power && s?.lastSeen > power.at + POWER_SETTLE_MS;
  let phase = fresh ? "online" : "offline";
  if (power && !back) phase = power.action === "sleep" ? "sleeping" : "restarting";
  else if (!fresh && woke) phase = "waking";
  const online = phase === "online";
  return {
    phase,
    online,
    steamRunning: online ? Boolean(s.steamRunning) : false,
    hostname: s?.hostname || null,
    uptimeSeconds: online ? s.uptimeSeconds : null,
    agentVersion: s?.agentVersion || null,
    lastSeen: s?.lastSeen ? new Date(s.lastSeen).toISOString() : null,
  };
}

// --- wake and commands (POST /api/command {pc, action}) ----------------------

export async function sendCommand(request, env, { waitMs = COMMAND_WAIT_MS, stepMs = 1000 } = {}) {
  const data = await body(request);
  const pc = pcId(data.pc);
  if (data.action === "wake") return wake(request, env, pc);
  const action = data.action;
  if (!ACTIONS.includes(action)) throw new HttpError(400, `action must be one of: wake, ${ACTIONS.join(", ")}`);

  const { uid, k, live } = await loadPc(request, env, pc);
  if (!isFresh(live.report)) throw new HttpError(409, "the PC is offline");

  // The agent picks this up at its next poll, and a command implies fast polling.
  const id = crypto.randomUUID();
  await command(["APPEND", k.live, `\ncmd ${JSON.stringify({ id, action, at: Date.now() })}\nviewer`], env);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(stepMs);
    const result = parse(await command(["GET", `res:${uid}:${pc}:${id}`], env));
    if (!result) continue;
    if (result.ok && (action === "sleep" || action === "reboot")) {
      await command(["SET", k.power, JSON.stringify({ action, at: Date.now() }), "EX", POWER_TTL_S], env);
    }
    return json({ ok: result.ok, error: result.error }, result.ok ? 200 : 502);
  }
  // The agent was polling slowly. It still gets the command at its next
  // poll, which is within the command's 90 seconds.
  return json({ ok: true, pending: true });
}

async function wake(request, env, pc) {
  const { uid, key } = sessionParts(request);
  const k = keysFor(uid, pc);
  const [owner, flat] = await pipeline([["GET", key], ["HGETALL", k.meta]], env);
  if (owner !== uid) throw new HttpError(401, "please sign in", "signed_out");
  const meta = hash(flat);
  if (!meta) throw new HttpError(404, "that PC was removed from your account", "pc_removed");

  const mac = parseMAC(unseal(meta.mac, env));
  const host = unseal(meta.host, env);
  if (!mac || !host) throw new HttpError(409, "add this PC's MAC address and DDNS name in its settings first");
  try {
    await sendMagicPacket({ mac, host, port: Number(meta.port) || 9 });
  } catch (err) {
    throw new HttpError(502, `couldn't send the wake packet: ${err.code === "ENOTFOUND" ? `${host} doesn't resolve` : err.message}`);
  }
  await command(["SET", k.woke, JSON.stringify({ at: Date.now() }), "EX", WAKE_TTL_S], env);
  return json({ ok: true });
}

// --- the agent (bearer token "<uid>.<secret>") -------------------------------

function agentKeys(request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const [uid, secret, extra] = token.split(".");
  if (extra !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(uid ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) {
    throw new HttpError(401, "this PC isn't paired with HomeyDeck", "not_paired");
  }
  const pc = sha256(secret);
  return { uid, pc, ...keysFor(uid, pc) };
}

/** POST /api/agent/pair {code, hostname}: turns a pairing code into an agent token. */
export async function agentPair(request, env) {
  const data = await body(request);
  const code = normalizeCode(data.code);
  if (!code) throw new HttpError(400, "the pairing code is missing");
  const pending = parse(await command(["GETDEL", `pair:${sha256(code)}`], env));
  if (!pending?.uid) throw new HttpError(404, "that pairing code is wrong, used or expired. Make a new one in HomeyDeck → Add PC", "bad_code");

  const { uid } = pending;
  const [count, flat] = await pipeline([["SCARD", `pcs:${uid}`], ["HMGET", `u:${uid}`, "name", "disabled"]], env);
  if (!flat?.[0] || flat[1] === "1") throw new HttpError(403, "that account no longer exists or is disabled");
  if (count >= maxPcs(env)) throw new HttpError(409, `that account already has ${count} PCs, the most allowed`);

  const secret = randomId(32);
  const pc = sha256(secret);
  const k = keysFor(uid, pc);
  const hostname = cleanName(data.hostname);
  const name = pending.name || hostname || "My PC";
  const report = { hostname, lastSeen: 0 };
  await pipeline(
    [
      ["HSET", k.meta, "name", name, "hostname", hostname, "mac", pending.mac ?? "", "host", pending.host ?? "", "port", pending.port ?? 9, "created", Date.now()],
      ["SADD", `pcs:${uid}`, pc],
      ["SET", k.live, JSON.stringify(report)],
    ],
    env,
  );
  return json({ ok: true, token: `${uid}.${secret}`, name });
}

/** POST /api/agent/poll: stores the status and hands out commands. One command. */
export async function agentPoll(request, env) {
  const { live } = agentKeys(request);
  const data = (await request.json().catch(() => null)) ?? {};
  const now = Date.now();
  const fastUntil = Math.min(Number(data.fastUntil) || 0, now + FAST_FOR_MS);
  const report = {
    hostname: str(data.hostname, 64),
    steamRunning: Boolean(data.steamRunning),
    uptimeSeconds: Math.max(0, Math.floor(Number(data.uptimeSeconds) || 0)),
    agentVersion: str(data.agentVersion, 32),
    lastSeen: now,
    fastUntil: fastUntil > now ? fastUntil : undefined,
  };

  const previous = await command(["SET", live, JSON.stringify(report), "XX", "GET"], env);
  if (previous === null) throw new HttpError(401, "this PC was removed from its HomeyDeck account", "pc_removed");

  const { commands, viewer } = readLive(previous);
  const fresh = commands.filter((c) => now - c.at < COMMAND_TTL_MS).map(({ id, action }) => ({ id, action }));
  const until = viewer || fresh.length ? now + FAST_FOR_MS : fastUntil;
  return json({ commands: fresh, pollSeconds: until > now ? POLL_FAST_S : POLL_IDLE_S, fastUntil: until > now ? until : 0 });
}

/** POST /api/agent/result {id, action, ok, error}. One command. */
export async function agentResult(request, env) {
  const { uid, pc } = agentKeys(request);
  const data = await body(request);
  const id = String(data.id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "invalid id");
  const ok = Boolean(data.ok);
  const result = { ok, error: ok ? undefined : str(data.error ?? "failed", 200) };
  await command(["SET", `res:${uid}:${pc}:${id}`, JSON.stringify(result), "EX", 60], env);
  return json({ ok: true });
}

// --- health (GET /api/health) ------------------------------------------------

/** What's configured, never the values themselves. */
export function health(env) {
  return {
    ok: true,
    database: Boolean((env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL) && (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN)),
    dataKey: hasDataKey(env),
    admin: Boolean(env.ADMIN_USERNAME),
    adminPasswordSet: Boolean(env.ADMIN_PASSWORD),
    maxPcs: Number.isFinite(maxPcs(env)) ? maxPcs(env) : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
