// Helpers for the repos in scope: adding one to config/network.yaml, writing the
// list into the shared context, and checking a repo's workflows (decision 20).

import { parseDocument, isSeq } from "yaml";

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

// The workflow checks live with the gateway, which runs them too before approving CI.
export { workflowRisks, workflowWarnings } from "../gateway/src/workflows";
