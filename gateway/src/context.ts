import { DEPLOYED, NETWORK, type DeployedConfig, type NetworkConfig } from "./config";
import { Db } from "./db";
import type { Env } from "./env";
import { GitHub } from "./github";
import { ManagedClient } from "./managed";
import { Telegram } from "./telegram";

export interface Ctx {
  env: Env;
  db: Db;
  tg: Telegram;
  managed: ManagedClient;
  network: NetworkConfig;
  deployed: DeployedConfig;
  ownerChatId: number;
  github: () => Promise<GitHub>;
  dryRun: boolean;
}

export function makeCtx(env: Env, overrides: Partial<Ctx> = {}): Ctx {
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
    dryRun: env.DRY_RUN !== "false",
    ...overrides,
  };
}

export const cap = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
