"use client";
// "Refresh now": ask the server to sync with AWS at once (POST /api/sync), then re-read everything on screen.
// A sync someone else started a moment ago (429) still ends in a re-read: the data is just as fresh.
import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { postJson } from "./api";

export function useSyncNow() {
  const { mutate } = useSWRConfig();
  const [syncing, setSyncing] = useState(false);
  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await postJson("/api/sync", {}).catch(() => undefined);
      await mutate(() => true);
    } finally {
      setSyncing(false);
    }
  }, [mutate, syncing]);
  return { sync, syncing };
}
