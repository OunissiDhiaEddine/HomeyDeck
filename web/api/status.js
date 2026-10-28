import { route } from "../lib/http.js";
import { status } from "../lib/pcs.js";

const handleGET = route(status);
export const GET = (request) => handleGET(request);
