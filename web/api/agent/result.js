import { route } from "../../lib/http.js";
import { agentResult } from "../../lib/pcs.js";

const handlePOST = route(agentResult, { browser: false });
export const POST = (request) => handlePOST(request);
