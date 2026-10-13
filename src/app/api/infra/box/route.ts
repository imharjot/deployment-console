import { powerAct } from "@/lib/server/console";
import { envOf, handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";

// Power for an EC2 container instance or an RDS instance: { env, kind: "host" | "database", id, action, confirm }.
// 202 with { requestId, operationId, verification: "accepted" }: AWS accepted it; it isn't done yet.
export const POST = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "power");
  const b = await readJson(req);
  return json(await powerAct(envOf(b.env), b.kind, b.id, b.action, b.confirm, { display: user.email, kind: "person", userId: user.id }, ipOf(req)), 202);
});
