// Adds a repo to the network's scope, after checking the GitHub side is ready.
//
//   npm run repo:add accordproject/web-components               # check, then add to config/network.yaml
//   npm run repo:add accordproject/web-components --check-only  # check only
//
// It edits config/network.yaml and regenerates network.json; deploying stays a
// separate step. Credentials, all optional (a check without them prints "?"):
//   GITHUB_TOKEN, or a signed-in `gh`     reads the repo, its workflows and collaborators
//   GITHUB_APP_ID, GITHUB_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_FILE (PKCS#8 .pem)
//                                         checks the gateway app is installed on the repo
//
// Read-only agent tokens cover all the org's repos; tokens that can write list the
// repos in scope (decision 23), so it reminds you to add the repo to those.
//
// It refuses a repo whose workflows use pull_request_target or self-hosted runners,
// because Mira approves fork PRs' CI runs without asking (decision 20). Pass
// --accept-ci-risk once Matt has decided that is acceptable for the repo.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub } from "../gateway/src/github";
import { compile, validate } from "./compile";
import { ROOT, loadAll } from "./lib";
import { REPO_RE, addRepoToNetworkYaml, workflowRisks } from "./repos";

/** The account the agents' GitHub tokens belong to (decision 12). */
const AGENT_LOGIN = "mttrbrts-agent";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const CHECK_ONLY = args.includes("--check-only");
const ACCEPT_CI_RISK = args.includes("--accept-ci-risk");

if (!repo || !REPO_RE.test(repo)) {
  console.error("Usage: npm run repo:add owner/name [--check-only] [--accept-ci-risk]");
  process.exit(1);
}
const cfg = loadAll();
const org = cfg.network.github.org;
const [owner, name] = repo.split("/");
if (owner.toLowerCase() !== org.toLowerCase()) {
  console.error(`${repo} is outside the ${org} organisation, which the gateway app and the agents' role cover.`);
  process.exit(1);
}

function userToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
const token = userToken();

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "virtual-agent-org",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function appClient(): Promise<GitHub | undefined> {
  const { GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE } = process.env;
  if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY_FILE) return undefined;
  return GitHub.forInstallation(GITHUB_APP_ID, readFileSync(GITHUB_APP_PRIVATE_KEY_FILE, "utf8"), GITHUB_INSTALLATION_ID);
}

type Result = "ok" | "fail" | "unknown";
const results: { result: Result; text: string; fix?: string }[] = [];
const report = (result: Result, text: string, fix?: string) => results.push({ result, text, fix });
let blocked = false;

// 1. The repo exists and is live.
const info = await get<{ archived?: boolean; private?: boolean; full_name?: string }>(`/repos/${repo}`);
if (info.status !== 200) {
  console.error(`Can't read ${repo} (HTTP ${info.status}). Check the name${token ? "" : ", or set GITHUB_TOKEN"}.`);
  process.exit(1);
}
if (info.body.archived) {
  console.error(`${repo} is archived; the agents would have nothing to do there.`);
  process.exit(1);
}
report("ok", `${info.body.full_name} exists${info.body.private ? " (private)" : ""}`);

// 2. Decision 20: no pull_request_target or self-hosted runners.
const dir = await get<{ name: string; path: string; type: string }[]>(`/repos/${repo}/contents/.github/workflows`);
if (dir.status === 404) report("ok", "no GitHub Actions workflows");
else if (dir.status !== 200) report("unknown", `couldn't list workflows (HTTP ${dir.status})`);
else {
  const risks: string[] = [];
  for (const f of dir.body.filter((f) => f.type === "file" && /\.ya?ml$/.test(f.name))) {
    const file = await get<{ content?: string }>(`/repos/${repo}/contents/${f.path}`);
    const text = Buffer.from(file.body.content ?? "", "base64").toString("utf8");
    risks.push(...workflowRisks(text).map((r) => `${f.name}: ${r}`));
  }
  if (!risks.length) report("ok", `workflows use neither pull_request_target nor self-hosted runners (${dir.body.length} checked)`);
  else {
    if (!ACCEPT_CI_RISK) blocked = true;
    report(
      "fail",
      `workflows break decision 20's premise for Mira approving fork PRs' CI:\n      ${risks.join("\n      ")}`,
      ACCEPT_CI_RISK ? "accepted with --accept-ci-risk" : "ask Matt; rerun with --accept-ci-risk if he accepts it",
    );
  }
}

