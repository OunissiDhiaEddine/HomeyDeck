import { setup } from "../lib/hub.js";

export function GET(request) {
  return setup(request);
}
