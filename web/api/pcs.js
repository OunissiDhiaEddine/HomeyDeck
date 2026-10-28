import { route } from "../lib/http.js";
import { pcsPost } from "../lib/pcs.js";

const handlePOST = route(pcsPost);
export const POST = (request) => handlePOST(request);
