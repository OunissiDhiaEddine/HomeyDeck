// Local server for working on the PWA and the agent without Vercel:
//   APP_KEY=... AGENT_KEY=... node scripts/dev.js
// It serves public/ and the same API routes, backed by an in-memory database
// unless KV_REST_API_URL / KV_REST_API_TOKEN point at a real one.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as hub from "../lib/hub.js";
import { startFakeUpstash } from "./fake-upstash.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const env = { ...process.env };
if (!env.KV_REST_API_URL) {
  const fake = await startFakeUpstash();
  env.KV_REST_API_URL = fake.url;
  env.KV_REST_API_TOKEN = fake.token;
}

const routes = {
  "GET /api/health": hub.health,
  "GET /api/status": hub.status,
  "GET /api/setup": hub.setup,
  "POST /api/wake": hub.wake,
  "POST /api/command": hub.sendCommand,
  "POST /api/agent/poll": hub.agentPoll,
  "POST /api/agent/result": hub.agentResult,
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
    const response = await route(request, env);
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
}).listen(Number(env.PORT || 3000), "127.0.0.1", () => console.log(`HomeyDeck dev server on http://127.0.0.1:${env.PORT || 3000}`));
