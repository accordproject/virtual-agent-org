import { cap } from "./context";
import type { Decision } from "./db";
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
  if (text) lines.push("", "Content:", text);
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
  for (const k of ["text", "body", "content", "post", "message"]) {
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
