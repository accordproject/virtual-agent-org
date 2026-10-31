import { DEPLOYED, NETWORK, type DeployedConfig, type NetworkConfig } from "./config";
import { Db } from "./db";
import { DiscordBot } from "./discordBot";
import type { Env } from "./env";
import { GitHub } from "./github";
import { ManagedClient } from "./managed";
import { Telegram } from "./telegram";
import { Vimeo } from "./vimeo";

export interface Ctx {
  env: Env;
  db: Db;
  tg: Telegram;
  managed: ManagedClient;
  network: NetworkConfig;
  deployed: DeployedConfig;
  ownerChatId: number;
  github: () => Promise<GitHub>;
  /** Discord bot for DMs and decision cards; null when not configured. */
  dc: DiscordBot | null;
  ownerDiscordId?: string;
  /** Public announcements channel; `post` returns the number of Discord messages sent. */
  discord: { configured: boolean; post: (text: string) => Promise<number> };
  /** Private #agent-ops channel; `post` pings only the given Discord user ids. */
  discordOps: { configured: boolean; post: (text: string, mentionIds: string[]) => Promise<number> };
  /** Vimeo client; throws if the token isn't set. */
  vimeo: () => Vimeo;
  dryRun: boolean;
}

export function makeCtx(env: Env, overrides: Partial<Ctx> = {}): Ctx {
  const dc = env.DISCORD_BOT_TOKEN && env.DISCORD_APP_ID ? new DiscordBot(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID) : null;
  const channels = NETWORK.discord_channels ?? {};
  return {
    env,
    db: new Db(env.DB),
    tg: new Telegram(env.TELEGRAM_BOT_TOKEN),
    managed: new ManagedClient(env.ANTHROPIC_API_KEY),
    network: NETWORK,
    deployed: DEPLOYED,
    ownerChatId: Number(env.OWNER_TELEGRAM_ID),
    github: async () => {
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_INSTALLATION_ID) {
        throw new Error("Gateway GitHub App secrets are not set");
      }
      return GitHub.forInstallation(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_INSTALLATION_ID);
    },
    dc,
    ownerDiscordId: env.OWNER_DISCORD_ID || undefined,
    discord: {
      configured: !!dc && !!channels.announcements,
      post: (text) => dc!.post(channels.announcements!, text),
    },
    discordOps: {
      configured: !!dc && !!channels.agent_ops,
      post: (text, ids) => dc!.post(channels.agent_ops!, text, ids),
    },
    vimeo: () => {
      if (!env.VIMEO_ACCESS_TOKEN) throw new Error("VIMEO_ACCESS_TOKEN is not set in the gateway");
      return new Vimeo(env.VIMEO_ACCESS_TOKEN);
    },
    dryRun: env.DRY_RUN !== "false",
    ...overrides,
  };
}

export const cap = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
