import { describe, expect, it } from "vitest";
import { approve } from "../src/controls";
import { handleTool } from "../src/tools";
import { makeTestCtx } from "./helpers";

describe("vimeo (decision 18A)", () => {
  const VIDEO = { id: "1181178573", name: "Tech WG 2026-04-08", description: null, created_time: "2026-04-08T15:00:00Z", duration: 3600, link: "https://vimeo.com/1181178573", privacy: "nobody" };
  const fakeVimeo = (opts: { failOwn?: boolean; failEdit?: boolean; failChapter?: boolean } = {}) => {
    const calls: string[] = [];
    const v = {
      calls,
      ownVideo: async (id: string) => {
        calls.push(`own ${id}`);
        if (opts.failOwn) throw new Error("Vimeo GET /me/videos/x: 404");
        return VIDEO;
      },
      addChapter: async (_id: string, title: string, secs: number) => {
        if (opts.failChapter) throw new Error("Premium required");
        calls.push(`chapter ${secs} ${title}`);
      },
      edit: async (_id: string, f: any) => {
        if (opts.failEdit && f.name) throw new Error("Vimeo PATCH 500");
        calls.push(f.privacy ? `privacy ${f.privacy.view}` : `edit ${f.name}`);
      },
    };
    return v;
  };
  const publish = (ctx: any, payload: object) =>
    handleTool(ctx, "otto", "s", "request_action", {
      kind: "vimeo.publish", target: VIDEO.link, summary: "Publish Tech WG 2026-04-08", rationale: "r", risk: "low", payload,
    });
  const PAYLOAD = {
    video_id: VIDEO.id,
    name: "Accord Project Tech WG – 2026-04-08 – Template Engine v4 & GSoC 2026 Funding",
    description: "Recording of the Accord Project Technology Working Group meeting on 8 April 2026.",
    chapters: [{ title: "Welcome", start: "00:05" }, { title: "Template Engine v4", start: "4:30" }, { title: "Too late", start: "2:00:00" }],
    make_public: true,
  };

  it("shows the title, chapters and a clear PUBLIC warning on the card", async () => {
    const { ctx, fakes } = makeTestCtx();
    await publish(ctx, PAYLOAD);
    const card = fakes.sent[0].text;
    expect(card).toContain("Title: Accord Project Tech WG – 2026-04-08");
    expect(card).toContain("Recording of the Accord Project Technology Working Group");
    expect(card).toContain("4:30  Template Engine v4");
    expect(card).toContain("⚠ Makes the video PUBLIC on Vimeo");
  });

  it("adds chapters, then the text, and makes it public last", async () => {
    const v = fakeVimeo();
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    const res = await approve(ctx, "D-1");
    expect(v.calls).toEqual([`own ${VIDEO.id}`, "chapter 5 Welcome", "chapter 270 Template Engine v4", `edit ${PAYLOAD.name}`, "privacy anybody"]);
    expect(res).toContain("2 of 3 chapters added; now PUBLIC");
    expect(res).toContain('chapter "Too late" skipped');
  });

  it("never makes a video public if the text update fails", async () => {
    const v = fakeVimeo({ failEdit: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    expect(await approve(ctx, "D-1")).toMatch(/failed: .*PATCH 500/);
    expect(v.calls.some((c) => c.startsWith("privacy"))).toBe(false);
  });

  it("carries on without chapters when the plan doesn't support them", async () => {
    const v = fakeVimeo({ failChapter: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, { ...PAYLOAD, chapters: PAYLOAD.chapters.slice(0, 2) });
    expect(await approve(ctx, "D-1")).toContain("0 of 2 chapters added; now PUBLIC");
  });

  it("refuses videos the account doesn't own, and leaves privacy alone unless asked", async () => {
    const v = fakeVimeo({ failOwn: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    expect(await approve(ctx, "D-1")).toMatch(/404/);
    expect(v.calls).toEqual([`own ${VIDEO.id}`]);

    const v2 = fakeVimeo();
    const { ctx: ctx2 } = makeTestCtx({ dryRun: false, vimeo: () => v2 as any });
    await publish(ctx2, { ...PAYLOAD, make_public: false, chapters: [] });
    expect(await approve(ctx2, "D-1")).toContain("still nobody");
    expect(v2.calls.some((c) => c.startsWith("privacy"))).toBe(false);
  });

  it("keeps the Vimeo tools for Otto and pages transcripts", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "vimeo_transcript", { video_id: "1" })).rejects.toThrow(/not available to mira/);
    const text = Array.from({ length: 5000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}] line ${i} of the meeting`).join("\n");
    ctx.vimeo = () => ({ transcript: async () => text }) as any;
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = JSON.parse(await handleTool(ctx, "otto", "s", "vimeo_transcript", { video_id: "1", offset }));
      expect(page.text.length).toBeLessThanOrEqual(60_000);
      expect(page.text.endsWith("of the meeting")).toBe(true); // pages end on whole lines
      pages.push(page.text);
      offset = page.next_offset;
    }
    expect(pages.length).toBe(3);
    expect(pages.join("\n")).toBe(text);
  });

  it("reads Vimeo's API shapes", async () => {
    const { Vimeo, vttToLines, toSeconds, toTimecode, isTechWg } = await import("../src/vimeo");
    expect(toSeconds("1:15")).toBe(75);
    expect(toSeconds("01:02:03")).toBe(3723);
    expect(toTimecode(3723)).toBe("01:02:03.000");
    expect(isTechWg("AP TECH WG 2026-04-01")).toBe(true);
    expect(isTechWg("Accord Project's Personal Meeting Room 2026-03-25 12:06:53")).toBe(true);
    expect(isTechWg("Concerto demo")).toBe(false);
    const vtt = "WEBVTT\n\n1\n00:00:03.000 --> 00:00:06.000\n<v Speaker 0>Welcome, everyone.\n\n2\n00:00:06.000 --> 00:00:08.000\nWelcome, everyone.\n\n3\n00:01:05.500 --> 00:01:09.000\nFirst, Template Engine v4.";
    expect(vttToLines(vtt)).toBe("[00:03] Welcome, everyone.\n[01:05] First, Template Engine v4.");

    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.includes("/texttracks")) return new Response(JSON.stringify({ data: [{ id: 1, type: "captions", active: true, link: "https://captions.example/t.vtt" }] }));
      if (url.endsWith("t.vtt")) return new Response(vtt);
      if (url.includes("/me/videos/")) return new Response(JSON.stringify({ uri: "/videos/42", name: "Tech WG 2026-04-08", description: null, created_time: "", duration: 60, link: "l", privacy: { view: "nobody" } }));
      return new Response(JSON.stringify({ data: [{ uri: "/videos/42", name: "Tech WG 2026-04-08", description: null, created_time: "", duration: 60, link: "l", privacy: { view: "nobody" } }] }));
    }) as unknown as typeof fetch;
    const v = new Vimeo("tok", fake);
    expect((await v.recent(5))[0]).toMatchObject({ id: "42", privacy: "nobody" });
    expect(await v.transcript("42")).toContain("[01:05] First");
    await expect(v.ownVideo("../me")).rejects.toThrow(/not a Vimeo video id/);
  });
});
