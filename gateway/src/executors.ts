// Executes approved decisions. Critical credentials live here, never in agent sandboxes.

import type { Ctx } from "./context";
import type { Decision } from "./db";
import { payloadText, safeJson } from "./format";
import { parseTarget, type RepoRef } from "./github";
import { resolveMentions } from "./people";
import { toSeconds, type Chapter } from "./vimeo";

export interface ExecResult {
  ok: boolean;
  manual?: boolean; // the owner must now do it by hand, then tap "Mark done"
  result: string;
}

function inScope(ctx: Ctx, r: RepoRef): boolean {
  const full = `${r.owner}/${r.repo}`.toLowerCase();
  const allowed = [ctx.network.sandbox_repo, ...ctx.network.repos].filter(Boolean).map((s) => s.toLowerCase());
  return allowed.includes(full);
}

export async function executeDecision(ctx: Ctx, d: Decision): Promise<ExecResult> {
  // Tool confirmations: an MCP or built-in tool call paused under always_ask.
  if (d.kind === "tool.confirm") {
    if (!d.session_id || !d.tool_use_id) return { ok: false, result: "Missing session or tool use id" };
    await ctx.managed.sendToolConfirmation(d.session_id, d.tool_use_id, true);
    return { ok: true, result: "Tool call allowed" };
  }

  const kind = ctx.network.action_kinds[d.kind];
  if (!kind || kind.executor === "manual") {
    const text = payloadText(safeJson(d.payload));
    return {
      ok: true,
      manual: true,
      result: text ? "Approved. Copy the content above, do it, then tap Mark done." : "Approved. Do it, then tap Mark done.",
    };
  }

  if (kind.executor === "discord") {
    const text = payloadText(safeJson(d.payload));
    if (!text) return { ok: false, result: "No announcement text in payload" };
    if (!ctx.discord.configured) {
      return { ok: true, manual: true, result: "No announcements channel is set in config/discord.yaml. Copy the content above, post it, then tap Mark done." };
    }
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would post ${text.length} characters to Discord` };
    const n = await ctx.discord.post(text);
    return { ok: true, result: `Posted to Discord${n > 1 ? ` (${n} messages)` : ""}` };
  }

  if (kind.executor === "discord_ops") {
    const payload = safeJson(d.payload);
    const text = payloadText(payload);
    if (!text) return { ok: false, result: "No message text in payload" };
    const m = resolveMentions(ctx, payload.mention);
    if (m.missing.length) {
      return { ok: false, result: `Can't ping ${m.missing.join(", ")}: not in people.yaml with a Discord id` };
    }
    if (!ctx.discordOps.configured) {
      return { ok: true, manual: true, result: "No agent_ops channel is set in config/discord.yaml. Copy the content above, post it, then tap Mark done." };
    }
    const who = m.names.length ? ` pinging ${m.names.join(", ")}` : "";
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would post to #agent-ops${who}` };
    await ctx.discordOps.post(text, m.ids);
    return { ok: true, result: `Posted to #agent-ops${who}` };
  }

  if (kind.executor === "vimeo") return publishVimeo(ctx, safeJson(d.payload));

  const ref = parseTarget(d.target);
  if (!ref) return { ok: false, result: `Cannot parse GitHub target "${d.target}"` };
  if (!inScope(ctx, ref)) return { ok: false, result: `${ref.owner}/${ref.repo} is not in the configured repos` };

  const payload = safeJson(d.payload);
  if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${d.target}` };

  const gh = await ctx.github();
  const needNumber = (): Required<RepoRef> => {
    if (!ref.number) throw new Error(`${d.kind} needs a PR or issue number in the target`);
    return ref as Required<RepoRef>;
  };

  switch (d.kind) {
    case "github.merge": {
      const method = (payload.merge_method as "merge" | "squash" | "rebase") ?? "squash";
      const r = await gh.merge(needNumber(), method, payload.sha as string | undefined);
      return { ok: r.merged, result: r.merged ? `Merged as ${r.sha.slice(0, 7)}` : "GitHub did not merge" };
    }
    case "github.close": {
      const n = needNumber();
      const note = payloadText(payload);
      if (note) await gh.comment(n, note);
      await gh.close(n);
      return { ok: true, result: "Closed" };
    }
    case "github.comment": {
      const body = payloadText(payload);
      if (!body) return { ok: false, result: "No comment text in payload" };
      const c = await gh.comment(needNumber(), body);
      return { ok: true, result: `Commented: ${c.html_url}` };
    }
    case "github.release": {
      const tag = payload.tag as string | undefined;
      if (!tag) return { ok: false, result: "No tag in payload" };
      const r = await gh.release(ref, {
        tag,
        name: payload.name as string | undefined,
        body: payloadText(payload),
        target: payload.target as string | undefined,
        draft: payload.draft as boolean | undefined,
      });
      return { ok: true, result: `Released: ${r.html_url}` };
    }
    default:
      return { ok: false, result: `No executor for ${d.kind}` };
  }
}

/**
 * Approved vimeo.publish: chapters first (best effort), then title and
 * description, and only then, if asked, make the video public. A failure
 * before the last step leaves the video as private as it was.
 */
async function publishVimeo(ctx: Ctx, p: Record<string, unknown>): Promise<ExecResult> {
  const id = String(p.video_id ?? "");
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const description = typeof p.description === "string" ? p.description.trim() : "";
  const makePublic = p.make_public === true;
  const chapters = Array.isArray(p.chapters) ? (p.chapters as Chapter[]) : [];
  if (!id || !name || !description) return { ok: false, result: "Payload needs video_id, name and description" };
  if (name.length > 128) return { ok: false, result: "Title is longer than 128 characters" };

  const vimeo = ctx.vimeo();
  const video = await vimeo.ownVideo(id); // refuses videos the account doesn't own
  if (ctx.dryRun) {
    return { ok: true, result: `DRY RUN: would update "${video.name}"${chapters.length ? ` with ${chapters.length} chapters` : ""}${makePublic ? " and make it public" : ""}` };
  }

  const notes: string[] = [];
  let added = 0;
  for (const c of chapters) {
    try {
      const secs = toSeconds(c.start);
      if (secs < 1 || (video.duration && secs >= video.duration)) throw new Error(`time ${c.start} is outside the video`);
      await vimeo.addChapter(id, String(c.title).slice(0, 100), secs);
      added++;
    } catch (e) {
      notes.push(`chapter "${c.title}" skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await vimeo.edit(id, { name, description });
  if (makePublic) await vimeo.edit(id, { privacy: { view: "anybody" } });

  const done = [`Updated title and description`, chapters.length ? `${added} of ${chapters.length} chapters added` : "", makePublic ? "now PUBLIC" : `still ${video.privacy}`]
    .filter(Boolean)
    .join("; ");
  return { ok: true, result: `${done}: ${video.link}${notes.length ? `\nNotes: ${notes.slice(0, 3).join("; ")}` : ""}` };
}
