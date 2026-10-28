// An in-memory stand-in for Upstash's REST pipeline endpoint, with just the
// commands the hub uses. For tests and `npm run dev` only (TTLs are ignored).
import http from "node:http";

export async function startFakeUpstash(token = "dev-token") {
  const store = new Map();
  const run = ([cmd, ...args]) => {
    switch (cmd) {
      case "SET": store.set(args[0], args[1]); return "OK";
      case "GET": return store.get(args[0]) ?? null;
      case "GETDEL": { const v = store.get(args[0]) ?? null; store.delete(args[0]); return v; }
      case "MGET": return args.map((k) => store.get(k) ?? null);
      case "DEL": return store.delete(args[0]) ? 1 : 0;
      case "INCR": { const v = Number(store.get(args[0]) ?? 0) + 1; store.set(args[0], String(v)); return v; }
      case "EXPIRE": return 1;
      default: return undefined;
    }
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
      res.end(JSON.stringify(JSON.parse(body).map((c) => {
        const result = run(c);
        return result === undefined ? { error: `unsupported ${c[0]}` } : { result };
      })));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { store, url: `http://127.0.0.1:${server.address().port}`, token, close: () => server.close() };
}
