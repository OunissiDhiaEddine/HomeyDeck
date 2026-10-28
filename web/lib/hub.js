/**
 * HomeyDeck relay on Vercel.
 *
 * Vercel functions can't hold the agent's WebSocket, so the Windows agent
 * polls /api/agent/poll instead: slowly (every 20 s) while nobody is looking,
 * and every 2 s for a while after the app has asked for the status. State
 * lives in a small Upstash Redis database:
 *
 *   hd:status   last report from the agent (+ lastSeen)
 *   hd:cmd      the one pending command, which expires if nobody picks it up
 *   hd:result:* the agent's answer to a command
 *   hd:viewer   set while the app is open, tells the agent to poll fast
 *   hd:power    a sleep/restart that just succeeded, so the app can say so
 *   hd:wokeAt   when the app last sent a wake packet
 *   hd:fail:*   failed key attempts per IP address
 *
 * Unlike the Cloudflare Worker, this server sends the Wake-on-LAN packet
 * itself, so the PWA only needs HTTPS.
 */

import crypto from "node:crypto";
import { pipeline, command, redisConfig, RedisError } from "./redis.js";
import { parseMAC, sendMagicPacket } from "./wol.js";

export const ACTIONS = ["launch_steam", "sleep", "reboot"];

export const POLL_IDLE_S = 20;
export const POLL_FAST_S = 2;
const VIEWER_TTL_S = 90; // fast polling lasts this long after the app last asked
const STALE_AFTER_MS = 70_000; // two missed idle polls and a bit
const COMMAND_TTL_S = 40; // a command nobody picked up is dropped, never run late
const COMMAND_WAIT_MS = 25_000;
const POWER_TTL_S = 600;
const POWER_SETTLE_MS = 20_000; // a poll this long after sleep/restart means it's back
const WAKE_TTL_S = 180;
const MAX_FAILED_AUTH = 10;
const FAILED_AUTH_WINDOW_S = 15 * 60;

// --- configuration -----------------------------------------------------------

function keys(env) {
  const app = env.APP_KEY ?? "";
  const agent = env.AGENT_KEY ?? "";
  return app.length >= 32 && agent.length >= 32 && app !== agent ? { app, agent } : null;
}

function wakeTarget(env) {
  const mac = parseMAC(env.WOL_MAC ?? "");
  const host = (env.WOL_HOST ?? "").trim();
  const port = Number(env.WOL_PORT || 9);
  if (!mac || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { mac, host, port };
}

// --- handlers ----------------------------------------------------------------

/** GET /api/health: what's configured, never the values themselves. */
export async function health(_request, env = process.env) {
  return json({
    ok: true,
    poll: true, // tells the agent to poll instead of opening a WebSocket
    keys: keys(env) !== null,
    database: redisConfig(env) !== null,
    wake: wakeTarget(env) !== null,
  });
}

/** GET /api/status (app key) */
export async function status(request, env = process.env) {
  return guarded(request, env, "app", async () => {
    const [[rawStatus, rawWoke, rawPower]] = await pipeline(
      [
        ["MGET", "hd:status", "hd:wokeAt", "hd:power"],
        ["SET", "hd:viewer", "1", "EX", VIEWER_TTL_S],
      ],
      env,
    );
    return json(statusView(parse(rawStatus), parse(rawWoke), parse(rawPower)));
  });
}

/** POST /api/wake (app key): sends the magic packet to the router. */
export async function wake(request, env = process.env) {
  return guarded(request, env, "app", async () => {
    const target = wakeTarget(env);
    if (!target) return json({ ok: false, error: "wake isn't set up: add WOL_MAC, WOL_HOST and WOL_PORT in Vercel" }, 500);
    try {
      await sendMagicPacket(target);
    } catch (err) {
      return json({ ok: false, error: `couldn't send the wake packet: ${err.message}` }, 502);
    }
    await command(["SET", "hd:wokeAt", JSON.stringify({ at: Date.now() }), "EX", WAKE_TTL_S], env);
    return json({ ok: true });
  });
}

/** POST /api/command {action} (app key): queues it and waits for the agent's answer. */
export async function sendCommand(request, env = process.env, { waitMs = COMMAND_WAIT_MS, stepMs = 1000 } = {}) {
  return guarded(request, env, "app", async () => {
    const body = await request.json().catch(() => null);
    const action = body?.action;
    if (!ACTIONS.includes(action)) return json({ ok: false, error: `action must be one of: ${ACTIONS.join(", ")}` }, 400);

    const current = parse(await command(["GET", "hd:status"], env));
    if (!isFresh(current)) return json({ ok: false, error: "the PC is offline" }, 409);

    const id = crypto.randomUUID();
    await pipeline(
      [
        ["SET", "hd:cmd", JSON.stringify({ id, action, at: Date.now() }), "EX", COMMAND_TTL_S],
        // Make sure the agent is in fast mode, even if the app skipped /status.
        ["SET", "hd:viewer", "1", "EX", VIEWER_TTL_S],
      ],
      env,
    );

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(stepMs);
      const result = parse(await command(["GET", `hd:result:${id}`], env));
      if (result) return json({ ok: result.ok, error: result.error }, result.ok ? 200 : 502);
    }

    // Still queued means the agent never came for it: take it back so it
    // can't run minutes later. Gone means the agent has it and is working.
    const left = parse(await command(["GETDEL", "hd:cmd"], env));
    if (left?.id === id) return json({ ok: false, error: "the PC didn't answer in time" }, 504);
    return json({ ok: true, pending: true });
  });
}

