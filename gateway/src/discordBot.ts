// Discord bot REST client and interaction signature check.
// Every message sets allowed_mentions to none: nothing the network posts can ping anyone.

import { composePost } from "./discord";
import { splitText } from "./telegram";

const API = "https://discord.com/api/v10";
const LIMIT = 2000;

export interface DiscordButton {
  label: string;
  custom_id: string;
  style: 1 | 2 | 3 | 4; // primary, secondary, success, danger
}

export interface DiscordEmbed {
  title?: string;
  description: string;
  color?: number;
}

export interface DiscordPayload {
  content: string;
  buttons?: DiscordButton[];
  /** Up to 10; each description up to 4,096 characters, 6,000 in total. */
  embeds?: DiscordEmbed[];
}

export function toMessage(p: DiscordPayload) {
  return {
    content: p.content.length > LIMIT ? `${p.content.slice(0, LIMIT - 20)}\n… (cut short)` : p.content,
    embeds: p.embeds ?? [],
    allowed_mentions: { parse: [] },
    components: p.buttons?.length ? [{ type: 1, components: p.buttons.map((b) => ({ type: 2, ...b })) }] : [],
  };
}

export class DiscordBot {
  constructor(
    private token: string,
    private appId: string,
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          ...(auth ? { authorization: `Bot ${this.token}` } : {}),
          "content-type": "application/json",
          "user-agent": "DiscordBot (https://github.com/accordproject/virtual-agent-org, 1)",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt === 0) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Number(body.retry_after ?? 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Discord ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new Error(`Discord ${method} ${path}: rate limited`);
  }

  async dmChannel(userId: string): Promise<string> {
    const ch = await this.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    return ch.id;
  }

  /** Sends a DM; long plain text is split. Returns where the last message landed. */
  async dm(userId: string, p: DiscordPayload): Promise<{ channelId: string; messageId: string }> {
    const channelId = await this.dmChannel(userId);
    // Long text is split; buttons and embeds go on the last part.
    const chunks = splitText(p.content, LIMIT - 10);
    let messageId = "";
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const msg = await this.call<{ id: string }>(
        "POST",
        `/channels/${channelId}/messages`,
        toMessage({ content: chunks[i], buttons: last ? p.buttons : undefined, embeds: last ? p.embeds : undefined }),
      );
      messageId = msg.id;
    }
    return { channelId, messageId };
  }

  /** Posts an agent's approved message to a channel. Returns how many messages were sent. */
  async post(channelId: string, text: string, mentionIds: string[] = []): Promise<number> {
    const { chunks, allowed_mentions } = composePost(text, mentionIds);
    for (const content of chunks) {
      await this.call("POST", `/channels/${channelId}/messages`, { content, allowed_mentions });
    }
    return chunks.length;
  }

  async edit(channelId: string, messageId: string, p: DiscordPayload) {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, toMessage(p));
  }

  /** Replaces the deferred reply to a slash command (interaction tokens last 15 minutes). */
  async editOriginal(interactionToken: string, p: string | DiscordPayload) {
    await this.call("PATCH", `/webhooks/${this.appId}/${interactionToken}/messages/@original`, toMessage(typeof p === "string" ? { content: p } : p), false);
  }

  /** Registers global slash commands, which can also work in DMs with the bot. */
  async putGlobalCommands(commands: unknown[]) {
    return this.call<unknown[]>("PUT", `/applications/${this.appId}/commands`, commands);
  }

  /** Replaces one server's own slash commands; an empty list removes them. */
  async putGuildCommands(guildId: string, commands: unknown[]) {
    return this.call<unknown[]>("PUT", `/applications/${this.appId}/guilds/${guildId}/commands`, commands);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** How far an interaction's signed timestamp may be from now, so a captured request can't be replayed later. */
const DISCORD_TOLERANCE_SECONDS = 5 * 60;

/** Discord signs every interaction with Ed25519 over timestamp + raw body. */
export async function verifyDiscord(
  publicKeyHex: string,
  headers: Headers,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const sig = headers.get("x-signature-ed25519");
  const ts = headers.get("x-signature-timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > DISCORD_TOLERANCE_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(sig), new TextEncoder().encode(ts + rawBody));
  } catch {
    return false;
  }
}
