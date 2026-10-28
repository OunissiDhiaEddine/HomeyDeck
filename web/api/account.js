import { route } from "../lib/http.js";
import { accountPost } from "../lib/accounts.js";

const handlePOST = route(accountPost);
export const POST = (request) => handlePOST(request);
