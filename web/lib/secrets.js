// Random IDs, hashing, passwords and encryption, all from Node's built-in crypto.

import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

/** n random bytes as base64url (16 bytes → 22 characters). */
export const randomId = (n = 16) => crypto.randomBytes(n).toString("base64url");

/** SHA-256 as base64url, used to store tokens and codes without the secret itself. */
export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("base64url");

// Codes people may type: no 0/O, 1/I/L, so they can't be misread.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A code like K7P2X-M9Q4T: 10 characters, about 50 bits. */
export function humanCode(groups = 2, size = 5) {
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let part = "";
    for (let i = 0; i < size; i++) part += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    parts.push(part);
  }
  return parts.join("-");
}

/** Uppercases a typed code and drops spaces and dashes, so "k7p2x m9q4t" matches. */
export const normalizeCode = (text) => String(text ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Compares SHA-256 digests so neither length nor content leaks through timing. */
export function safeEqual(a, b) {
  const da = crypto.createHash("sha256").update(String(a)).digest();
  const db = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// --- passwords ---------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

/** scrypt with a random salt. The parameters are stored with the hash. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored ?? "").split("$");
  if (kind !== "scrypt" || !key) {
    // Spend the same time as a real check so unknown usernames can't be told apart.
    await hashPassword(password);
    return false;
  }
  const want = Buffer.from(key, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), want.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(got, want);
}

// --- encryption --------------------------------------------------------------

// DATA_KEY can be any text of 32+ characters; the AES key is its SHA-256.
// Every value carries a short ID of the key that sealed it, so the key can be
// rotated: set the new one as DATA_KEY and the old one as DATA_KEY_PREVIOUS,
// and values are re-sealed with the new key the next time they're saved.

function dataKeys(env) {
  return [env.DATA_KEY, env.DATA_KEY_PREVIOUS]
    .filter((k) => typeof k === "string" && k.length >= 32)
    .map((k) => {
      const key = crypto.createHash("sha256").update(k).digest();
      const id = crypto.createHash("sha256").update(key).digest("base64url").slice(0, 6);
      return { key, id };
    });
}

export const hasDataKey = (env) => typeof env.DATA_KEY === "string" && env.DATA_KEY.length >= 32;

/** AES-256-GCM. Output: v1.<key id>.<iv>.<ciphertext + tag>, all base64url. */
export function seal(text, env = process.env) {
  if (text === "" || text == null) return "";
  if (!hasDataKey(env)) throw new Error("DATA_KEY is not set");
  const [{ key, id }] = dataKeys(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return ["v1", id, iv.toString("base64url"), body.toString("base64url")].join(".");
}

/** Reverses seal(). Returns "" for an empty or unreadable value. */
export function unseal(sealed, env = process.env) {
  const [v, id, iv, body] = String(sealed ?? "").split(".");
  if (v !== "v1" || !body) return "";
  const match = dataKeys(env).find((k) => k.id === id);
  if (!match) return "";
  try {
    const raw = Buffer.from(body, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", match.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
