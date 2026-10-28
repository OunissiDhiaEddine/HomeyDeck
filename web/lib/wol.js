import dgram from "node:dgram";

/** Accepts AA:BB:CC:DD:EE:FF, AA-BB-..., or AABBCCDDEEFF. */
export function parseMAC(text) {
  const hex = text.replace(/[:\-. ]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** 6 x 0xFF followed by the MAC address repeated 16 times. */
export function magicPacket(mac) {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
}

/** Sends the packet a few times to host:port, since UDP gives no delivery guarantee. */
export async function sendMagicPacket({ mac, host, port }, repeats = 3) {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket("udp4");
  try {
    for (let i = 0; i < repeats; i++) {
      await new Promise((resolve, reject) => socket.send(packet, port, host, (err) => (err ? reject(err) : resolve())));
      if (i < repeats - 1) await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    socket.close();
  }
}
