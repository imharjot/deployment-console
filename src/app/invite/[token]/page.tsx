import type { Metadata } from "next";
import { isRole } from "@/lib/rbac";
import { loginMethods } from "@/lib/server/auth/config";
import { peekLink } from "@/lib/server/auth/tokens";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Invitation · Deployment Console", referrer: "no-referrer" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const link = await peekLink(token);
  const info = link ? { purpose: link.purpose, email: link.user.email, name: link.user.name, role: isRole(link.user.role) ? link.user.role : "viewer" } : null;
  return <InviteForm token={token} info={info} methods={loginMethods()} />;
}
