// GitHub App auth and the few write operations the gateway performs after approval.

export interface RepoRef {
  owner: string;
  repo: string;
  number?: number;
}

/** Accepts "owner/repo", "owner/repo#123" or a github.com PR/issue URL. */
export function parseTarget(target: string): RepoRef | null {
  const url = target.match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:pull|issues)\/(\d+))?/);
  if (url) return { owner: url[1], repo: url[2], number: url[3] ? Number(url[3]) : undefined };
  const short = target.match(/^([\w.-]+)\/([\w.-]+)(?:#(\d+))?$/);
  if (short) return { owner: short[1], repo: short[2], number: short[3] ? Number(short[3]) : undefined };
  return null;
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GitHub App key is PKCS#1. Convert it: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem",
    );
  }
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function appJwt(appId: string, pem: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export class GitHub {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  static async forInstallation(appId: string, pem: string, installationId: string, fetchImpl: typeof fetch = fetch) {
    const jwt = await appJwt(appId, pem);
    const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "virtual-agent-org" },
    });
    if (!res.ok) throw new Error(`GitHub token mint failed: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    return new GitHub(token, fetchImpl);
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "virtual-agent-org",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  merge(r: Required<RepoRef>, method: "merge" | "squash" | "rebase" = "squash", sha?: string) {
    return this.call<{ merged: boolean; sha: string }>("PUT", `/repos/${r.owner}/${r.repo}/pulls/${r.number}/merge`, {
      merge_method: method,
      ...(sha ? { sha } : {}),
    });
  }

  close(r: Required<RepoRef>) {
    // The issues endpoint closes both issues and pull requests.
    return this.call("PATCH", `/repos/${r.owner}/${r.repo}/issues/${r.number}`, { state: "closed" });
  }

  comment(r: Required<RepoRef>, body: string) {
    return this.call<{ html_url: string }>("POST", `/repos/${r.owner}/${r.repo}/issues/${r.number}/comments`, { body });
  }

  release(r: RepoRef, p: { tag: string; name?: string; body?: string; target?: string; draft?: boolean }) {
    return this.call<{ html_url: string }>("POST", `/repos/${r.owner}/${r.repo}/releases`, {
      tag_name: p.tag,
      name: p.name ?? p.tag,
      body: p.body ?? "",
      ...(p.target ? { target_commitish: p.target } : {}),
      draft: p.draft ?? false,
    });
  }
}
