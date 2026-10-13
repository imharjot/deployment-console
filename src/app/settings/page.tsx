"use client";
// Settings → Overview: one card per section with a live line about its state, so nothing has to be hunted for.
// Reads only what other pages already poll (SWR shares the requests); admin-only data is asked for by admins only.
import { ArrowRight, Lock } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { useTheme } from "@/components/shell";
import type { IntegrationList } from "@/components/ticket-button";
import { hue } from "@/components/hue";
import { cx } from "@/components/ui";
import { ROLE_INFO, displayName, useMe } from "@/components/user-menu";
import { useCapability, useEnvList } from "@/lib/client/env";
import { usePerfChoice } from "@/lib/client/perf";
import { SETTINGS_SECTIONS, lockedFor, type SettingsSection } from "./sections";

type Status = { text: string; tone?: "ok" | "warn" | "muted" };

export default function SettingsOverview() {
  const me = useMe().data;
  const role = me?.user.role;
  const admin = !!me?.perms.includes("admin");
  const envs = useEnvList().data;
  const cap = useCapability();
  const users = useSWR<unknown[]>(admin ? "/api/users" : null).data;
  const integrations = useSWR<IntegrationList>("/api/integrations").data;
  const { choice } = useTheme();
  const perf = usePerfChoice();

  const enabled = integrations?.integrations.filter((i) => i.enabled).length;
  const status: Record<string, Status | undefined> = {
    "/settings/interface": { text: `${choice === "system" ? "System theme" : choice === "dark" ? "Dark theme" : "Light theme"} · ${perf.level === "lite" ? "lite effects" : "full effects"}${perf.choice === "auto" ? " (auto)" : ""}`, tone: "muted" },
    "/settings/account": me ? { text: `${displayName(me.user)} · ${ROLE_INFO[me.user.role].label}`, tone: "muted" } : undefined,
    "/settings/environments": envs ? { text: envs.length ? `${envs.length} environment${envs.length === 1 ? "" : "s"} · ${envs.map((e) => e.label).join(", ")}` : "No environments discovered yet", tone: envs.length ? "ok" : "warn" } : undefined,
    "/settings/permissions": cap ? (cap.readOnly ? { text: "Read-only identity: changes stay disabled", tone: "warn" } : cap.denied.length ? { text: `${cap.denied.length} action${cap.denied.length === 1 ? "" : "s"} denied or likely denied`, tone: "warn" } : { text: "Actions allowed", tone: "ok" }) : undefined,
    "/settings/users": users ? { text: `${users.length} user${users.length === 1 ? "" : "s"}`, tone: "muted" } : undefined,
    "/settings/integrations": integrations ? { text: enabled ? `${enabled} enabled of ${integrations.integrations.length}` : "None enabled yet", tone: enabled ? "ok" : "muted" } : undefined,
  };

  return (
    <div className="stagger grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
      {SETTINGS_SECTIONS.filter((s) => s.href !== "/settings").map((s) => (
        <SectionCard key={s.href} s={s} status={status[s.href]} locked={lockedFor(s, role)} />
      ))}
    </div>
  );
}

function SectionCard({ s, status, locked }: { s: SettingsSection; status?: Status; locked: boolean }) {
  return (
    <Link href={s.href} className="press lift group flex min-h-[168px] flex-col gap-3 rounded-2xl border border-line bg-panel p-5 shadow-card [--press-scale:0.985]">
      <div className="flex items-center gap-3">
        <span className="hue-chip grid size-10 flex-none place-items-center rounded-xl" style={hue(s.hue)}>
          <s.icon className="size-[18px]" />
        </span>
        <span className="text-[16px] font-semibold">{s.label}</span>
        {locked ? <Lock className="ml-auto size-4 text-fg-3" aria-label={`${s.role}s only`} /> : <ArrowRight className="ml-auto size-4 -translate-x-1 text-fg-3 opacity-0 transition-[opacity,translate] duration-200 group-hover:translate-x-0 group-hover:opacity-100" />}
      </div>
      <p className="text-[14px] leading-relaxed text-fg-2">{s.description}</p>
      <div className="mt-auto flex items-center gap-2 text-[13px]">
        {locked ? (
          <span className="text-fg-3">{s.role === "admin" ? "Admins" : "Operators and admins"} only</span>
        ) : status ? (
          <>
            <span className={cx("size-1.5 flex-none rounded-full", status.tone === "ok" ? "bg-up" : status.tone === "warn" ? "bg-degraded" : "bg-fg-3")} />
            <span className={cx("truncate", status.tone === "warn" ? "text-degraded" : "text-fg-2")}>{status.text}</span>
          </>
        ) : (
          <span className="h-3.5 w-32 rounded bg-panel-2" />
        )}
      </div>
    </Link>
  );
}
