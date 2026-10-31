// Validates the network configuration and writes gateway/src/generated/network.json.
// Run in CI on every PR: a config change that breaks an invariant fails the build.
//
//   npx tsx scripts/compile.ts          # validate and write
//   npx tsx scripts/compile.ts --check  # validate only

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOLS, ROOT, loadAll } from "./lib";

export function validate(cfg = loadAll()): string[] {
  const { network, models, permissions, schedules, mcp, specs } = cfg;
  const errs: string[] = [];
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
  const { network, permissions, specs } = cfg;
  return {
    current_phase: network.network.current_phase,
    timezone: network.network.timezone,
    monthly_credit_usd: network.budgets.monthly_credit_usd,
    sandbox_repo: network.github.sandbox_repo,
    repos: network.github.repos ?? [],
    action_kinds: permissions.action_kinds,
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
