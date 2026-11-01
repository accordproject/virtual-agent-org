// Registers the Discord slash commands globally, so they work in the Accord Project
// server and in DMs with the bot (decision 34).
// Re-run when agents join (a new phase) so /ask and /pause list them.
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run discord:commands
//
// With DISCORD_GUILD_ID set, it also removes the server-only copies that earlier
// versions registered, which would otherwise show every command twice.

import { DiscordBot } from "../gateway/src/discordBot";
import { commandDefinitions } from "../gateway/src/discordInteractions";
import { compile } from "./compile";

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (and DISCORD_GUILD_ID to remove old server-only commands).");
  process.exit(1);
}
const network = compile();
const agents = Object.values(network.agents)
  .filter((a) => a.phase <= network.current_phase)
  .map((a) => a.name);
const defs = commandDefinitions(agents);
const bot = new DiscordBot(DISCORD_BOT_TOKEN, DISCORD_APP_ID);
const out = await bot.putGlobalCommands(defs);
console.log(`Registered ${out.length} commands for ${agents.join(", ")}: ${defs.map((d) => `/${d.name}`).join(" ")}`);
if (DISCORD_GUILD_ID) {
  await bot.putGuildCommands(DISCORD_GUILD_ID, []);
  console.log(`Removed the server-only commands from ${DISCORD_GUILD_ID}.`);
}
