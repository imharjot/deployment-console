"use client";
import { MotionConfig } from "motion/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { ApiError, fetcher } from "@/lib/client/api";
import { EnvProvider } from "@/lib/client/env";
import { slowerWhenLite, usePerfLevel } from "@/lib/client/perf";
import { CommandPalette } from "./command-palette";
import { ConfirmProvider } from "./confirm";
import { Shell } from "./shell";
import { ToastProvider } from "./toast";

// Sign-in pages render bare: no shell, palette or env polling (those call APIs that need a session).
const BARE = /^\/(login|setup|invite)(\/|$)/;

export function Providers({ children }: { children: ReactNode }) {
  const bare = BARE.test(usePathname() ?? "");
  // Lite effects (weak hardware or chosen in Settings → Interface): motion keeps fades but drops movement.
  const lite = usePerfLevel() === "lite";
  return (
    <SWRConfig
      value={{
        fetcher,
        use: [slowerWhenLite],
        refreshWhenHidden: false, // polling pauses in background tabs
        revalidateOnFocus: true,
        dedupingInterval: 2_000,
        errorRetryInterval: 5_000,
        shouldRetryOnError: (e) => !(e instanceof ApiError && (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404)),
      }}
    >
      <MotionConfig reducedMotion={lite ? "always" : "user"}>
        {bare ? (
          <ToastProvider>{children}</ToastProvider>
        ) : (
          <EnvProvider>
            <ToastProvider>
              <ConfirmProvider>
                <Shell>{children}</Shell>
                <CommandPalette />
              </ConfirmProvider>
            </ToastProvider>
          </EnvProvider>
        )}
      </MotionConfig>
    </SWRConfig>
  );
}
