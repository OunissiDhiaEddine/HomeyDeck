// A tiny client for Upstash Redis over its REST API, so the server needs no
// dependencies. Vercel's Upstash integration sets KV_REST_API_URL and
// KV_REST_API_TOKEN; a database connected straight from Upstash uses the
// UPSTASH_REDIS_REST_* names instead.
//
// Upstash bills every command, including each one inside a pipeline and each
// redis.call inside a Lua script (plus one for the EVAL itself). So scripts
// are only used where something must be atomic, never to save commands.

export function redisConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "";
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export class RedisError extends Error {}

/** Runs several commands in one round trip and returns their results in order. */
export async function pipeline(commands, env = process.env) {
  const cfg = redisConfig(env);
  if (!cfg) throw new RedisError("the database is not connected");
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  if (!res.ok) throw new RedisError(`database answered ${res.status}`);
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new RedisError(r.error);
    return r.result;
  });
}

export async function command(cmd, env = process.env) {
  const [result] = await pipeline([cmd], env);
  return result;
}

/** Runs a Lua script atomically. */
export function evalScript(script, keys, args, env = process.env) {
  return command(["EVAL", script, keys.length, ...keys, ...args], env);
}

/** HGETALL's flat [field, value, ...] list as an object, or null if the key is missing. */
export function hash(flat) {
  if (!Array.isArray(flat) || flat.length === 0) return null;
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}
