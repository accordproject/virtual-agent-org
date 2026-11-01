// How agent posts look on Discord. The app's bot posts them (decision 17A);
// see DiscordBot.post. Channels come from config/discord.yaml, never from an agent.

import { splitText } from "./telegram";

export const AGENT_LABEL = "Drafted by an Accord Project agent, reviewed by a maintainer.";
const DISCORD_LIMIT = 2000;

/** Adds the agent label as Discord small text if the draft doesn't already carry it. */
export function withLabel(text: string): string {
  const t = text.trim();
  return t.includes(AGENT_LABEL) ? t : `${t}\n\n-# ${AGENT_LABEL}`;
}

/**
 * Splits a post into Discord-sized messages. `mentionIds` are the only people
 * who can be pinged: they lead the first message, and nothing in the agent's
 * text can ping anyone else (no @everyone, @here, roles or other users).
 */
export function composePost(text: string, mentionIds: string[] = []) {
  const ids = [...new Set(mentionIds)].filter((id) => /^\d{5,20}$/.test(id)).slice(0, 25);
  const pings = ids.map((id) => `<@${id}>`).join(" ");
  const chunks = splitText(withLabel(pings ? `${pings}\n${text}` : text), DISCORD_LIMIT);
  return { chunks, allowed_mentions: { parse: [] as string[], users: ids } };
}
