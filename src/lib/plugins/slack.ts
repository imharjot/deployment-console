// Slack via an incoming webhook: POST JSON { text, blocks } → plain-text "ok".
// https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
// Blocks: https://docs.slack.dev/reference/block-kit/blocks/section-block/ · button: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
import { describe, type ConsoleEvent, type Tone } from "./events.ts";
import { jsonReq, send, type Req } from "./http.ts";
import type { Config, Plugin } from "./types.ts";

const EMOJI: Record<Tone, string> = { bad: ":red_circle:", warn: ":large_orange_circle:", ok: ":large_green_circle:", info: ":information_source:" };

// Slack mrkdwn needs only these three escaped.
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function slackMessage(e: ConsoleEvent) {
  const d = describe(e);
  const emoji = e.type === "action" && d.tone === "info" ? ":gear:" : e.type === "test" ? ":wave:" : EMOJI[d.tone];
  const links = d.links.filter((l) => l.url);
  // Empty `fields` or `elements` arrays are invalid Block Kit, so those blocks are only added when non-empty.
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: cut(`${emoji} *${esc(d.title)}*`, 3000) } }];
  if (d.fields.length) blocks.push({ type: "section", fields: d.fields.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: cut(`*${esc(k)}*\n${esc(v)}`, 2000) })) });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<!date^${Math.floor(e.at / 1000)}^{date_short_pretty} {time_secs}|${new Date(e.at).toISOString()}> · deployment console` }] });
  if (links.length) blocks.push({ type: "actions", elements: links.map((l, i) => ({ type: "button", text: { type: "plain_text", text: l.label }, url: l.url, action_id: `open_${i}`, ...(i === 0 ? { style: "primary" } : {}) })) });
  return { text: d.title, blocks }; // text = the notification preview and the fallback when blocks can't render
}

export const slackRequest = (webhookUrl: string, e: ConsoleEvent): Req => jsonReq("POST", webhookUrl, {}, slackMessage(e));

async function postToSlack(cfg: Config, e: ConsoleEvent) {
  const res = await send("Slack", slackRequest(cfg.webhookUrl, e));
  if (res.text.trim() !== "ok") throw new Error(`Slack: unexpected response "${res.text.slice(0, 80)}"`);
}

export const slack: Plugin = {
  id: "slack",
  name: "Slack",
  description: "Post alerts to a channel through an incoming webhook.",
  icon: "hash",
  docsUrl: "https://api.slack.com/messaging/webhooks",
  capabilities: ["notify"],
  fields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      type: "secret",
      required: true,
      placeholder: "https://hooks.slack.com/services/T000/B000/XXXX",
      help: "Slack → Apps → Incoming Webhooks → Add to a channel.",
    },
  ],
  async test(cfg) {
    await postToSlack(cfg, { type: "test", at: Date.now(), url: "", message: "If you can read this, Slack is connected." });
    return "Test message posted to Slack";
  },
  notify: postToSlack,
};
