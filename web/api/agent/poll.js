import { route } from "../../lib/http.js";
import { agentPoll } from "../../lib/pcs.js";

const handlePOST = route(agentPoll, { browser: false });
export const POST = (request) => handlePOST(request);
