// Discord slash commands and buttons (decision 15B).
//
// Anyone in people.yaml: /ada, /ask, /status, /queue (ask-only).
// The owner (OWNER_DISCORD_ID secret): also instructs Ada, approves low- and
// medium-risk decisions from DM buttons, and can /pause and /stop agents.
// Telegram only: high-risk decisions, paused tool calls, /resume, /revoke.
//
// Discord needs an answer within 3 seconds, so slow work runs in `later`.

import { AgentUnavailable, assertAvailable, discordApprovable, messageAgent, postDiscordCard } from "./agents";
import { cap, type Ctx } from "./context";
import { approve, askAda, markDone, pause, reject, stop } from "./controls";
import { describePerson, roleFor } from "./people";
import { toMessage } from "./discordBot";
import { gatherStatus, queueMarkdown, statusCards } from "./status";

const EPHEMERAL = 64;
const reply = (content: string) => ({ type: 4, data: { content: content.slice(0, 1990), flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
const DEFER_UPDATE = { type: 6 };
const DEFER_REPLY = { type: 5, data: { flags: EPHEMERAL } };

export interface Interaction {
  type: number;
  token: string;
  data?: {
    name?: string;
    options?: { name: string; value: string }[];
    custom_id?: string;
    components?: { components: { custom_id: string; value: string }[] }[];
  };
  member?: { user: { id: string } };
  user?: { id: string };
}

type Later = (work: Promise<unknown>) => void;

export async function handleInteraction(ctx: Ctx, i: Interaction, later: Later): Promise<object> {
  if (i.type === 1) return { type: 1 }; // PING

  const userId = i.member?.user.id ?? i.user?.id;
  const role = roleFor(ctx, "discord", userId);
  if (!userId || !role) {
    await ctx.db.audit({ event_type: "discord.unauthorised", detail: { user: userId } });
    return reply("You're not set up for the Accord agent network. Ask Matt to add you to people.yaml.");
  }
  const owner = role === "owner";

  // Background work that reports failure to the person by DM rather than losing it.
  const run = (work: () => Promise<unknown>) =>
    later(
      work().catch(async (e) => {
        await ctx.db.audit({ event_type: "gateway.discord_error", detail: { user: userId, error: String(e) } });
        await ctx.dc?.dm(userId, { content: `That didn't work: ${e instanceof Error ? e.message : String(e)}` }).catch(() => undefined);
      }),
    );

  if (i.type === 2) return command(ctx, i, userId, owner, run);
  if (i.type === 3) return button(ctx, i, userId, owner, run);
  if (i.type === 5) return modalSubmit(ctx, i, owner, run);
  return reply("Unsupported interaction.");
}

function opt(i: Interaction, name: string): string {
  return String(i.data?.options?.find((o) => o.name === name)?.value ?? "").trim();
}

async function command(ctx: Ctx, i: Interaction, userId: string, owner: boolean, run: (w: () => Promise<unknown>) => void) {
  const name = i.data?.name ?? "";
  const prefix = owner ? "" : `${describePerson(ctx, "discord", userId)} asks on Discord. They cannot instruct or approve; answer only.\n\n`;

  switch (name) {
    case "ada":
    case "ask": {
      const agent = name === "ada" ? "ada" : opt(i, "agent").toLowerCase();
      const text = opt(i, "message");
      if (!text) return reply("Add a message.");
      try {
        await assertAvailable(ctx, agent); // fast check so the answer is immediate
      } catch (e) {
        return reply(e instanceof AgentUnavailable ? e.message : String(e));
      }
      run(async () => {
        await messageAgent(ctx, agent, { discord: userId }, prefix + text);
        if (name === "ask") await ctx.db.audit({ agent, event_type: "owner.direct_ask", detail: { by: owner ? "owner" : "member", via: "discord" } });
      });
      return reply(`Sent to ${cap(agent)}. Replies will arrive in your DMs.`);
    }

    case "status":
      return { type: 4, data: { ...toMessage(statusCards(await gatherStatus(ctx))), flags: EPHEMERAL } };

    case "queue": {
      const open = await ctx.db.listDecisions({ status: "open" });
      let footer: string | undefined;
      if (owner && open.length) {
        const here = open.filter((d) => discordApprovable(ctx, d)).slice(0, 10);
        run(async () => {
          for (const d of here) await postDiscordCard(ctx, d);
        });
        const elsewhere = open.length - here.length;
        footer = `-# ${here.length} card${here.length === 1 ? "" : "s"} sent to your DMs.${elsewhere ? ` ${elsewhere} need Telegram (high risk, or beyond the first 10).` : ""}`;
      }
      return reply(queueMarkdown(open, footer));
    }

    case "pause":
    case "stop": {
      if (!owner) return reply("Only the owner can pause or stop agents.");
      const arg = opt(i, "agent").toLowerCase();
      const targets = arg === "all" && name === "stop" ? Object.keys(ctx.network.agents) : ctx.network.agents[arg] ? [arg] : [];
      if (!targets.length) return reply(`No agent called ${arg}.`);
      run(async () => {
        const out: string[] = [];
        for (const t of targets) out.push(await (name === "pause" ? pause : stop)(ctx, t));
        await ctx.db.audit({ event_type: `owner.${name}`, detail: { targets, via: "discord" } });
        await ctx.dc?.editOriginal(i.token, out.join("\n\n"));
      });
      return DEFER_REPLY;
    }

    default:
      return reply("Resume and revoke are Telegram-only. Try /ada, /ask, /status or /queue.");
  }
}

async function button(ctx: Ctx, i: Interaction, userId: string, owner: boolean, run: (w: () => Promise<unknown>) => void) {
  if (!owner) return reply("Only the owner can decide.");
  const [action, id] = (i.data?.custom_id ?? "").split(":");
  const d = id ? await ctx.db.getDecision(id) : null;
  if (!d) return reply("Decision not found.");

  switch (action) {
    case "a":
      if (!discordApprovable(ctx, d)) return reply(`${d.id} is ${d.risk} risk: approve it in Telegram.`);
      run(() => approve(ctx, d.id)); // refreshes the cards in both apps
      return DEFER_UPDATE;
    case "r":
      return {
        type: 9, // modal: optional note for the agent
        data: {
          custom_id: `rn:${d.id}`,
          title: `Reject ${d.id}`,
          components: [
            { type: 1, components: [{ type: 4, custom_id: "note", label: "Note for the agent (optional)", style: 2, required: false, max_length: 1000 }] },
          ],
        },
      };
    case "k":
      run(() => askAda(ctx, d.id, { discord: userId }));
      return reply(`Asked Ada about ${d.id}. Her answer will arrive here.`);
    case "x":
      run(() => markDone(ctx, d.id));
      return DEFER_UPDATE;
  }
  return reply("Unknown button.");
}

async function modalSubmit(ctx: Ctx, i: Interaction, owner: boolean, run: (w: () => Promise<unknown>) => void) {
  if (!owner) return reply("Only the owner can decide.");
  const [kind, id] = (i.data?.custom_id ?? "").split(":");
  if (kind !== "rn" || !id) return reply("Unknown form.");
  const note = i.data?.components?.[0]?.components?.[0]?.value?.trim() || undefined;
  run(() => reject(ctx, id, note));
  return DEFER_UPDATE;
}

/** Slash command definitions, registered by scripts/discord-commands.ts. */
/** Where commands work: the server and DMs with the bot (decision 34). */
const COMMAND_SCOPE = { contexts: [0, 1], integration_types: [0] };

export function commandDefinitions(agents: string[]) {
  const agentChoices = agents.map((a) => ({ name: cap(a), value: a }));
  const defs = [
    { name: "ada", description: "Message Ada, the Chief of Staff", options: [{ type: 3, name: "message", description: "What you want", required: true }] },
    {
      name: "ask",
      description: "Message one agent directly",
      options: [
        { type: 3, name: "agent", description: "Which agent", required: true, choices: agentChoices },
        { type: 3, name: "message", description: "What you want", required: true },
      ],
    },
    { name: "status", description: "Each agent's state, open work and spend" },
    { name: "queue", description: "Open decisions (the owner also gets approval cards by DM)" },
    { name: "pause", description: "Owner only: stop new work for an agent", options: [{ type: 3, name: "agent", description: "Which agent", required: true, choices: agentChoices }] },
    {
      name: "stop",
      description: "Owner only: interrupt an agent and reject its open decisions",
      options: [{ type: 3, name: "agent", description: "Which agent", required: true, choices: [...agentChoices, { name: "All agents", value: "all" }] }],
    },
  ];
  return defs.map((d) => ({ ...d, ...COMMAND_SCOPE }));
}
