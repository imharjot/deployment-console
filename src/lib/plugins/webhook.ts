// Generic webhook: POST the event JSON to any URL. With a signing secret, receivers verify
// X-Console-Signature = "sha256=" + hex(HMAC-SHA256(secret, raw body)) — the same scheme as GitHub's X-Hub-Signature-256.
import { createHmac } from "node:crypto";
import type { ConsoleEvent } from "./events.ts";
import { UA, send, type Req } from "./http.ts";
import type { Config, Plugin } from "./types.ts";

export const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export function webhookRequest(cfg: Config, e: ConsoleEvent): Req {
  const body = JSON.stringify(e);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": UA, "X-Console-Event": e.type };
  if (cfg.secret) headers["X-Console-Signature"] = sign(cfg.secret, body);
  return { method: "POST", url: cfg.url, headers, body };
}

const post = async (cfg: Config, e: ConsoleEvent) => {
  await send("Webhook", webhookRequest(cfg, e));
};

export const webhook: Plugin = {
  id: "webhook",
  name: "Webhook",
  description: "POST every event as JSON to your own endpoint, optionally HMAC-signed.",
  icon: "webhook",
  capabilities: ["notify"],
  fields: [
    { key: "url", label: "Endpoint URL", type: "secret", required: true, placeholder: "https://example.com/hooks/console", help: "Stored encrypted — URLs often embed a token." },
    { key: "secret", label: "Signing secret", type: "secret", placeholder: "optional", help: "Adds X-Console-Signature: sha256=<hex HMAC of the body>." },
  ],
  async test(cfg) {
    await post(cfg, { type: "test", at: Date.now(), url: "", message: "Test delivery from the deployment console." });
    return "Test event delivered";
  },
  notify: post,
};
