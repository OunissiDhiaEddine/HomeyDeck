// Local server for working on the PWA and the agent without Vercel:
//   ADMIN_USERNAME=admin ADMIN_PASSWORD=... DATA_KEY=... node scripts/dev.js
// It serves public/ and the same API routes, backed by a throwaway local
// Redis (see redis-rest.js) unless KV_REST_API_URL / KV_REST_API_TOKEN point
// at a real database.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startRedisRest } from "./redis-rest.js";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(web, "public");
if (!process.env.KV_REST_API_URL) {
  const db = await startRedisRest();
  process.env.KV_REST_API_URL = db.url;
  process.env.KV_REST_API_TOKEN = db.token;
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    // The same file-based routing as Vercel: /api/agent/poll → api/agent/poll.js.
    const file = path.join(web, path.normalize(url.pathname) + ".js");
    let mod;
    try {
      mod = await import(pathToFileURL(file));
    } catch {
      return res.writeHead(404).end("not found");
    }
    const handler = mod[req.method];
    if (!handler) return res.writeHead(405).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(root)) return res.writeHead(404).end();
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1", () => console.log(`HomeyDeck dev server on http://localhost:${process.env.PORT || 3000}`));
