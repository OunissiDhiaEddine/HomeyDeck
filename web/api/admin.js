import { route } from "../lib/http.js";
import { adminGet, adminPost } from "../lib/accounts.js";

const handleGET = route(adminGet);
export const GET = (request) => handleGET(request);
const handlePOST = route(adminPost);
export const POST = (request) => handlePOST(request);
