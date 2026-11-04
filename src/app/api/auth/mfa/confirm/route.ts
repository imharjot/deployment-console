// Setting up an authenticator: the first code proves it works; saves it and answers the recovery codes, once.
import { enrollConfirm } from "@/lib/server/auth/mfa";
import { handle, ipOf, readJson } from "@/lib/server/http";

export const POST = handle(async (req) => enrollConfirm(req, (await readJson(req)).code, ipOf(req)));
