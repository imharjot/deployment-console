"use client";
// A star that pins a resource to the person's workspace. One shared SWR list ("/api/pins") for every star on screen;
// the toggle is optimistic and rolls back when the server refuses. Until the pins API exists (wave B) — or for a
// caller who may not use it (401/403) — the star hides itself. Never throws.
import { Star } from "lucide-react";
import { useState, type MouseEvent } from "react";
import useSWR from "swr";
import { cx } from "./ui";

export interface Pin {
  rkey: string;
  name: string;
  kind: string;
  env?: string;
  region?: string;
  createdAt: number;
}
export interface PinList {
  pins: Pin[];
}

export const PINS_KEY = "/api/pins";
const CSRF = { "x-console-csrf": "1" };

// null = hidden: the API is missing (404) or not for this caller (401/403), or it answered something unexpected.
// Raw fetch, not getJson: a 401 here must hide the star, not send the person to the sign-in page.
export async function fetchPins(url: string): Promise<PinList | null> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as Partial<PinList> | null;
  return body && Array.isArray(body.pins) ? { pins: body.pins.filter((p): p is Pin => !!p && typeof p.rkey === "string") } : null;
}

// The list after pinning (on) or unpinning (off) one resource; newest pin first, never twice.
export function togglePin(list: PinList, pin: Omit<Pin, "createdAt">, on: boolean, now: number = Date.now()): PinList {
  const rest = list.pins.filter((p) => p.rkey !== pin.rkey);
  return { pins: on ? [{ ...pin, createdAt: now }, ...rest] : rest };
}

export function PinButton({ rkey, name, kind, env, region, size = "md", className }: {
  rkey: string;
  name: string;
  kind: string;
  env?: string;
  region?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const { data, mutate } = useSWR<PinList | null>(PINS_KEY, fetchPins, { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  if (!data) return null; // loading, missing API, not allowed, or failed: no star rather than a broken one
  const pinned = data.pins.some((p) => p.rkey === rkey);

  const toggle = async (e: MouseEvent) => {
    // Stars sit inside clickable cards and rows: pinning must not also open the resource.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const pin = { rkey, name, kind, ...(env ? { env } : {}), ...(region ? { region } : {}) };
    const next = togglePin(data, pin, !pinned);
    setBusy(true);
    try {
      await mutate(
        async () => {
          const res = pinned
            ? await fetch(`${PINS_KEY}?rkey=${encodeURIComponent(rkey)}`, { method: "DELETE", headers: CSRF })
            : await fetch(PINS_KEY, { method: "POST", headers: { "Content-Type": "application/json", ...CSRF }, body: JSON.stringify(pin) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return next;
        },
        { optimisticData: next, rollbackOnError: true, populateCache: true, revalidate: true },
      );
    } catch {
      /* rolled back to the server's list; the star shows the real state again */
    } finally {
      setBusy(false);
    }
  };

  // A toggle keeps one name; aria-pressed carries the state (a label that flips to "Unpin" would read "Unpin, pressed").
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={`Pin ${name}`}
      title={pinned ? `Unpin ${name}` : `Pin ${name}`}
      aria-busy={busy || undefined}
      onClick={toggle}
      className={cx(
        "press inline-flex flex-none items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg focus-visible:outline-2 pointer-coarse:size-10",
        size === "sm" ? "size-6" : "size-8",
        pinned && "text-degraded hover:text-degraded",
        className,
      )}
    >
      <Star className={size === "sm" ? "size-3.5" : "size-4"} fill={pinned ? "currentColor" : "none"} aria-hidden />
    </button>
  );
}
