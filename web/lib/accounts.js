/**
 * Accounts: signup with an invite code, login, sessions, the account page
 * and the admin page. There is no email, so the admin resets passwords.
 *
 *   uname:{lowercase name}  uid, claimed with SET NX
 *   u:{uid}                 hash: name, role, pw (scrypt), disabled, mustChange, created, invite
 *   users                   set of every uid, for the admin page
 *   sess:{sha256(token)}    uid, expires 30 days after last use
 *   sessions:{uid}          set of that user's session hashes, for "sign out everywhere"
 *   invite:{sha256(code)}   hash: hint, by, at, exp, usedBy, usedName, usedAt
 *   invites                 set of invite hashes
 *
 * The session cookie is "<uid>.<token>". Carrying the uid lets the hot
 * status route build its keys and check the session in one round trip.
 */

import { pipeline, command, evalScript, hash } from "./redis.js";
import { HttpError, json, body, cookie, setCookie, str } from "./http.js";
import { randomId, sha256, humanCode, normalizeCode, safeEqual, hashPassword, checkPassword } from "./secrets.js";
import { deletePcKeys } from "./pcs.js";

export const SESSION_COOKIE = "hd_session";
export const SESSION_TTL_S = 30 * 24 * 3600;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const NAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

export const maxPcs = (env) => {
  const raw = String(env.MAX_PCS_PER_USER ?? "").trim();
  if (raw === "") return 3;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : Infinity; // 0 or "none" means no cap
};

// --- sessions ----------------------------------------------------------------

/** The uid and session key from the cookie, without touching the database. */
export function sessionParts(request) {
  const raw = cookie(request, SESSION_COOKIE);
  const dot = raw.indexOf(".");
  const uid = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (dot < 0 || !ID_RE.test(uid) || token.length < 40) throw new HttpError(401, "please sign in", "signed_out");
  return { uid, key: `sess:${sha256(token)}` };
}

/** Checks the session and loads the user (2 commands, 1 round trip). */
export async function requireUser(request, env, { admin = false } = {}) {
  const { uid, key } = sessionParts(request);
  const [owner, flat] = await pipeline([["GET", key], ["HGETALL", `u:${uid}`]], env);
  const user = hash(flat);
  if (owner !== uid || !user) throw new HttpError(401, "please sign in", "signed_out");
  if (user.disabled === "1") throw new HttpError(403, "this account is disabled", "disabled");
  if (admin && user.role !== "admin") throw new HttpError(403, "only the admin can do that");
  return { uid, sessionKey: key, user };
}

async function startSession(uid, request, env) {
  const token = randomId(32);
  const key = `sess:${sha256(token)}`;
  await pipeline([["SET", key, uid, "EX", SESSION_TTL_S], ["SADD", `sessions:${uid}`, key]], env);
  return setCookie(SESSION_COOKIE, `${uid}.${token}`, SESSION_TTL_S);
}

/** Ends every session of a user, except `keep` if given. */
async function endSessions(uid, env, keep = null) {
  const keys = (await command(["SMEMBERS", `sessions:${uid}`], env)) ?? [];
  const gone = keys.filter((k) => k !== keep);
  const cmds = gone.length ? [["DEL", ...gone]] : [];
  cmds.push(["DEL", `sessions:${uid}`]);
  if (keep) cmds.push(["SADD", `sessions:${uid}`, keep]);
  await pipeline(cmds, env);
}

const clearCookie = () => setCookie(SESSION_COOKIE, "", 0);

// --- users -------------------------------------------------------------------

function checkName(name) {
  if (!NAME_RE.test(name)) throw new HttpError(400, "usernames are 3 to 32 letters, digits, _ or -");
}

function checkNewPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new HttpError(400, `passwords need at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) throw new HttpError(400, "that password is too long");
}

const isAdminName = (name, env) => Boolean(env.ADMIN_USERNAME) && name.toLowerCase() === env.ADMIN_USERNAME.trim().toLowerCase();

/**
 * Creates the admin from ADMIN_USERNAME / ADMIN_PASSWORD the first time they
 * sign in. Once the account exists the variables are ignored, and
 * ADMIN_PASSWORD should be deleted from Vercel.
 */
async function bootstrapAdmin(name, password, env) {
  if (!isAdminName(name, env) || !env.ADMIN_PASSWORD || !safeEqual(password, env.ADMIN_PASSWORD)) return null;
  checkName(name);
  const uid = randomId();
  const claimed = await command(["SET", `uname:${name.toLowerCase()}`, uid, "NX"], env);
  if (claimed !== "OK") return null;
  await pipeline(
    [
      ["HSET", `u:${uid}`, "name", name, "role", "admin", "pw", await hashPassword(password), "created", Date.now()],
      ["SADD", "users", uid],
    ],
    env,
  );
  return uid;
}

export function publicUser(uid, user) {
  return { id: uid, name: user.name, role: user.role, mustChange: user.mustChange === "1" };
}

/** Deletes a user, their sessions and their PCs. */
export async function deleteUser(uid, user, env) {
  const [pcs, sessions] = await pipeline([["SMEMBERS", `pcs:${uid}`], ["SMEMBERS", `sessions:${uid}`]], env);
  const cmds = [
    ["DEL", `u:${uid}`, `pcs:${uid}`, `sessions:${uid}`],
    ["SREM", "users", uid],
    ...(sessions?.length ? [["DEL", ...sessions]] : []),
    ...(pcs ?? []).flatMap((pc) => deletePcKeys(uid, pc)),
  ];
  if (user?.name) cmds.push(["DEL", `uname:${user.name.toLowerCase()}`]);
  await pipeline(cmds, env);
}

// --- signup, login, logout (POST /api/session) -------------------------------

const SIGNUP = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'bad_invite' end
local f = redis.call('HMGET', KEYS[1], 'usedBy', 'exp')
if f[1] and f[1] ~= '' then return 'bad_invite' end
if f[2] and f[2] ~= '' and tonumber(f[2]) < tonumber(ARGV[4]) then return 'bad_invite' end
if not redis.call('SET', KEYS[2], ARGV[1], 'NX') then return 'taken' end
redis.call('HSET', KEYS[3], 'name', ARGV[2], 'role', 'user', 'pw', ARGV[3], 'created', ARGV[4], 'invite', ARGV[5])
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('HSET', KEYS[1], 'usedBy', ARGV[1], 'usedName', ARGV[2], 'usedAt', ARGV[4])
return 'ok'`;

export async function sessionPost(request, env) {
  const data = await body(request);
  const name = str(data.username, 64);
  const password = typeof data.password === "string" ? data.password : "";

  if (data.action === "logout") {
    let parts = null;
    try {
      parts = sessionParts(request);
    } catch {}
    if (parts) await pipeline([["DEL", parts.key], ["SREM", `sessions:${parts.uid}`, parts.key]], env);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (data.action === "signup") {
    checkName(name);
    checkNewPassword(password);
    if (isAdminName(name, env)) throw new HttpError(409, "that username is taken");
    const code = normalizeCode(data.invite);
    if (!code) throw new HttpError(400, "enter your invite code");
    const uid = randomId();
    const pw = await hashPassword(password);
    const inviteKey = `invite:${sha256(code)}`;
    const outcome = await evalScript(SIGNUP, [inviteKey, `uname:${name.toLowerCase()}`, `u:${uid}`, "users"], [uid, name, pw, Date.now(), code.slice(0, 4)], env);
    if (outcome === "bad_invite") throw new HttpError(403, "that invite code is wrong, used or expired");
    if (outcome === "taken") throw new HttpError(409, "that username is taken");
    const cookieHeader = await startSession(uid, request, env);
    return json({ ok: true, user: { id: uid, name, role: "user", mustChange: false } }, 200, { "Set-Cookie": cookieHeader });
  }

  if (data.action === "login") {
    const wrong = new HttpError(401, "wrong username or password", "bad_login");
    if (!name || !password) throw wrong;
    let uid = await command(["GET", `uname:${name.toLowerCase()}`], env);
    if (!uid) uid = await bootstrapAdmin(name, password, env);
    const user = uid ? hash(await command(["HGETALL", `u:${uid}`], env)) : null;
    // checkPassword takes as long for a missing user, so names can't be probed by timing.
    if (!(await checkPassword(password, user?.pw)) || !user) throw wrong;
    if (user.disabled === "1") throw new HttpError(403, "this account is disabled", "disabled");
    const cookieHeader = await startSession(uid, request, env);
    return json({ ok: true, user: publicUser(uid, user) }, 200, { "Set-Cookie": cookieHeader });
  }

  throw new HttpError(400, "unknown action");
}

// --- the signed-in user (GET /api/session) -----------------------------------

/**
 * What the app loads when it opens: the user and their PCs. It also slides
 * the session's 30-day expiry and refreshes the cookie to match.
 */
export async function sessionGet(request, env) {
  const { uid, key } = sessionParts(request);
  const [owner, flat, pcIds] = await pipeline(
    [["GETEX", key, "EX", SESSION_TTL_S], ["HGETALL", `u:${uid}`], ["SMEMBERS", `pcs:${uid}`]],
    env,
  );
  const user = hash(flat);
  if (owner !== uid || !user) throw new HttpError(401, "please sign in", "signed_out");
  if (user.disabled === "1") throw new HttpError(403, "this account is disabled", "disabled");

  const ids = (pcIds ?? []).sort();
  const metas = ids.length ? await pipeline(ids.map((pc) => ["HGETALL", `pc:${uid}:${pc}`]), env) : [];
  const pcs = ids
    .map((id, i) => ({ id, meta: hash(metas[i]) }))
    .filter((p) => p.meta)
    .map(({ id, meta }) => ({
      id,
      name: meta.name || meta.hostname || "My PC",
      wake: Boolean(meta.mac && meta.host),
      port: Number(meta.port) || 9,
      created: Number(meta.created) || 0,
    }))
    .sort((a, b) => a.created - b.created);

  const raw = cookie(request, SESSION_COOKIE);
  return json(
    { ok: true, user: publicUser(uid, user), pcs, maxPcs: Number.isFinite(maxPcs(env)) ? maxPcs(env) : null, agentUrl: agentUrl(env) },
    200,
    { "Set-Cookie": setCookie(SESSION_COOKIE, raw, SESSION_TTL_S) },
  );
}

export const agentUrl = (env) =>
  env.AGENT_DOWNLOAD_URL || "https://github.com/OunissiDhiaEddine/HomeyDeck/releases/latest/download/homeydeck-agent.exe";

// --- account page (POST /api/account) ----------------------------------------

export async function accountPost(request, env) {
  const { uid, sessionKey, user } = await requireUser(request, env);
  const data = await body(request);

  if (data.action === "password") {
    // A temporary password from the admin can be changed without retyping it.
    if (user.mustChange !== "1" && !(await checkPassword(String(data.current ?? ""), user.pw))) {
      throw new HttpError(403, "your current password is wrong");
    }
    checkNewPassword(data.next);
    await command(["HSET", `u:${uid}`, "pw", await hashPassword(data.next), "mustChange", "0"], env);
    await endSessions(uid, env, sessionKey); // every other device signs in again
    return json({ ok: true });
  }

  if (data.action === "logout_all") {
    await endSessions(uid, env);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (data.action === "delete") {
    if (!(await checkPassword(String(data.password ?? ""), user.pw))) throw new HttpError(403, "your password is wrong");
    if (user.role === "admin") throw new HttpError(409, "the admin account can't be deleted from here");
    await deleteUser(uid, user, env);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  throw new HttpError(400, "unknown action");
}

// --- admin page (GET and POST /api/admin) ------------------------------------

export async function adminGet(request, env) {
  await requireUser(request, env, { admin: true });
  const [inviteIds, uids] = await pipeline([["SMEMBERS", "invites"], ["SMEMBERS", "users"]], env);
  const cmds = [
    ...(inviteIds ?? []).map((id) => ["HGETALL", `invite:${id}`]),
    ...(uids ?? []).flatMap((id) => [["HGETALL", `u:${id}`], ["SCARD", `pcs:${id}`]]),
  ];
  const out = cmds.length ? await pipeline(cmds, env) : [];
  const now = Date.now();

  const invites = (inviteIds ?? [])
    .map((id, i) => ({ id, ...hash(out[i]) }))
    .map((inv) => ({
      id: inv.id,
      hint: inv.hint ?? "",
      created: Number(inv.at) || 0,
      expires: Number(inv.exp) || null,
      usedBy: inv.usedName || null,
      usedAt: Number(inv.usedAt) || null,
      state: inv.usedBy ? "used" : inv.exp && Number(inv.exp) < now ? "expired" : "open",
    }))
    .sort((a, b) => b.created - a.created);

  const base = (inviteIds ?? []).length;
  const users = (uids ?? [])
    .map((id, i) => ({ id, user: hash(out[base + 2 * i]), pcs: out[base + 2 * i + 1] ?? 0 }))
    .filter((u) => u.user)
    .map(({ id, user, pcs }) => ({
      id,
      name: user.name,
      role: user.role,
      disabled: user.disabled === "1",
      created: Number(user.created) || 0,
      pcs,
    }))
    .sort((a, b) => a.created - b.created);

  return json({ ok: true, invites, users, adminPasswordSet: Boolean(env.ADMIN_PASSWORD) });
}

const INVITE_MAX_DAYS = 365;

export async function adminPost(request, env) {
  const { uid: me } = await requireUser(request, env, { admin: true });
  const data = await body(request);

  if (data.action === "invite_create") {
    const days = Number(data.days) || 0;
    if (days < 0 || days > INVITE_MAX_DAYS) throw new HttpError(400, `expiry must be 0 to ${INVITE_MAX_DAYS} days`);
    const code = humanCode(3, 4);
    const id = sha256(normalizeCode(code));
    const now = Date.now();
    const fields = ["hint", normalizeCode(code).slice(0, 4), "by", me, "at", now];
    if (days) fields.push("exp", now + days * 86400_000);
    await pipeline([["HSET", `invite:${id}`, ...fields], ["SADD", "invites", id]], env);
    return json({ ok: true, code });
  }

  if (data.action === "invite_revoke") {
    const id = str(data.id, 64);
    await pipeline([["DEL", `invite:${id}`], ["SREM", "invites", id]], env);
    return json({ ok: true });
  }

  // The rest act on another user.
  const uid = str(data.user, 32);
  if (!ID_RE.test(uid)) throw new HttpError(400, "unknown user");
  if (uid === me) throw new HttpError(409, "use your account page to change your own account");
  const user = hash(await command(["HGETALL", `u:${uid}`], env));
  if (!user) throw new HttpError(404, "that user no longer exists");

  if (data.action === "user_disable") {
    const disabled = Boolean(data.disabled);
    await command(["HSET", `u:${uid}`, "disabled", disabled ? "1" : "0"], env);
    if (disabled) await endSessions(uid, env);
    return json({ ok: true });
  }

  if (data.action === "user_reset") {
    const password = humanCode(3, 4);
    await command(["HSET", `u:${uid}`, "pw", await hashPassword(password), "mustChange", "1"], env);
    await endSessions(uid, env);
    return json({ ok: true, password });
  }

  if (data.action === "user_delete") {
    await deleteUser(uid, user, env);
    return json({ ok: true });
  }

  throw new HttpError(400, "unknown action");
}
