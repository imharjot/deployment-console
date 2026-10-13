import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/authn";
import { ensureBootstrap, hasUsers } from "@/lib/server/auth/bootstrap";
import { authMode, loginMethods } from "@/lib/server/auth/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Deployment Console" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const mode = authMode();
  if (mode.ok && mode.mode === "session") {
    await ensureBootstrap();
    if (!(await hasUsers())) redirect("/setup");
  }
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  return <LoginForm methods={loginMethods()} next={safeNext(one(sp.next))} error={one(sp.error) ?? null} mode={mode.ok ? mode.mode : null} />;
}
