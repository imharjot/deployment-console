import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureBootstrap, ensureSetupToken, hasUsers } from "@/lib/server/auth/bootstrap";
import { authMode } from "@/lib/server/auth/config";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up · Deployment Console" };
export const dynamic = "force-dynamic";

// Open only while there are no users. Showing it (re)prints a setup token to the server log if none is live.
export default async function SetupPage() {
  await ensureBootstrap();
  if (await hasUsers()) redirect("/login");
  await ensureSetupToken();
  const mode = authMode();
  const verified = (await headers()).get("x-console-user-verified-email"); // ALB first run only (set by the proxy)
  return <SetupForm alb={mode.ok && mode.mode === "alb"} verifiedEmail={verified} />;
}
