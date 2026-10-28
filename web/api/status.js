import { status } from "../lib/hub.js";

export function GET(request) {
  return status(request);
}
