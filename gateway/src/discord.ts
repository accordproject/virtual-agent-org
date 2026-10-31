// Posts approved announcements to Discord through a channel webhook.
// The webhook URL comes only from the DISCORD_ANNOUNCE_WEBHOOK_URL secret,
// never from an agent's payload.

import { splitText } from "./telegram";

export const AGENT_LABEL = "Drafted by an Accord Project agent, reviewed by a maintainer.";
const DISCORD_LIMIT = 2000;

/** Adds the agent label as Discord small text if the draft doesn't already carry it. */
export function withLabel(text: string): string {
  const t = text.trim();
  return t.includes(AGENT_LABEL) ? t : `${t}\n\n-# ${AGENT_LABEL}`;
}

export function isDiscordWebhook(url: string): boolean {
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);
}

/** Posts text, split into Discord-sized messages. Returns how many were sent. */
export async function postToDiscord(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<number> {
  if (!isDiscordWebhook(webhookUrl)) throw new Error("DISCORD_ANNOUNCE_WEBHOOK_URL is not a Discord webhook URL");
  const chunks = splitText(withLabel(text), DISCORD_LIMIT);
  for (const content of chunks) {
    const res = await fetchImpl(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No @everyone, @here, role or user pings from agent-drafted text.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return chunks.length;
}
