// Helpers for the repos in scope: adding one to config/network.yaml, writing the
// list into the shared context, and checking a repo's workflows (decision 20).

import { parse, parseDocument, isSeq } from "yaml";

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The line in context/accord.md that deploy replaces with the repos in scope. */
export const REPOS_MARKER = "<!-- repos in scope: generated from config/network.yaml -->";

/**
 * Adds `repo` to github.repos in the text of network.yaml, keeping comments.
 * Returns null when it is already there (case-insensitive).
 */
export function addRepoToNetworkYaml(text: string, repo: string): string | null {
  const doc = parseDocument(text);
  const repos = doc.getIn(["github", "repos"], true);
  if (!isSeq(repos)) throw new Error("config/network.yaml: github.repos must be a list");
  const existing = repos.items.map((n) => String((n as { value?: unknown }).value ?? n).toLowerCase());
  if (existing.includes(repo.toLowerCase())) return null;
  repos.add(doc.createNode(repo));
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** context/accord.md with the marker line replaced by the repos in scope. */
export function renderContext(text: string, repos: string[], sandbox: string): string {
  if (!text.includes(REPOS_MARKER)) throw new Error(`context/accord.md: missing the line ${REPOS_MARKER}`);
  const lines = repos.map((r) => `- ${r}`);
  if (sandbox) lines.push(`- ${sandbox} (for testing the network itself)`);
  return text.replace(REPOS_MARKER, lines.join("\n"));
}

const HOSTED_RUNNER = /^(ubuntu|windows|macos)-[\w.-]+$/;

interface Job {
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> & { include?: Record<string, unknown>[] } };
}

/** The runner labels a job may use, or null when they can't be worked out statically. */
function runnerLabels(job: Job): string[] | null {
  const runsOn = job["runs-on"];
  const labels = typeof runsOn === "string" ? [runsOn] : Array.isArray(runsOn) ? runsOn.map(String) : null;
  if (!labels) return null;
  const out: string[] = [];
  for (const label of labels) {
    const m = label.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
    if (!m) {
      if (label.includes("${{")) return null;
      out.push(label);
      continue;
    }
    // ${{ matrix.os }}: the values listed under strategy.matrix.os and its include entries.
    const matrix = job.strategy?.matrix ?? {};
    const values = [matrix[m[1]], ...(matrix.include ?? []).map((i) => i?.[m[1]])].flat().filter((v) => v !== undefined);
    if (!values.length || values.some((v) => typeof v !== "string" || v.includes("${{"))) return null;
    out.push(...(values as string[]));
  }
  return out;
}

/**
 * What in a workflow file breaks decision 20's premise that approving a fork PR's
 * CI is safe: pull_request_target triggers and runners that aren't GitHub-hosted.
 * A runner that can't be worked out statically is reported for checking by hand.
 */
export function workflowRisks(text: string): string[] {
  let wf: { on?: unknown; jobs?: Record<string, Job> };
  try {
    wf = parse(text) ?? {};
  } catch {
    return ["could not parse the workflow; check it by hand"];
  }
  const risks: string[] = [];
  const on = wf.on;
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(on ?? {});
  if (triggers.includes("pull_request_target")) risks.push("uses pull_request_target");
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    if (!job?.["runs-on"]) continue; // reusable workflow call
    const labels = runnerLabels(job);
    if (!labels) risks.push(`job ${name} picks its runner from an expression; check it by hand`);
    else {
      const other = labels.filter((l) => !HOSTED_RUNNER.test(l));
      if (other.length) risks.push(`job ${name} runs on ${other.join(", ")}, not a GitHub-hosted runner`);
    }
  }
  return risks;
}
