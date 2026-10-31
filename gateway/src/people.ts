// Who is speaking, on any platform. Owner rights come only from the
// OWNER_TELEGRAM_ID secret; people.yaml grants read-and-ask access.

import type { Person } from "./config";
import type { Ctx } from "./context";
import type { Role } from "./env";

export type Platform = "telegram" | "discord";

export function findPerson(ctx: Ctx, platform: Platform, id: string | number | undefined): Person | undefined {
  if (id === undefined || id === "") return undefined;
  const key = String(id);
  return (ctx.network.people ?? []).find((p) => (p[platform] ?? "") === key);
}

export function roleFor(ctx: Ctx, platform: Platform, id: string | number | undefined): Role | null {
  if (id === undefined || id === "") return null;
  const key = String(id);
  if (platform === "telegram" && key === ctx.env.OWNER_TELEGRAM_ID) return "owner";
  if (findPerson(ctx, platform, key)) return "member";
  if (platform === "telegram") {
    const legacy = (ctx.env.TSC_TELEGRAM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (legacy.includes(key)) return "member";
  }
  return null;
}

export function displayName(ctx: Ctx, platform: Platform, id: string | number | undefined): string {
  return findPerson(ctx, platform, id)?.name ?? `${platform} user ${id}`;
}

const ROLE_LABELS: Record<string, string> = { owner: "TSC chair", tsc_member: "TSC member", maintainer: "maintainer" };

/** "Jamie Shorten (maintainer of accordproject/concerto)", for Ada and /whoami. */
export function describePerson(ctx: Ctx, platform: Platform, id: string | number | undefined): string {
  const p = findPerson(ctx, platform, id);
  if (!p) return displayName(ctx, platform, id);
  const labels = (p.roles ?? []).map((r) =>
    r === "maintainer" && p.maintains?.length ? `maintainer of ${p.maintains.join(", ")}` : ROLE_LABELS[r] ?? r,
  );
  return labels.length ? `${p.name} (${labels.join(", ")})` : p.name;
}

