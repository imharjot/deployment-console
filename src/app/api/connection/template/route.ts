// Settings → AWS connection → Switch into a role → Create it with CloudFormation (src/lib/server/connection.ts).
// People only, admins only. → the CloudFormation template (JSON, as a download) that creates a read-only role for this
// console in the account it is run in, with the console's own login and external ID filled in. 400 when the console
// has no login a role can trust; 409 when an environment variable pins the account or the sign-in. Changes nothing.
import { CONNECT_STACK_NAME } from "@/lib/connect-template";
import type { PolicyDocument } from "@/lib/permissions";
import { connectionTemplate } from "@/lib/server/connection";
import { handle, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";
import readonly from "../../../../../infra/iam-policy-readonly.json";

export const GET = handle(async (req) => {
  requirePerm(personOf(req).user, "admin");
  return new Response(await connectionTemplate(readonly as PolicyDocument), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${CONNECT_STACK_NAME}.json"`, "cache-control": "no-store" },
  });
});
