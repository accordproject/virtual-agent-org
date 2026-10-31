// Validates the network configuration and writes gateway/src/generated/network.json.
// Run in CI on every PR: a config change that breaks an invariant fails the build.
//
//   npx tsx scripts/compile.ts          # validate and write
//   npx tsx scripts/compile.ts --check  # validate only

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOLS, ROOT, loadAll } from "./lib";

export const PERSON_ROLES = ["owner", "tsc_member", "maintainer"];

/** `role` may be one role or a list, e.g. `role: [tsc_member, maintainer]`. */
export function rolesOf(role: string | string[] | undefined): string[] {
  if (role === undefined || role === null) return [];
  return (Array.isArray(role) ? role : [role]).map((r) => String(r).trim()).filter(Boolean);
}

/** "concerto" → "accordproject/concerto"; full names pass through. */
export function fullRepo(repo: string, org: string): string {
  return repo.includes("/") ? repo : `${org}/${repo}`;
}

export function validate(cfg = loadAll()): string[] {
  const { network, models, permissions, schedules, mcp, specs, people, discord } = cfg;
  const errs: string[] = [];

  for (const [name, id] of Object.entries(discord.channels ?? {})) {
    if (id === undefined || id === null || id === "") continue;
    if (typeof id === "number") errs.push(`discord channel ${name}: quote the id, it is too long to be a number`);
    else if (!/^\d{5,20}$/.test(id)) errs.push(`discord channel ${name}: "${id}" should be digits only`);
  }

  const maxRisk = permissions.discord_approval_max_risk ?? "none";
  if (!["none", "low", "medium"].includes(maxRisk)) errs.push(`discord_approval_max_risk must be none, low or medium, not "${maxRisk}"`);

  for (const [k, v] of Object.entries(permissions.action_kinds)) {
    if (!["github", "discord", "discord_ops", "vimeo", "manual"].includes(v.executor)) errs.push(`action kind ${k}: unknown executor "${v.executor}"`);
  }

  const seenIds = new Set<string>();
  for (const [i, p] of (people.people ?? []).entries()) {
    const who = p.name || `people[${i}]`;
    if (!p.name) errs.push(`people[${i}]: name is required`);
    const roles = rolesOf(p.role);
    if (!roles.length) errs.push(`${who}: role is required`);
    for (const r of roles) if (!PERSON_ROLES.includes(r)) errs.push(`${who}: role "${r}" must be one of ${PERSON_ROLES.join(", ")}`);
    if (p.maintains !== undefined) {
      if (!Array.isArray(p.maintains)) errs.push(`${who}: maintains must be a list of repos`);
      else {
        if (!roles.includes("maintainer")) errs.push(`${who}: maintains is set but maintainer is not one of their roles`);
        for (const r of p.maintains) if (!/^([\w.-]+\/)?[\w.-]+$/.test(String(r))) errs.push(`${who}: "${r}" is not a repo name`);
      }
    }
    if (p.github && !/^[A-Za-z0-9-]{1,39}$/.test(p.github)) errs.push(`${who}: "${p.github}" is not a GitHub login`);
    for (const platform of ["discord", "telegram"] as const) {
      const id = p[platform];
      if (id === undefined || id === "") continue;
      if (typeof id === "number" && platform === "discord") errs.push(`${who}: quote the Discord id, it is too long to be a number`);
      if (!/^\d{5,20}$/.test(String(id))) errs.push(`${who}: ${platform} id "${id}" should be digits only`);
      const key = `${platform}:${id}`;
      if (seenIds.has(key)) errs.push(`${who}: ${platform} id ${id} is listed twice`);
      seenIds.add(key);
    }
  }
  const names = Object.keys(network.agents);

  for (const n of names) {
    const spec = specs[n];
    if (!spec) errs.push(`agents/${n}.md is missing`);
    else if (spec.phase !== network.agents[n]) errs.push(`${n}: spec phase ${spec.phase} ≠ network.yaml phase ${network.agents[n]}`);
    const m = models.agents[n];
    if (!m) errs.push(`${n}: no entry in models.yaml`);
    else {
      if (!models.tiers[m.default]) errs.push(`${n}: unknown default tier "${m.default}"`);
      for (const [task, tier] of Object.entries(m.tasks ?? {})) {
        if (!models.tiers[tier]) errs.push(`${n}.${task}: unknown tier "${tier}"`);
      }
    }
    const p = permissions.agents[n];
    if (!p) {
      errs.push(`${n}: no entry in permissions.yaml`);
      continue;
    }
    for (const k of p.requestable) if (!permissions.action_kinds[k]) errs.push(`${n}: unknown action kind "${k}"`);
    for (const t of p.builtin_tools) if (!BUILTIN_TOOLS.includes(t)) errs.push(`${n}: unknown built-in tool "${t}"`);
    for (const [server, { mode }] of Object.entries(Array.isArray(p.mcp_servers) ? {} : p.mcp_servers)) {
      if (!mcp.servers[server]) errs.push(`${n}: unknown MCP server "${server}"`);
      if (!mcp.modes[mode]) errs.push(`${n}.${server}: unknown mode "${mode}"`);
    }
  }
  for (const s of Object.keys(specs)) if (!names.includes(s)) errs.push(`agents/${s}.md is not listed in network.yaml`);

  // The Chief of Staff must have no side effects.
  const ada = permissions.agents.ada;
  if (ada && ((Array.isArray(ada.mcp_servers) ? ada.mcp_servers.length : Object.keys(ada.mcp_servers).length) || ada.builtin_tools.length)) {
    errs.push("ada must have no MCP servers or built-in tools");
  }

  const seen = new Set<string>();
  for (const s of schedules.schedules) {
    if (seen.has(s.name)) errs.push(`schedule ${s.name}: duplicate name`);
    seen.add(s.name);
    if (!names.includes(s.agent)) errs.push(`schedule ${s.name}: unknown agent "${s.agent}"`);
    if (s.cron.trim().split(/\s+/).length !== 5) errs.push(`schedule ${s.name}: cron must have 5 fields`);
    const hour = s.cron.trim().split(/\s+/)[1];
    if (/^[123]$/.test(hour)) errs.push(`schedule ${s.name}: avoid 01:00–03:00 local (DST)`);
    if (!(s.budget_usd > 0 && s.budget_usd <= 10)) errs.push(`schedule ${s.name}: budget_usd must be between 0 and 10`);
    if (s.tier && !models.tiers[s.tier]) errs.push(`schedule ${s.name}: unknown tier "${s.tier}"`);
  }
  return errs;
}

