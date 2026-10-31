export interface Env {
  DB: D1Database;

  // Telegram
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string; // checked against X-Telegram-Bot-Api-Secret-Token
  OWNER_TELEGRAM_ID: string; // numeric user id; also the chat id for direct messages
  TSC_TELEGRAM_IDS?: string; // comma-separated numeric ids (Phase 3+)

  // Claude Managed Agents (Console org linked to the Max plan)
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_WEBHOOK_SECRET: string; // whsec_...

  // GitHub App used ONLY by the gateway to execute approved actions
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_INSTALLATION_ID?: string;

  // "true" until the Phase 0 gate: approved actions are logged, not executed
  DRY_RUN?: string;
}

export type Role = "owner" | "tsc_member";
