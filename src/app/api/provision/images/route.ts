import { envOf, handle, json } from "@/lib/server/http";
import { imageChoices } from "@/lib/server/provision";

// The new-service form's image picker: the ECR repositories of the environment's region, or with ?repository=<name>
// that repository's newest tags. Read-only; names and tags only.
export const GET = handle(async (req) => {
  const q = req.nextUrl.searchParams;
  const repository = q.get("repository");
  return json(await imageChoices(envOf(q.get("env")), repository === null ? undefined : repository));
});
