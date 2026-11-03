import { describe, expect, it } from "vitest";
import { makeTestCtx } from "./helpers";

describe("changes", () => {
  it("changes are created as C-n and found by task", async () => {
    const { ctx } = makeTestCtx();
    const base = { agent: "mira", decision_id: "D-1", change_type: "spec", measure: "approval_rate", kinds: ["github.review"] };
    const a = await ctx.db.createChange(base);
    const b = await ctx.db.createChange({ ...base, agent: "network", tool: "request_action" });
    expect([a.id, b.id]).toEqual(["C-1", "C-2"]);
    expect(a.state).toBe("building");
    expect(b.tool).toBe("request_action");

    await ctx.db.updateChange("C-1", { task_id: "T-5", state: "pr_open" });
    expect((await ctx.db.changeForTask("T-5"))?.id).toBe("C-1");
    expect(await ctx.db.changeForTask("T-9")).toBeNull();
    expect((await ctx.db.changesIn(["pr_open"])).map((c) => c.id)).toEqual(["C-1"]);
    expect((await ctx.db.getChange("C-2"))?.state).toBe("building");
  });
});
