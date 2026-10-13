import { useCallback, useSyncExternalStore } from "react";

// Media queries the log viewer needs in JS, not just CSS: row height, the time format and sideways scrolling all
// feed the virtualiser's arithmetic, and the facets panel's default depends on the room left for the lines.
export const PHONE = "(max-width: 767.98px)"; // below Tailwind's md
export const ROOMY = "(min-width: 1024px)"; // lg: space for facets beside the lines, even with the sidebar

// false on the server and during hydration, then the real value.
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}

export const useNarrow = () => useMediaQuery(PHONE);
