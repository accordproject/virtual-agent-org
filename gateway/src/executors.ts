// Executes approved decisions. Critical credentials live here, never in agent sandboxes.

import type { Ctx } from "./context";
import type { Decision } from "./db";
import { payloadText, safeJson } from "./format";
import { parseTarget, type RepoRef } from "./github";
import { resolveMentions } from "./people";
import { GATEWAY_LABEL, checklist, failed, mergeChecks, prFacts } from "./review";
import { toSeconds, type Chapter } from "./vimeo";

export { ciSensitivePaths } from "./review";

export interface ExecResult {
  ok: boolean;
  manual?: boolean; // the owner must now do it by hand, then tap "Mark done"
  result: string;
}

export function inScope(ctx: Ctx, r: RepoRef): boolean {
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

  if (kind.executor === "discord_dm") {
    // A message to named people from people.yaml, sent as a Discord DM from the bot.
    const payload = safeJson(d.payload);
    const text = payloadText(payload);
    if (!text) return { ok: false, result: "No message text in payload" };
    const m = resolveMentions(ctx, payload.to);
    if (m.missing.length || !m.ids.length || !ctx.dc) {
      const why = !m.ids.length && !m.missing.length ? "No recipient in payload.to" : !ctx.dc ? "The Discord bot isn't set up" : `Can't DM ${m.missing.join(", ")}: not in people.yaml with a Discord id`;
      return { ok: true, manual: true, result: `${why}. Copy the content above, send it, then tap Mark done.` };
    }
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would DM ${m.names.join(", ")}` };
    for (const id of m.ids) await ctx.dc.dm(id, { content: text });
    return { ok: true, result: `Sent a Discord DM to ${m.names.join(", ")}` };
  }

  if (kind.executor === "vimeo") return publishVimeo(ctx, safeJson(d.payload));

  const ref = parseTarget(d.target);
  if (!ref) return { ok: false, result: `Cannot parse GitHub target "${d.target}"` };
  if (!inScope(ctx, ref)) return { ok: false, result: `${ref.owner}/${ref.repo} is not in the configured repos` };

  const payload = safeJson(d.payload);
  const needNumber = (): Required<RepoRef> => {
    if (!ref.number) throw new Error(`${d.kind} needs a PR or issue number in the target`);
    return ref as Required<RepoRef>;
  };

  // Decision 35: the merge checks run again at approval, which may be hours after the proposal.
  let mergeSha = "";
  if (d.kind === "github.merge") {
    const f = await prFacts(ctx, needNumber());
    const checks = mergeChecks(f, typeof payload.sha === "string" ? payload.sha : "", await ctx.db.latestReview(f.target, f.sha));
    if (failed(checks).length) return { ok: false, result: `Not merged; the PR changed since the proposal:\n${checklist(failed(checks))}` };
    mergeSha = f.sha;
  }
  if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${d.target}` };

  const gh = await ctx.github();
  switch (d.kind) {
    case "github.merge": {
      const method = (payload.merge_method as "merge" | "squash" | "rebase") ?? "squash";
      // GitHub refuses if the head moved after the checks above.
      const r = await gh.merge(needNumber(), method, mergeSha);
      if (r.merged) await ctx.db.setReviewOutcome(d.target, "merged", `merged by the gateway (${d.id})`);
      return { ok: r.merged, result: r.merged ? `Merged as ${r.sha.slice(0, 7)}` : "GitHub did not merge" };
    }
    case "github.review": {
      // Built and checked by submit_review (decision 36); this only posts it.
      const review = {
        commit_id: String(payload.sha ?? ""),
        body: String(payload.body ?? ""),
        comments: Array.isArray(payload.comments) ? (payload.comments as { path: string; line: number; body: string }[]) : [],
      };
      if (!review.commit_id || !review.body) return { ok: false, result: "Payload needs sha and body" };
      let posted: string;
      try {
        const r = await gh.createReview(needNumber(), review);
        posted = `Posted review: ${r.html_url}`;
      } catch (e) {
        // A line outside the diff makes GitHub refuse the whole review: post the findings in the body instead.
        if (!review.comments.length || !String(e).includes(": 422")) throw e;
        const moved = review.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/\n\n/, ": ")}`).join("\n");
        const r = await gh.createReview(needNumber(), { ...review, body: review.body.replace(/\n---\n/, `\n${moved}\n\n---\n`), comments: [] });
        posted = `Posted review: ${r.html_url} (findings in the summary; GitHub refused the inline comments)`;
      }
      const labels = Array.isArray(payload.labels) ? payload.labels.map(String).filter((l) => GATEWAY_LABEL.test(l)) : [];
      if (!labels.length) return { ok: true, result: posted };
      // The review is posted either way; a label GitHub refuses is reported, not fatal.
      try {
        const n = needNumber();
        for (const old of (await gh.labels(n)).filter((l) => GATEWAY_LABEL.test(l) && !labels.includes(l))) await gh.removeLabel(n, old);
        await gh.addLabels(n, labels);
        return { ok: true, result: `${posted} and labelled it ${labels.join(", ")}` };
      } catch (e) {
        return { ok: true, result: `${posted} but couldn't label it (${e instanceof Error ? e.message : String(e)})` };
      }
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
    case "github.approve_ci": {
      const n = needNumber();
      const pr = await gh.pull(n);
      const want = typeof payload.sha === "string" ? payload.sha : "";
      if (want && !pr.head.sha.startsWith(want)) {
        return { ok: false, result: `PR has new commits since the review (head is ${pr.head.sha.slice(0, 7)}); review again` };
      }
      const runs = await gh.runsAwaitingApproval(ref, pr.head.sha);
      if (!runs.length) return { ok: true, result: `No runs waiting for approval on ${pr.head.sha.slice(0, 7)}` };
      for (const run of runs) await gh.approveRun(ref, run.id);
      return { ok: true, result: `Approved ${runs.length} CI run${runs.length > 1 ? "s" : ""} (${runs.map((r) => r.name).join(", ")}) on ${pr.head.sha.slice(0, 7)}` };
    }
    case "github.docs_pr": {
      const path = typeof payload.path === "string" ? payload.path.replace(/^\/+/, "") : "";
      if (!isGuidanceFile(path)) return { ok: false, result: `docs_pr only writes AGENTS.md, CONTRIBUTING.md, REVIEWING.md or CLAUDE.md, not "${path}"` };
      const content = typeof payload.content === "string" ? payload.content : "";
      if (!content.trim()) return { ok: false, result: "No file content in payload" };
      const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : `Update ${path} with review lessons`;
      const pr = await gh.proposeFile(ref, {
        path,
        content: content.endsWith("\n") ? content : `${content}\n`,
        branch: `agents/${d.agent}-${d.id.toLowerCase()}`,
        title,
        body: `${payloadText({ body: payload.body }) || d.rationale}\n\n---\nDrafted by an Accord Project agent (${d.id}); needs a maintainer's review like any other PR.`,
      });
      return { ok: true, result: `Opened ${pr.html_url}` };
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

/** The only files github.docs_pr may write: guidance for contributors and review agents. */
export function isGuidanceFile(path: string): boolean {
  return !path.split("/").includes("..") && /(^|\/)(AGENTS|CONTRIBUTING|REVIEWING|CLAUDE)\.md$/.test(path);
}
