import { route } from "../lib/http.js";
import { sessionGet, sessionPost } from "../lib/accounts.js";

const handleGET = route(sessionGet);
export const GET = (request) => handleGET(request);
const handlePOST = route(sessionPost);
export const POST = (request) => handlePOST(request);
