// A local stand-in for Upstash's REST pipeline endpoint, backed by a real
// Redis so the Lua scripts and commands behave exactly as in production.
// For tests and `npm run dev` only.
//
// It talks to REDIS_URL (redis://host:port) when set, as CI does, and
// otherwise starts a throwaway redis-server of its own.
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

export async function startRedisRest({ token = "dev-token", redisUrl = process.env.REDIS_URL } = {}) {
  let child = null;
  let port;
  let host = "127.0.0.1";
  if (redisUrl) {
    const u = new URL(redisUrl);
    host = u.hostname;
    port = Number(u.port || 6379);
  } else {
    port = await freePort();
    child = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`couldn't start redis-server (${err.message}); install Redis or set REDIS_URL`);
      process.exit(1);
    });
  }
  const redis = await connect(host, port);

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
      if (req.url !== "/pipeline") return res.writeHead(404).end();
      const out = [];
      for (const cmd of JSON.parse(body)) {
        redis.counted++;
        out.push(await redis.send(cmd));
      }
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    /** Commands Upstash would bill since the last reset (a script counts 1 + each redis.call in its text). */
    get commands() {
      return redis.counted;
    },
    resetCount: () => (redis.counted = 0),
    flush: () => redis.send(["FLUSHDB"]),
    raw: (cmd) => redis.send(cmd).then((r) => r.result),
    close: () => {
      server.close();
      redis.socket.destroy();
      child?.kill();
    },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// --- a minimal RESP client ----------------------------------------------------

async function connect(host, port) {
  let socket;
  for (let attempt = 0; ; attempt++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, host, () => resolve(s));
        s.once("error", reject);
      });
      break;
    } catch (err) {
      if (attempt > 50) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  let buffer = Buffer.alloc(0);
  const waiting = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = parseReply(buffer, 0);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.end);
      waiting.shift()(parsed.value);
    }
  });
  const client = {
    socket,
    counted: 0,
    send(cmd) {
      const parts = cmd.map((c) => Buffer.from(String(c)));
      const head = `*${parts.length}\r\n`;
      const msg = Buffer.concat([Buffer.from(head), ...parts.flatMap((p) => [Buffer.from(`$${p.length}\r\n`), p, Buffer.from("\r\n")])]);
      return new Promise((resolve) => {
        waiting.push((value) => {
          if (value instanceof Error) return resolve({ error: value.message });
          resolve({ result: value });
        });
        socket.write(msg);
      });
    },
  };
  // Count what Upstash bills: one per command, plus each redis.call in a script.
  const send = client.send;
  client.send = async (cmd) => {
    const name = String(cmd[0]).toUpperCase();
    if (name === "EVAL") client.counted += (String(cmd[1]).match(/redis\.call\(/g) ?? []).length;
    return send(cmd);
  };
  return client;
}

function parseReply(buf, i) {
  const nl = buf.indexOf("\r\n", i);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString("utf8", i + 1, nl);
  const next = nl + 2;
  switch (type) {
    case "+":
      return { value: line, end: next };
    case "-":
      return { value: new Error(line), end: next };
    case ":":
      return { value: Number(line), end: next };
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, end: next };
      if (buf.length < next + len + 2) return null;
      return { value: buf.toString("utf8", next, next + len), end: next + len + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count < 0) return { value: null, end: next };
      const items = [];
      let at = next;
      for (let n = 0; n < count; n++) {
        const item = parseReply(buf, at);
        if (!item) return null;
        items.push(item.value instanceof Error ? null : item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    default:
      throw new Error(`unexpected Redis reply type ${type}`);
  }
}
