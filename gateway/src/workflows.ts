// What in a repo's GitHub Actions workflows makes approving a fork PR's CI unsafe
// (decision 20). Used by the gateway before it approves CI without Matt, and by
// scripts/repo-add.ts before a repo comes into scope.

import { parse } from "yaml";

const HOSTED_RUNNER = /^(ubuntu|windows|macos)-[\w.-]+$/i;

interface Job {
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> & { include?: Record<string, unknown>[] } };
}

interface Workflow {
  on?: unknown;
  jobs?: Record<string, Job>;
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

function parseWorkflow(text: string): Workflow | null {
  try {
    return (parse(text) as Workflow) ?? {};
  } catch {
    return null;
  }
}

function triggers(wf: Workflow): string[] {
  const on = wf.on;
  return typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(on ?? {});
}

/**
 * What in a workflow file breaks decision 20's premise that approving a fork PR's
 * CI is safe: pull_request_target triggers and runners that aren't GitHub-hosted.
 * A runner that can't be worked out statically is reported for checking by hand.
 */
export function workflowRisks(text: string): string[] {
  const wf = parseWorkflow(text);
  if (!wf) return ["could not parse the workflow; check it by hand"];
  const risks: string[] = [];
  if (triggers(wf).includes("pull_request_target")) risks.push("uses pull_request_target");
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

/**
 * Weaker signs that a fork PR's CI could reach something privileged: a workflow_run
 * trigger, which runs with the base repo's secrets after a PR's CI and may read its
 * artifacts, and secrets other than GITHUB_TOKEN in a workflow pull_request triggers.
 * repo:add warns about these; the gateway won't approve CI by itself while any remain.
 */
export function workflowWarnings(text: string): string[] {
  const wf = parseWorkflow(text);
  if (!wf) return [];
  const on = triggers(wf);
  const warnings: string[] = [];
  if (on.includes("workflow_run")) warnings.push("uses workflow_run, which runs with the repo's secrets after other workflows");
  if (on.includes("pull_request")) {
    // Comments can mention secrets without using them.
    const code = text.replace(/(^|\s)#.*$/gm, "$1");
    const names = [...code.matchAll(/\bsecrets\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]).filter((n) => n !== "GITHUB_TOKEN");
    if (/\bsecrets:\s*inherit\b/.test(code)) names.push("inherit");
    if (names.length) warnings.push(`pull_request workflow uses secrets (${[...new Set(names)].join(", ")})`);
  }
  return warnings;
}