/**
 * GET /api/setup (app key): a code holding this server's address and the
 * agent key. The agent reads it from the clipboard when double-clicked, so
 * the PC is set up without a terminal or typing the key.
 */
export async function setup(request, env = process.env) {
  return guarded(request, env, "app", async () => {
    const server = new URL(request.url).origin;
    const payload = Buffer.from(JSON.stringify({ server, key: keys(env).agent })).toString("base64url");
    return json({ code: `${SETUP_PREFIX}${payload}` });
  });
}

export const SETUP_PREFIX = "homeydeck-setup:";

/** POST /api/agent/poll (agent key): stores the status and hands out a command. */
export async function agentPoll(request, env = process.env) {
  return guarded(request, env, "agent", async () => {
    const body = (await request.json().catch(() => null)) ?? {};
    const now = Date.now();
    const report = {
      hostname: String(body.hostname ?? "").slice(0, 64),
      steamRunning: Boolean(body.steamRunning),
      uptimeSeconds: Math.max(0, Math.floor(Number(body.uptimeSeconds) || 0)),
      agentVersion: String(body.agentVersion ?? "").slice(0, 32),
      lastSeen: now,
    };

    // GETDEL hands each command out exactly once.
    const [, rawCmd, [viewer, rawPower]] = await pipeline(
      [
        ["SET", "hd:status", JSON.stringify(report), "EX", 24 * 3600],
        ["GETDEL", "hd:cmd"],
        ["MGET", "hd:viewer", "hd:power"],
      ],
      env,
    );

    const cmd = parse(rawCmd);
    const power = parse(rawPower);
    if (power && now - power.at > POWER_SETTLE_MS) await command(["DEL", "hd:power"], env);

    return json({
      command: cmd ? { id: cmd.id, action: cmd.action } : null,
      pollSeconds: viewer ? POLL_FAST_S : POLL_IDLE_S,
    });
  });
}

/** POST /api/agent/result {id, action, ok, error} (agent key) */
export async function agentResult(request, env = process.env) {
  return guarded(request, env, "agent", async () => {
    const body = await request.json().catch(() => null);
    const id = String(body?.id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "invalid id" }, 400);
    const ok = Boolean(body.ok);
    const writes = [
      ["SET", `hd:result:${id}`, JSON.stringify({ ok, error: ok ? undefined : String(body.error ?? "failed").slice(0, 200) }), "EX", 60],
    ];
    if (ok && (body.action === "sleep" || body.action === "reboot")) {
      writes.push(["SET", "hd:power", JSON.stringify({ action: body.action, at: Date.now() }), "EX", POWER_TTL_S]);
    }
    await pipeline(writes, env);
    return json({ ok: true });
  });
}

// --- status ------------------------------------------------------------------

function isFresh(s) {
  return Boolean(s?.lastSeen) && Date.now() - s.lastSeen < STALE_AFTER_MS;
}

/**
 * phase is what the app shows: online, offline, waking (a wake packet went
 * out recently), sleeping or restarting (the PC confirmed the command).
 */
export function statusView(s, woke, power) {
  const fresh = isFresh(s);
  let phase = fresh ? "online" : "offline";
  if (power) phase = power.action === "sleep" ? "sleeping" : "restarting";
  else if (!fresh && woke) phase = "waking";
  const online = phase === "online";
  return {
    phase,
    online,
    steamRunning: online ? s.steamRunning : false,
    hostname: s?.hostname || null,
    uptimeSeconds: online ? s.uptimeSeconds : null,
    agentVersion: s?.agentVersion || null,
    lastSeen: s?.lastSeen ? new Date(s.lastSeen).toISOString() : null,
  };
}

// --- auth --------------------------------------------------------------------

async function guarded(request, env, who, handler) {
  const k = keys(env);
  if (!k) return json({ error: "server keys are not configured (APP_KEY and AGENT_KEY, 32+ characters, different)" }, 500);
  if (!redisConfig(env)) return json({ error: "the database is not connected (add Upstash Redis in Vercel → Storage)" }, 500);

  try {
    const header = request.headers.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(given, who === "app" ? k.app : k.agent)) {
      // Only failures touch the database, so normal use costs nothing extra.
      const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
      const [count] = await pipeline(
        [
          ["INCR", `hd:fail:${ip}`],
          ["EXPIRE", `hd:fail:${ip}`, FAILED_AUTH_WINDOW_S, "NX"],
        ],
        env,
      );
      if (count > MAX_FAILED_AUTH) return json({ error: "too many failed attempts, try again later" }, 429);
      return json({ error: "unauthorized" }, 401);
    }
    return await handler();
  } catch (err) {
    if (err instanceof RedisError) return json({ error: `database problem: ${err.message}` }, 503);
    throw err;
  }
}

// Compares SHA-256 digests so neither length nor content leaks through timing.
function safeEqual(a, b) {
  const da = crypto.createHash("sha256").update(a).digest();
  const db = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

// --- helpers -----------------------------------------------------------------

function parse(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
