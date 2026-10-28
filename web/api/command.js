import { route } from "../lib/http.js";
import { sendCommand } from "../lib/pcs.js";

const handlePOST = route(sendCommand);
export const POST = (request) => handlePOST(request);
