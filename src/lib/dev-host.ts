// AUTH_MODE=dev makes every caller an admin, so a dev console must only answer requests addressed to this machine
// (F02). Binding to 127.0.0.1 (`npm run dev`) keeps the LAN out; checking the Host a browser sent also defeats DNS
// rebinding, where a page on attacker.example re-points its own name at 127.0.0.1 and then calls the console: the
// browser still sends `Host: attacker.example`. Pure: shared by the proxy, the routes and the tests.

const PORT = /^\d{1,5}$/;

// "localhost", "127.0.0.1", "[::1]" and "*.localhost", with or without a port (and a trailing dot). Anything else —
// another name, another address, userinfo, an empty or malformed value — is not loopback.
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (typeof host !== "string") return false;
  let h = host.trim().toLowerCase();
  if (!h || /[\s/@\\?#]/.test(h)) return false;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return false;
    const rest = h.slice(end + 1);
    if (rest && !(rest.startsWith(":") && PORT.test(rest.slice(1)))) return false;
    return h.slice(0, end + 1) === "[::1]";
  }
  const colon = h.lastIndexOf(":");
  if (colon >= 0) {
    if (!PORT.test(h.slice(colon + 1))) return false;
    h = h.slice(0, colon);
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h === "localhost" || h === "127.0.0.1" || (h.endsWith(".localhost") && /^[a-z0-9.-]+$/.test(h) && !h.includes(".."));
}

// The `host=` values of an RFC 7239 Forwarded header ("for=1.2.3.4;host=a.example, host=b.example").
function forwardedHosts(v: string): string[] {
  const out: string[] = [];
  for (const part of v.split(/[,;]/)) {
    const m = /^\s*host\s*=\s*"?([^";,]*)"?\s*$/i.exec(part);
    if (m) out.push(m[1]);
  }
  return out;
}

export const DEV_HOST_REFUSED = "dev mode is only reachable on localhost";

// Every host the request names — Host, each X-Forwarded-Host entry and each Forwarded host= — must be loopback.
// A missing Host refuses too (HTTP/1.1 always sends one). Returns the refusal text, or null when the request is fine.
export function devHostProblem(get: (name: string) => string | null): string | null {
  const host = get("host");
  if (!isLoopbackHost(host)) return DEV_HOST_REFUSED;
  const xfh = get("x-forwarded-host");
  if (xfh !== null && !xfh.split(",").every((h) => isLoopbackHost(h))) return DEV_HOST_REFUSED;
  const fwd = get("forwarded");
  if (fwd !== null && !forwardedHosts(fwd).every((h) => isLoopbackHost(h))) return DEV_HOST_REFUSED;
  return null;
}
