import { cap } from "./context";
import type { Decision } from "./db";
import type { DiscordButton, DiscordEmbed, DiscordPayload } from "./discordBot";
import { splitText } from "./telegram";
import type { InlineButton } from "./telegram";

const RISK = { low: "low risk", medium: "medium risk", high: "HIGH RISK" } as Record<string, string>;

export function decisionCard(d: Decision): string {
  const lines = [
    `${d.id} · ${cap(d.agent)} · ${d.kind} · ${RISK[d.risk] ?? d.risk}`,
    "",
    d.summary,
    "",
    d.rationale,
    "",
    `Target: ${d.target}`,
  ];
  const payload = safeJson(d.payload);
  const text = payloadText(payload);
  if (typeof payload.name === "string" && payload.name) lines.push("", `Title: ${payload.name}`);
  if (text) lines.push("", "Content:", text);
  if (Array.isArray(payload.chapters) && payload.chapters.length) {
    lines.push("", "Chapters:", ...payload.chapters.slice(0, 15).map((c: any) => `${c.start}  ${c.title}`));
  }
  if (payload.make_public === true) lines.push("", "⚠ Makes the video PUBLIC on Vimeo");
  if (Array.isArray(payload.mention) && payload.mention.length) {
    lines.push("", `Pings: ${payload.mention.map((m) => `@${String(m).replace(/^@/, "")}`).join(", ")}`);
  }
  if (d.status !== "open") lines.push("", `Status: ${d.status}${d.note ? ` — note: ${d.note}` : ""}`);
  if (d.result) lines.push(`Result: ${d.result}`);
  return lines.join("\n");
}

export function decisionButtons(d: Decision): InlineButton[][] {
  if (d.status === "open") {
    return [
      [
        { text: "Approve", callback_data: `a:${d.id}` },
        { text: "Reject", callback_data: `r:${d.id}` },
        { text: "Ask Ada", callback_data: `k:${d.id}` },
      ],
    ];
  }
  if (d.status === "approved") return [[{ text: "Mark done", callback_data: `x:${d.id}` }]];
  return [];
}

/** Text the owner needs to copy for a manual action, if the payload carries any. */
export function payloadText(payload: Record<string, unknown>): string {
  for (const k of ["text", "body", "content", "post", "message", "description"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function safeJson(s: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(s ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function lines(items: string[]): string {
  return items.length ? items.join("; ") : "—";
}

/** Discord buttons; custom_id carries the action and decision id, as on Telegram. */
export function discordButtons(d: Decision): DiscordButton[] {
  if (d.status === "open") {
    return [
      { label: "Approve", custom_id: `a:${d.id}`, style: 3 },
      { label: "Reject", custom_id: `r:${d.id}`, style: 4 },
      { label: "Ask Ada", custom_id: `k:${d.id}`, style: 2 },
    ];
  }
  if (d.status === "approved") return [{ label: "Mark done", custom_id: `x:${d.id}`, style: 1 }];
  return [];
}

const RISK_COLOUR: Record<string, number> = { low: 0x2e9e5b, medium: 0xe0a100, high: 0xd03b3b };
const STATUS_ICON: Record<string, string> = { open: "🟡", approved: "✅", executed: "✅", rejected: "❌", failed: "⚠️" };

/**
 * The Discord card: a readable summary as the message, and the full content the
 * decision would publish in embeds (Discord allows 6,000 characters there, against
 * 2,000 in a message), so nothing is cut off.
 */
export function discordCard(d: Decision): DiscordPayload {
  const payload = safeJson(d.payload);
  const head = [
    `${STATUS_ICON[d.status] ?? "•"} **${d.id} · ${cap(d.agent)} · ${d.kind}** · ${RISK[d.risk] ?? d.risk}`,
    `**${d.summary}**`,
    d.rationale,
    `-# ${d.target}`,
  ];
  if (typeof payload.name === "string" && payload.name) head.push(`**Title:** ${payload.name}`);
  if (payload.make_public === true) head.push("⚠ **Makes the video PUBLIC on Vimeo**");
  if (Array.isArray(payload.mention) && payload.mention.length) {
    head.push(`**Pings:** ${payload.mention.map((m) => `@${String(m).replace(/^@/, "")}`).join(", ")}`);
  }
  if (d.status !== "open") head.push(`**Status:** ${d.status}${d.note ? ` — ${d.note}` : ""}`);
  if (d.result) head.push(`**Result:** ${d.result}`);

  let content = head.join("\n");
  if (content.length > 1990) {
    // Shorten the rationale, never the decision line or status.
    const over = content.length - 1990 + 2;
    head[2] = `${d.rationale.slice(0, Math.max(0, d.rationale.length - over))}…`;
    content = head.join("\n");
  }

  const text = payloadText(payload);
  const embeds: DiscordEmbed[] = [];
  if (text) {
    let budget = 5900;
    const parts = splitText(text, 4000);
    for (const [i, part] of parts.entries()) {
      if (budget <= 0 || embeds.length === 10) break;
      const body = part.length > budget ? `${part.slice(0, budget - 40)}\n… (cut at Discord's limit)` : part;
      embeds.push({ ...(i === 0 ? { title: "Content" } : {}), description: body, color: RISK_COLOUR[d.risk] });
      budget -= body.length + (i === 0 ? 7 : 0);
    }
  }
  return { content, buttons: discordButtons(d), embeds };
}
