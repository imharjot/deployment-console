// Setting up an authenticator: the QR code and key for the pending secret (see src/lib/server/auth/mfa.ts).
import { enrollStart } from "@/lib/server/auth/mfa";
import { handle } from "@/lib/server/http";

export const POST = handle(async (req) => enrollStart(req));
