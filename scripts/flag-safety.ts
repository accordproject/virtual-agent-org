// Flags changed files that hold the network's safety rules, so a reviewer looks
// twice. Reads file names from stdin, one per line. Always exits 0: it warns, it
// doesn't block.
import { appendFileSync, readFileSync } from "node:fs";

export const SAFETY_PATHS = [
  "config/permissions.yaml",
  "gateway/src/actions.ts",
  "gateway/src/review.ts",
  "gateway/src/workflows.ts",
  "gateway/src/risk.ts",
  "gateway/src/schema.ts",
  "gateway/src/changes.ts",
  "scripts/compile.ts",
  "agents/mechanic.md",
  ".github/",
];

export function flagged(paths: string[]): string[] {
  return paths.filter((p) => SAFETY_PATHS.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = flagged(readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  for (const f of files) console.log(`::warning file=${f}::This PR changes a safety file. Review it with care.`);
  const summary = files.length
    ? `### Safety files changed\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n`
    : "No safety files changed.\n";
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else console.log(summary);
}
