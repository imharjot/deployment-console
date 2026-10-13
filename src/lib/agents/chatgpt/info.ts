// What the Connections screen says about a ChatGPT-plan connection. Kept free of imports so a client component can use
// it (oauth.ts re-exports it for the server).

// Shown with the connection form and in the docs. Eligibility is OpenAI's decision; CONSOLE_CHATGPT_PLAN=eligible only
// says the person running this console believes their installation qualifies.
export const ELIGIBILITY_NOTE =
  "ChatGPT plan usage is offered by OpenAI for open-source apps and personal projects running locally (and self-hosted VMs of an eligible open-source app). " +
  "A shared or hosted console isn't assumed eligible: paid or remotely hosted offerings need OpenAI's approval. " +
  "Usage counts against your own ChatGPT plan's allowance; the console never falls back to API billing.";

// ChatGPT → Settings → Usage: where a person reviews and caps each app's use of their plan. The console links there and
// never shows a remaining quota (it can't read one).
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const CHATGPT_START_PATH = "/api/agents/oauth/chatgpt/start";

// The account a plan connection is bound to, as the connection list shows it: the provider's opaque subject and the
// plan type when the sign-in said — never an email, never a quota.
export function planAccountLabel(a: { subject?: string; plan?: string } | undefined): string {
  if (!a?.subject) return "ChatGPT account (not signed in)";
  const sub = a.subject.length > 14 ? `${a.subject.slice(0, 6)}…${a.subject.slice(-4)}` : a.subject;
  return `ChatGPT ${a.plan ? `${a.plan} ` : ""}account ${sub}`;
}
