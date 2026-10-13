"use client";
// The signed-in user in the sidebar footer: avatar, name, role. The menu opens Account, Settings (admins) and Sign out.
// Also home to the small identity pieces other pages reuse (useMe, Avatar, RoleChip, ROLE_INFO).
import { AnimatePresence, motion } from "motion/react";
import { LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import useSWR from "swr";
import { postJson } from "@/lib/client/api";
import type { Perm, Role } from "@/lib/rbac";
import { Modal, Portal, popover, usePhone } from "./motion";
import { Chip, cx } from "./ui";

export interface Me {
  email: string;
  user: { id: string; email: string; name: string | null; role: Role };
  perms: Perm[];
  source: string;
  authMode: "session" | "alb" | "dev" | null;
  loginMethods: { password: boolean; sso: { label: string } | null };
  via: "session" | "alb" | "dev" | null;
  hasPassword: boolean;
}

// Same key and options as the shell, so SWR shares one request.
export const useMe = () => useSWR<Me>("/api/me", { revalidateOnFocus: false });

export const ROLE_INFO: Record<Role, { label: string; hint: string }> = {
  viewer: { label: "Viewer", hint: "Read-only: every page, logs, metrics and the audit log." },
  developer: { label: "Developer", hint: "Viewer, plus actions on non-protected environments, CI re-runs and tickets." },
  operator: { label: "Operator", hint: "Developer, plus protected (production-like) environments and host / database power." },
  admin: { label: "Admin", hint: "Operator, plus users and roles, integrations and settings." },
};

const ROLE_TONE: Record<Role, "muted" | undefined | "warn" | "accent"> = { viewer: "muted", developer: undefined, operator: "warn", admin: "accent" };

export function RoleChip({ role, className }: { role: Role; className?: string }) {
  return (
    <Chip tone={ROLE_TONE[role]} className={className}>
      {ROLE_INFO[role].label}
    </Chip>
  );
}

export const displayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email.split("@")[0];

function initials(u: { name: string | null; email: string }) {
  const words = (u.name?.trim() || u.email.split("@")[0]).split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : (words[0]?.[1] ?? ""))).toUpperCase();
}

// A stable hue per email, so people are recognisable at a glance in lists (kept muted, like the rest of the palette).
function hue(email: string) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function Avatar({ user, size = 28 }: { user: { name: string | null; email: string }; size?: number }) {
  const h = hue(user.email);
  return (
    <span
      aria-hidden
      className="grid flex-none select-none place-items-center rounded-full font-medium tracking-[0.02em] text-[#f5f3ee] shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: `hsl(${h} 14% 36%)` }}
    >
      {initials(user)}
    </span>
  );
}

export async function signOut() {
  try {
    await postJson("/api/auth/logout", {});
  } finally {
    window.location.replace("/login"); // full load: drop every cached response of this user
  }
}

export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const me = useMe().data;
  const phone = usePhone();
  const [pos, setPos] = useState<CSSProperties | null>(null); // open when set
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    // The anchored popover closes on outside presses and resizes; the phone sheet has its own scrim.
    if (!phone) {
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("resize", close);
    }
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [pos, phone]);

  if (!me) return <div className={cx("skeleton rounded-lg", collapsed ? "mx-auto size-9" : "h-11")} />;

  const u = me.user;
  const name = displayName(u);
  // Rendered in a portal (the sidebar would otherwise clip it), placed from the trigger. Phones get a bottom sheet.
  const toggle = () => {
    if (pos) return setPos(null);
    const r = trigger.current!.getBoundingClientRect();
    setPos(collapsed ? { left: r.right + 8, bottom: window.innerHeight - r.bottom } : { left: r.left, bottom: window.innerHeight - r.top + 8, width: Math.max(r.width, 248) });
  };
  const close = () => setPos(null);
  const item = "press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:py-3 pointer-coarse:text-[16px]";
  const body = (
    <>
      <div className="flex items-center gap-3 px-2.5 pb-2.5 pt-2">
        <Avatar user={u} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-fg">{name}</div>
          <div className="truncate text-[12px] text-fg-3">{u.email}</div>
        </div>
      </div>
      <div className="mx-2.5 mb-2 rounded-lg bg-panel-2 px-2.5 py-2 text-[12px] leading-snug text-fg-3">
        <RoleChip role={u.role} className="mr-1.5" />
        {ROLE_INFO[u.role].hint}
      </div>
      <div className="my-1 h-px bg-line" />
      <Link role="menuitem" href="/settings/account" onClick={close} className={item}>
        <UserRound className="size-4" strokeWidth={1.75} /> Account
      </Link>
      {me.perms.includes("admin") && (
        <Link role="menuitem" href="/settings" onClick={close} className={item}>
          <Settings className="size-4" strokeWidth={1.75} /> Settings
        </Link>
      )}
      <div className="my-1 h-px bg-line" />
      {me.via === "alb" ? (
        <div className="px-2.5 py-2 text-[12px] text-fg-3">Signed in through the load balancer. Sign out of your identity provider to end the session.</div>
      ) : (
        <button role="menuitem" onClick={signOut} className={cx(item, "hover:!text-down")}>
          <LogOut className="size-4" strokeWidth={1.75} /> Sign out
        </button>
      )}
    </>
  );

  return (
    <>
      <button
        ref={trigger}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={collapsed ? `${name} · ${ROLE_INFO[u.role].label}` : undefined}
        className={cx("press flex w-full items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-panel-2", collapsed ? "justify-center py-1.5" : "p-1.5", pos && "bg-panel-2")}
      >
        <Avatar user={u} />
        {!collapsed && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-medium text-fg">{name}</span>
              <RoleChip role={u.role} className="flex-none !px-1 !py-0 !text-[11px]" />
            </span>
            <span className="block truncate text-[12px] text-fg-3">{u.email}</span>
          </span>
        )}
      </button>
      {phone ? (
        <AnimatePresence>
          {pos && (
            <Modal onClose={close} z="z-[80]" aria-label="Account">
              <div ref={menu} role="menu" className="p-2 pb-3">
                {body}
              </div>
            </Modal>
          )}
        </AnimatePresence>
      ) : (
        <Portal>
          <AnimatePresence>
            {pos && (
              <motion.div
                ref={menu}
                {...popover}
                initial={{ opacity: 0, scale: 0.97, y: 4 }}
                role="menu"
                aria-label="Account"
                style={{ ...pos, transformOrigin: collapsed ? "bottom left" : "bottom center" }}
                className={cx("fixed z-[80] rounded-xl border border-line bg-panel p-1.5 text-left shadow-float", collapsed && "w-64")}
              >
                {body}
              </motion.div>
            )}
          </AnimatePresence>
        </Portal>
      )}
    </>
  );
}
