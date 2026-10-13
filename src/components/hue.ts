// Identity hues (globals.css --kind-* / --cat-* / --edge-*): what a thing is, never how it's doing. Set on an element
// as --hue and paint with the hue-chip / hue-text utilities, or read the variable directly.
import type { CSSProperties } from "react";

export const hue = (token: string) => ({ "--hue": `var(--${token})` }) as CSSProperties;
export const kindHue = (kind: string) => hue(`kind-${kind}`);
export const catHue = (category: string) => hue(`cat-${category}`);

// A service that is really a data store running as a container (redis, postgres…) takes the store's hue, not compute's.
export const resourceHue = (kind: string, id = "") =>
  kind === "service" && /redis|valkey|memcache/i.test(id) ? kindHue("cache") : kind === "service" && /postgres|mysql|mariadb|mongo/i.test(id) ? kindHue("database") : kindHue(kind);
