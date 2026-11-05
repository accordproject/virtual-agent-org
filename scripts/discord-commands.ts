// Registers the Discord slash commands globally, so they work in the Accord Project
// server and in DMs with the bot (decision 34).
// Re-run when agents join or change role, so /ask and /pause list them. The deploy
// workflow does this after a merge when the bot's secrets are set (decision 58).
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run discord:commands
//   npm run discord:commands -- --dry-run    # print the agent choices only
//
// With DISCORD_GUILD_ID set, it also removes the server-only copies that earlier
// versions registered, which would otherwise show every command twice.

import { DiscordBot } from "../gateway/src/discordBot";
import { commandDefinitions } from "../gateway/src/discordInteractions";
import { compile } from "./compile";

const network = compile();
const agents = Object.values(network.agents)
  .filter((a) => a.phase <= network.current_phase)
  .map((a) => ({ name: a.name, title: a.title }));
const defs = commandDefinitions(agents);
const names = defs.map((d) => ("type" in d && d.type === 3 ? `"${d.name}" (message menu)` : `/${d.name}`)).join(" ");
if (process.argv.includes("--dry-run")) {
  console.log(`Would register ${names} for ${agents.map((a) => `${a.name} (${a.title})`).join(", ")}.`);
  process.exit(0);
}

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (and DISCORD_GUILD_ID to remove old server-only commands).");
  process.exit(1);
}
const bot = new DiscordBot(DISCORD_BOT_TOKEN, DISCORD_APP_ID);
const out = await bot.putGlobalCommands(defs);
console.log(`Registered ${out.length} commands for ${agents.map((a) => a.name).join(", ")}: ${names}`);
if (DISCORD_GUILD_ID) {
  await bot.putGuildCommands(DISCORD_GUILD_ID, []);
  console.log(`Removed the server-only commands from ${DISCORD_GUILD_ID}.`);
}
