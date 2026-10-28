import { sendCommand } from "../lib/hub.js";

export function POST(request) {
  return sendCommand(request);
}