// 3. The gateway app can act on the repo.
try {
  const app = await appClient();
  if (!app) report("unknown", "gateway app installation not checked (set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE)", `https://github.com/organizations/${org}/settings/installations`);
  else {
    let found = false;
    for (let page = 1; !found; page++) {
      const r = await app.call<{ repositories: { full_name: string }[] }>("GET", `/installation/repositories?per_page=100&page=${page}`);
      found = r.repositories.some((x) => x.full_name.toLowerCase() === repo.toLowerCase());
      if (r.repositories.length < 100) break;
    }
    if (found) report("ok", "gateway app is installed on the repo");
    else report("fail", "gateway app is not installed on the repo; approved merges and comments would fail", `https://github.com/organizations/${org}/settings/installations`);
  }
} catch (e) {
  report("unknown", `gateway app installation not checked: ${String(e).slice(0, 200)}`);
}

// 4. The agents' account has Triage (decision 12).
const perm = await get<{ role_name?: string }>(`/repos/${repo}/collaborators/${AGENT_LOGIN}/permission`);
const accessUrl = `https://github.com/${repo}/settings/access`;
if (perm.status !== 200) report("unknown", `${AGENT_LOGIN}'s role not checked (HTTP ${perm.status}; needs a token with push access)`, accessUrl);
else if (["triage", "write", "maintain", "admin"].includes(perm.body.role_name ?? "")) {
  report(perm.body.role_name === "triage" ? "ok" : "fail", `${AGENT_LOGIN} has the ${perm.body.role_name} role${perm.body.role_name === "triage" ? "" : "; decision 12 says Triage"}`, perm.body.role_name === "triage" ? undefined : accessUrl);
} else report("fail", `${AGENT_LOGIN} has the ${perm.body.role_name ?? "no"} role; it needs Triage, and the invitation accepted`, accessUrl);

// 5. Guidance Mira reads before reviewing.
for (const [label, paths] of [
  ["AGENTS.md", ["AGENTS.md"]],
  ["CONTRIBUTING.md", ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]],
] as const) {
  let found = false;
  for (const p of paths) if ((await get(`/repos/${repo}/contents/${p}`)).status === 200) found = true;
  report(found ? "ok" : "fail", found ? `${label} found` : `no ${label}; Mira reviews with less guidance until one exists`);
}

// 6. Someone maintains it, so Mira knows whom to ask for review.
const maintainers = (compile(cfg).people ?? []).filter((p) => p.maintains?.some((r) => r.toLowerCase() === repo.toLowerCase()));
if (maintainers.length) report("ok", `maintained by ${maintainers.map((p) => p.name).join(", ")}`);
else report("fail", `nobody in config/people.yaml maintains it; Mira will ask any listed maintainer`, `add "${name}" to someone's maintains: list`);

const mark = { ok: "✓", fail: "✗", unknown: "?" };
console.log(`\nChecks for ${repo}\n`);
for (const r of results) console.log(`  ${mark[r.result]} ${r.text}${r.fix ? `\n      → ${r.fix}` : ""}`);
// Decision 23: read-only tokens cover all repos; tokens that can write list the repos in scope.
const writers = Object.entries(cfg.permissions.agents)
  .filter(([, p]) => !Array.isArray(p.mcp_servers) && p.mcp_servers.github && p.mcp_servers.github.mode !== "read")
  .filter(([agent]) => cfg.network.agents[agent] <= cfg.network.network.current_phase)
  .map(([agent]) => agent);
if (writers.length) {
  console.log(`
  Not checkable from here:
    - ${writers.join(", ")}'s GitHub token (as ${AGENT_LOGIN}) lists ${repo}; the others cover all repos
      → https://github.com/settings/personal-access-tokens (the token value doesn't change)
`);
}

if (CHECK_ONLY) process.exit(0);
if (blocked) {
  console.error(`Not added: see the workflow check above.`);
  process.exit(1);
}

const networkPath = join(ROOT, "config/network.yaml");
const updated = addRepoToNetworkYaml(readFileSync(networkPath, "utf8"), repo);
if (!updated) console.log(`${repo} is already in config/network.yaml.`);
else {
  writeFileSync(networkPath, updated);
  const next = loadAll();
  const errs = validate(next);
  if (errs.length) {
    console.error(`Config invalid after the edit:\n- ${errs.join("\n- ")}`);
    process.exit(1);
  }
  writeFileSync(join(ROOT, "gateway/src/generated/network.json"), JSON.stringify(compile(next), null, 2) + "\n");
  console.log(`Added ${repo} to config/network.yaml and regenerated network.json.`);
}
console.log(`
Next:
  1. Fix anything marked ✗ above.
  2. npm test, then open a PR with the change.
  3. Once merged: npm run gateway:deploy (the gateway's repo list)
     and npm run deploy:agents (the agents' shared context).`);
