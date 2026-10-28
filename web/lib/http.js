// Request and response helpers shared by the API routes.

import { redisConfig, RedisError } from "./redis.js";

/** Thrown by handlers to answer with an error message and status code. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/**
 * Wraps a route: checks the database is connected, turns HttpError and
 * database failures into JSON answers, and for browser requests that change
 * something, applies the CSRF rule (JSON body + same-site Origin).
 */
export function route(handler, { browser = true } = {}) {
  return async (request, env = process.env, options) => {
    try {
      if (!redisConfig(env)) throw new HttpError(500, "the database is not connected (add Upstash Redis in Vercel → Storage)");
      if (browser && request.method !== "GET") checkSameSite(request);
      return await handler(request, env, options);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message, code: err.code }, err.status);
      if (err instanceof RedisError) return json({ ok: false, error: `database problem: ${err.message}` }, 503);
      throw err;
    }
  };
}

// A form on another site can't send application/json without a CORS
// preflight, and fetch() always sends Origin on a POST, so together these
// stop cross-site requests riding on the session cookie.
function checkSameSite(request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "requests must be JSON");
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {}
  if (!originHost || originHost !== host) throw new HttpError(403, "cross-site request refused");
}

export async function body(request) {
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "the request body must be a JSON object");
  return data;
}

export function cookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export function setCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function parse(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
