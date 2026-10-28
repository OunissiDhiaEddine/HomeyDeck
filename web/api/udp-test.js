// Temporary check: can a Vercel function send UDP to a public host:port?
// It sends a DNS query for example.com to 1.1.1.1:53 over UDP and waits for
// the reply. A reply proves outbound UDP works, which is all a Wake-on-LAN
// magic packet needs. Takes no input and sends nothing anywhere else.

import dgram from "node:dgram";

function dnsQuery(name) {
  const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  const labels = name.split(".").flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0x00, 0x01, 0x00, 0x01])]);
}

export default async function handler(_req, res) {
  const started = Date.now();
  const socket = dgram.createSocket("udp4");
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply within 3 s")), 3000);
      socket.once("message", (msg) => { clearTimeout(timer); resolve(msg); });
      socket.once("error", (err) => { clearTimeout(timer); reject(err); });
      socket.send(dnsQuery("example.com"), 53, "1.1.1.1", (err) => err && reject(err));
    });
    res.status(200).json({
      ok: true,
      udp: "sent to 1.1.1.1:53 and got a reply",
      replyBytes: reply.length,
      answers: reply.readUInt16BE(6),
      ms: Date.now() - started,
      region: process.env.VERCEL_REGION ?? "unknown",
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err?.message ?? err), ms: Date.now() - started });
  } finally {
    socket.close();
  }
}
