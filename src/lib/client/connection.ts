// The AWS connection this page was loaded with: the token GET /api/me gives it (whose data the page shows), sent as
// x-console-connection with every write. Once an admin switches the console to another account or home region, the
// server refuses what this page planned for the previous one's same-named services (409) until it is reloaded. Pinned
// once per page load, never refreshed by a later response: the page's other data may still be the previous account's.
// Installed around fetch, so every write path carries it, including those that don't go through api.ts.
let pinned: string | undefined;

export function pinPageConnection(token: unknown): void {
  if (pinned === undefined && typeof token === "string") pinned = token;
}

const isWrite = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

export function installConnectionHeader(): void {
  const w = window as Window & { __consoleConnectionFetch?: true };
  if (w.__consoleConnectionFetch) return;
  w.__consoleConnectionFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    if (pinned === undefined || !isWrite(init?.method ?? request?.method ?? "GET")) return original(input, init);
    const url = new URL(request ? request.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return original(input, init);
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("x-console-connection", pinned);
    return original(input, { ...init, headers });
  };
}
