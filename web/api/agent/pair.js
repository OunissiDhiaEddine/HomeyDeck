import { route } from "../../lib/http.js";
import { agentPair } from "../../lib/pcs.js";

const handlePOST = route(agentPair, { browser: false });
export const POST = (request) => handlePOST(request);
