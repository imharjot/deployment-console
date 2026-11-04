// Second step of a password sign-in: a code from the authenticator app, or a recovery code (see src/lib/server/auth/mfa.ts).
import { verifyCode } from "@/lib/server/auth/mfa";
import { handle, ipOf, readJson } from "@/lib/server/http";

export const POST = handle(async (req) => verifyCode(req, (await readJson(req)).code, ipOf(req)));
