import { health } from "../lib/hub.js";

export function GET(request) {
  return health(request);
}
