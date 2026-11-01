// Vimeo API client for Otto (decision 18A). The token lives only in the gateway:
// Otto reads recordings and transcripts through gateway tools, and edits happen
// only after an approved vimeo.publish decision.
//
// Verified against the Vimeo API and the account's existing runbook
// (accordproject/vimeo-summary). VERIFY in first use: the chapters endpoint and
// the texttrack `link` field, which are not in the public docs we could read.

const API = "https://api.vimeo.com";

export interface VimeoVideo {
  id: string;
  name: string;
  description: string | null;
  created_time: string;
  duration: number; // seconds
  link: string;
  privacy: string; // view setting: anybody, nobody, unlisted, ...
}

export interface Chapter {
  title: string;
  /** Seconds from the start, or "mm:ss" / "hh:mm:ss". */
  start: number | string;
}

/** Recording titles the runbook treats as Tech WG meetings. */
const WG_PATTERNS = [/^tech wg \d{4}-\d{2}-\d{2}/i, /^ap tech wg \d{4}-\d{2}-\d{2}/i, /personal meeting room \d{4}-\d{2}-\d{2}/i, /^accord project tech wg/i];
export const isTechWg = (name: string) => WG_PATTERNS.some((p) => p.test(name.trim()));

export class Vimeo {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        authorization: `bearer ${this.token}`,
        accept: "application/vnd.vimeo.*+json;version=3.4",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vimeo ${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async recent(limit = 15): Promise<VimeoVideo[]> {
    const fields = "uri,name,description,created_time,duration,link,privacy.view";
    const r = await this.call<{ data: RawVideo[] }>(
      "GET",
      `/me/videos?sort=date&direction=desc&per_page=${Math.min(Math.max(limit, 1), 50)}&fields=${fields}`,
    );
    return r.data.map(toVideo);
  }

  /** Fetches a video only if the authenticated account owns it. */
  async ownVideo(id: string): Promise<VimeoVideo> {
    if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a Vimeo video id`);
    return toVideo(await this.call<RawVideo>("GET", `/me/videos/${id}?fields=uri,name,description,created_time,duration,link,privacy.view`));
  }

  /** The best caption track's text, as "[mm:ss] text" lines. */
  async transcript(id: string): Promise<string> {
    await this.ownVideo(id);
    const r = await this.call<{ data: { id: number; type: string; active?: boolean; link?: string; language?: string }[] }>(
      "GET",
      `/videos/${id}/texttracks`,
    );
    const track = r.data.find((t) => t.active && t.link) ?? r.data.find((t) => t.link);
    if (!track?.link) throw new Error("This video has no captions or transcript yet. Vimeo may still be generating them.");
    const res = await this.fetchImpl(track.link);
    if (!res.ok) throw new Error(`Could not download the transcript: ${res.status}`);
    return vttToLines(await res.text());
  }

  async edit(id: string, fields: { name?: string; description?: string; privacy?: { view: string } }) {
    await this.call("PATCH", `/videos/${id}`, fields);
  }

  async addChapter(id: string, title: string, seconds: number) {
    await this.call("POST", `/videos/${id}/chapters`, { title, timecode: toTimecode(seconds) });
  }
}

interface RawVideo {
  uri: string;
  name: string;
  description: string | null;
  created_time: string;
  duration: number;
  link: string;
  privacy?: { view?: string };
}

function toVideo(v: RawVideo): VimeoVideo {
  return {
    id: v.uri.split("/").pop() ?? "",
    name: v.name,
    description: v.description,
    created_time: v.created_time,
    duration: v.duration,
    link: v.link,
    privacy: v.privacy?.view ?? "unknown",
  };
}

/** "75", 75, "1:15" or "00:01:15" → 75 seconds. */
export function toSeconds(start: number | string): number {
  if (typeof start === "number") return Math.floor(start);
  const parts = start.trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) throw new Error(`Bad chapter time "${start}"`);
  return Math.floor(parts.reduce((acc, n) => acc * 60 + n, 0));
}

/** 75 → "00:01:15.000", the format Vimeo chapters use. */
export function toTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
}

/** WebVTT → "[mm:ss] text" lines, merging repeated captions. */
export function vttToLines(vtt: string): string {
  const out: string[] = [];
  let last = "";
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const start = lines[i].split("-->")[0].trim();
    const text = lines
      .slice(i + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === last) continue;
    last = text;
    const secs = toSeconds(start.replace(/\.\d+$/, ""));
    const mm = Math.floor(secs / 60);
    out.push(`[${String(mm).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}] ${text}`);
  }
  return out.join("\n");
}
