// The integration plugin contract. Pure (no server-only) so plugins and their request builders can be unit-tested.
// Plugins receive plain, already-unsealed config values; storage, sealing and redaction live in src/lib/server/plugins.
import type { Redacted } from "./config.ts";
import type { ConsoleEvent, Subscription } from "./events.ts";

export type Capability = "notify" | "tickets";

export interface Field {
  key: string;
  label: string;
  type: "text" | "secret" | "url" | "select"; // "secret" values are sealed at rest and never sent back to the browser
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export type Config = Record<string, string>; // field key → value ("" when unset)

export interface TicketInput {
  title: string;
  body: string; // markdown
  env?: string;
  target?: string;
}

// `base` overrides the SaaS API origin. Tests only (mock server): routes never pass it and it is never a user field.
export interface Plugin {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon name
  docsUrl?: string;
  capabilities: Capability[];
  fields: Field[];
  test(cfg: Config, base?: string): Promise<string>; // human message on success; throws on failure
  notify?(cfg: Config, e: ConsoleEvent): Promise<void>;
  createTicket?(cfg: Config, t: TicketInput, base?: string): Promise<{ id: string; url: string }>;
}

// What GET /api/integrations returns per plugin. config/events/updated* are present for admins only.
export interface IntegrationView {
  id: string;
  name: string;
  description: string;
  icon: string;
  docsUrl?: string;
  capabilities: Capability[];
  fields: Field[];
  configured: boolean;
  enabled: boolean;
  lastDelivery?: { ok: boolean; at: number };
  config?: Redacted;
  events?: Subscription;
  updatedAt?: number;
  updatedBy?: string;
}
