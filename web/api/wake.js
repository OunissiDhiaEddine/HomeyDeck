import { wake } from "../lib/hub.js";

export function POST(request) {
  return wake(request);
}
