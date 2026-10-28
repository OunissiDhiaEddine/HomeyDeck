/**
 * HomeyDeck relay.
 *
 * The Windows agent keeps one outbound WebSocket open to /agent/connect.
 * The Apple app calls /api/status and /api/command over HTTPS.
 * A single Durable Object ("hub") owns the socket, the last reported status
 * and the failed-auth counters, so everything stays consistent.
 *
 * Waking the PC is not handled here: the app sends the magic packet itself,
 * straight to the router's DDNS address.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  APP_KEY: string;
  AGENT_KEY: string;
}

type Action = "launch_steam" | "sleep" | "reboot";
const ACTIONS: readonly Action[] = ["launch_steam", "sleep", "reboot"];

interface AgentStatus {
  hostname: string;
  steamRunning: boolean;
  uptimeSeconds: number;
  agentVersion: string;
}

interface StoredState {
  status: AgentStatus | null;
  lastSeen: number | null; // epoch ms of the last message from the agent
  connectedAt: number | null;
}

type AgentMessage =
  | ({ type: "status" } & AgentStatus)
  | { type: "result"; id: string; ok: boolean; error?: string };

// The agent reports every 20 s; three missed reports means the PC is gone
// (sleep often drops the socket without a clean close).
const STALE_AFTER_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_FAILED_AUTH = 10;
const FAILED_AUTH_WINDOW_MS = 15 * 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    if (!env.APP_KEY || !env.AGENT_KEY || env.APP_KEY.length < 32 || env.AGENT_KEY.length < 32) {
      return json({ error: "server keys are not configured" }, 500);
    }

    const known = ["/agent/connect", "/api/status", "/api/command"];
    if (!known.includes(url.pathname)) return json({ error: "not found" }, 404);

    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    return hub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Hub extends DurableObject<Env> {
  private pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    if (await this.isLockedOut(ip)) {
      return json({ error: "too many failed attempts, try again later" }, 429);
    }

    if (url.pathname === "/agent/connect") {
      if (!(await this.authorized(request, this.env.AGENT_KEY, ip))) return unauthorized();
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "expected a WebSocket upgrade" }, 426);
      }
      return this.acceptAgent();
    }

    if (!(await this.authorized(request, this.env.APP_KEY, ip))) return unauthorized();

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json(await this.statusView());
    }

    if (url.pathname === "/api/command" && request.method === "POST") {
      let body: { action?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const action = body.action as Action;
      if (!ACTIONS.includes(action)) {
        return json({ error: `action must be one of: ${ACTIONS.join(", ")}` }, 400);
      }
      return this.sendCommand(action);
    }

    return json({ error: "method not allowed" }, 405);
  }

  // --- agent socket -------------------------------------------------------

  private async acceptAgent(): Promise<Response> {
    // Only one agent at a time: a new connection replaces any old one.
    for (const old of this.ctx.getWebSockets()) old.close(4000, "replaced by a newer connection");

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
    await this.patchState({ connectedAt: now, lastSeen: now });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 4096) return;
    let msg: AgentMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "status") {
      const status: AgentStatus = {
        hostname: String(msg.hostname ?? "").slice(0, 64),
        steamRunning: Boolean(msg.steamRunning),
        uptimeSeconds: Number(msg.uptimeSeconds) || 0,
        agentVersion: String(msg.agentVersion ?? "").slice(0, 32),
      };
      await this.patchState({ status, lastSeen: Date.now() });
    } else if (msg.type === "result") {
      await this.patchState({ lastSeen: Date.now() });
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve({ ok: Boolean(msg.ok), error: msg.error ? String(msg.error).slice(0, 200) : undefined });
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length === 0) {
      await this.patchState({ connectedAt: null });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private liveSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets();
    return sockets.length > 0 ? sockets[sockets.length - 1] : null;
  }

  private async sendCommand(action: Action): Promise<Response> {
    const ws = this.liveSocket();
    const state = await this.state();
    if (!ws || !this.isFresh(state)) {
      return json({ ok: false, error: "the PC is offline" }, 409);
    }

    const id = crypto.randomUUID();
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "the PC did not answer in time" });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      try {
        ws.send(JSON.stringify({ type: "command", id, action }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "the connection to the PC dropped" });
      }
    });

    return json(result, result.ok ? 200 : 502);
  }

  // --- status -------------------------------------------------------------

  private isFresh(state: StoredState): boolean {
    return state.lastSeen !== null && Date.now() - state.lastSeen < STALE_AFTER_MS;
  }

  private async statusView() {
    const state = await this.state();
    const online = this.liveSocket() !== null && this.isFresh(state);
    return {
      online,
      steamRunning: online ? (state.status?.steamRunning ?? false) : false,
      hostname: state.status?.hostname ?? null,
      uptimeSeconds: online ? (state.status?.uptimeSeconds ?? null) : null,
      agentVersion: state.status?.agentVersion ?? null,
      lastSeen: state.lastSeen ? new Date(state.lastSeen).toISOString() : null,
    };
  }

  private async state(): Promise<StoredState> {
    return (
      (await this.ctx.storage.get<StoredState>("state")) ?? { status: null, lastSeen: null, connectedAt: null }
    );
  }

  private async patchState(patch: Partial<StoredState>): Promise<void> {
    await this.ctx.storage.put("state", { ...(await this.state()), ...patch });
  }

  // --- auth ---------------------------------------------------------------

  private async authorized(request: Request, expected: string, ip: string): Promise<boolean> {
    const header = request.headers.get("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (await timingSafeEqual(given, expected)) return true;
    await this.recordFailure(ip);
    return false;
  }

  private async isLockedOut(ip: string): Promise<boolean> {
    const entry = await this.ctx.storage.get<{ count: number; since: number }>(`fail:${ip}`);
    if (!entry) return false;
    if (Date.now() - entry.since > FAILED_AUTH_WINDOW_MS) {
      await this.ctx.storage.delete(`fail:${ip}`);
      return false;
    }
    return entry.count >= MAX_FAILED_AUTH;
  }

  private async recordFailure(ip: string): Promise<void> {
    const key = `fail:${ip}`;
    const entry = await this.ctx.storage.get<{ count: number; since: number }>(key);
    const fresh = entry && Date.now() - entry.since <= FAILED_AUTH_WINDOW_MS;
    await this.ctx.storage.put(key, fresh ? { ...entry, count: entry.count + 1 } : { count: 1, since: Date.now() });
  }
}

// Compares SHA-256 digests so neither length nor content leaks through timing.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}
