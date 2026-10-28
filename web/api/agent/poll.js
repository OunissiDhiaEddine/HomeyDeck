import { agentPoll } from "../../lib/hub.js";

export function POST(request) {
  return agentPoll(request);
}
