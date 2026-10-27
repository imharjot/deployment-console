// Settings sections, grouped the way people look for them: this device and me, the cloud the console reads, the
// team, and where notifications go. The layout draws the side navigation and each section's header from this list;
// the overview page draws its cards from it. Pages still enforce their own role.
import { Cloud, LayoutGrid, Palette, Plug, PlugZap, ShieldCheck, UserRound, Users, type LucideIcon } from "lucide-react";
import { ROLES, type Role } from "@/lib/rbac";

export interface SettingsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  role?: Role; // the least role that can use it (shown as a lock for everyone below)
  hue: string; // its identity hue (globals.css --hue-*), on its icon in the nav, header and overview card
}

export const SETTINGS_GROUPS: { label: string; items: SettingsSection[] }[] = [
  {
    label: "General",
    items: [
      { href: "/settings", label: "Overview", icon: LayoutGrid, hue: "hue-slate", description: "Every setting at a glance, with what needs attention." },
      { href: "/settings/interface", label: "Interface", icon: Palette, hue: "hue-pink", description: "Theme, motion and performance on this device." },
      { href: "/settings/account", label: "Your account", icon: UserRound, hue: "hue-indigo", description: "Your profile, password and signed-in devices." },
    ],
  },
  {
    label: "Cloud",
    items: [
      {
        href: "/settings/aws",
        label: "AWS connection",
        icon: PlugZap,
        hue: "hue-cyan",
        description: "The simulated account or yours: how the console signs in to AWS, its home region and the regions it reads. Switches without a restart.",
        role: "admin",
      },
      { href: "/settings/environments", label: "Environments", icon: Cloud, hue: "hue-blue", description: "What discovery found: clusters and compose boxes, their services, databases and connections." },
      { href: "/settings/permissions", label: "AWS permissions", icon: ShieldCheck, hue: "hue-orange", description: "What the console's AWS identity can read and change, and the IAM policy that grants the rest.", role: "operator" },
    ],
  },
  {
    label: "Team",
    items: [{ href: "/settings/users", label: "Users & roles", icon: Users, hue: "hue-violet", description: "Who can sign in and what they can do. Changes apply on their next request.", role: "admin" }],
  },
  {
    label: "Notifications",
    items: [
      {
        href: "/settings/integrations",
        label: "Integrations",
        icon: Plug,
        hue: "hue-teal", description: "Alerts to chat when services go down or CI fails, and tickets from panels, log lines and CI runs. Credentials are encrypted at rest and never shown again.",
      },
    ],
  },
];

export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((g) => g.items);

// The section a path belongs to: the longest matching href ("/settings" itself only when nothing deeper matches).
export const sectionOf = (path: string) => SETTINGS_SECTIONS.filter((s) => path === s.href || path.startsWith(`${s.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];

// Below the section's role: the nav shows a lock and the page explains who can use it.
export const lockedFor = (s: SettingsSection, role?: Role) => !!s.role && !!role && ROLES.indexOf(role) < ROLES.indexOf(s.role);
