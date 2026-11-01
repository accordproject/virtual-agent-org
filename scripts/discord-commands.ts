// Registers the Discord slash commands in the Accord Project server.
// Re-run when agents join (a new phase) so /ask and /pause list them.
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:commands

import { DiscordBot } from "../gateway/src/discordBot";
import { commandDefinitions } from "../gateway/src/discordInteractions";
import { compile } from "./compile";

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
  console.error("Set DISCORD_APP_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.");
  process.exit(1);
}
const network = compile();
const agents = Object.values(network.agents)
  .filter((a) => a.phase <= network.current_phase)
  .map((a) => a.name);
const defs = commandDefinitions(agents);
const out = await new DiscordBot(DISCORD_BOT_TOKEN, DISCORD_APP_ID).putGuildCommands(DISCORD_GUILD_ID, defs);
console.log(`Registered ${out.length} commands for ${agents.join(", ")}: ${defs.map((d) => `/${d.name}`).join(" ")}`);
