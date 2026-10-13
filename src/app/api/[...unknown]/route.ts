// Any /api path no route handles: a JSON 404 (clients and agents parse JSON), not Next's HTML page.
import { json } from "@/lib/server/http";

const notFound = () => json({ error: "no such API route — see /docs/automation for the operations API" }, 404);
export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