export function compile(cfg = loadAll()) {
  const { network, permissions, specs, people, discord } = cfg;
  const clean = (v: string | number | undefined) => (v === undefined || v === "" ? undefined : String(v));
  return {
    current_phase: network.network.current_phase,
    timezone: network.network.timezone,
    monthly_credit_usd: network.budgets.monthly_credit_usd,
    sandbox_repo: network.github.sandbox_repo,
    repos: network.github.repos ?? [],
    action_kinds: permissions.action_kinds,
    discord_approval_max_risk: permissions.discord_approval_max_risk ?? "none",
    discord_channels: Object.fromEntries(
      Object.entries(discord.channels ?? {}).filter(([, id]) => id !== undefined && id !== null && id !== "").map(([k, id]) => [k, String(id)]),
    ),
    people: (people.people ?? []).map((p) => ({
      name: p.name,
      roles: rolesOf(p.role),
      ...(p.maintains?.length ? { maintains: p.maintains.map((r) => fullRepo(String(r), network.github.org)) } : {}),
      ...(p.github ? { github: p.github } : {}),
      ...(clean(p.discord) ? { discord: clean(p.discord) } : {}),
      ...(clean(p.telegram) ? { telegram: clean(p.telegram) } : {}),
    })),
    agents: Object.fromEntries(
      Object.keys(network.agents).map((n) => [
        n,
        { name: n, title: specs[n].title, phase: network.agents[n], requestable: permissions.agents[n].requestable },
      ]),
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadAll();
  const errs = validate(cfg);
  if (errs.length) {
    console.error(`Config invalid:\n- ${errs.join("\n- ")}`);
    process.exit(1);
  }
  if (!process.argv.includes("--check")) {
    const out = join(ROOT, "gateway/src/generated/network.json");
    writeFileSync(out, JSON.stringify(compile(cfg), null, 2) + "\n");
    console.log(`Wrote ${out}`);
  } else {
    console.log("Config valid.");
  }
}
