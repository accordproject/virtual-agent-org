import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, validate } from "./compile";
import { loadAll } from "./lib";

const withPeople = (people: object[], peopleIds: object) => ({ ...loadAll(), people: { people }, peopleIds }) as ReturnType<typeof loadAll>;

test("validate keeps platform ids out of people.yaml", () => {
  const errs = validate(withPeople([{ name: "Kim Park", role: "maintainer", discord: "323456789012345678" }], {}));
  assert.ok(errs.includes("Kim Park: move the discord id to config/people.ids.yaml; ids stay out of the repo"));
});

test("validate checks people.ids.yaml names and ids", () => {
  const errs = validate(withPeople([{ name: "Kim Park", role: "maintainer" }], { "Kim Park": { telegram: "12ab" }, "Nobody": { discord: "323456789012345678" } }));
  assert.ok(errs.includes('Kim Park: telegram id "12ab" should be digits only'));
  assert.ok(errs.includes('config/people.ids.yaml: "Nobody" is not a name in config/people.yaml'));
});

test("compile leaves platform ids out of network.json", () => {
  const out = compile(withPeople([{ name: "Kim Park", role: "maintainer", github: "kimpark" }], { "Kim Park": { discord: "323456789012345678" } }));
  assert.deepEqual(out.people, [{ name: "Kim Park", roles: ["maintainer"], github: "kimpark" }]);
});

test("validate allows auto only for the kinds the gateway checks itself", () => {
  const cfg = loadAll();
  const permissions = { ...cfg.permissions, action_kinds: { ...cfg.permissions.action_kinds, "github.merge": { risk: "medium" as const, executor: "github" as const, auto: true } } };
  assert.ok(validate({ ...cfg, permissions }).includes("action kind github.merge: auto is only allowed for github.approve_ci and github.review"));
  assert.deepEqual(validate(cfg), []);
});

test("validate checks review.yaml", () => {
  const cfg = loadAll();
  const review = { ...cfg.review, max_nits: -1, tone: { ...cfg.review.tone, first_time: "chirpy" }, risk: { ...cfg.review.risk, low_max_lines: 900 }, path_rules: [{ glob: "", note: "x" }] };
  const errs = validate({ ...cfg, review });
  assert.ok(errs.includes("review.yaml: max_nits must be a whole number from 0 to 50"));
  assert.ok(errs.includes("review.yaml: tone.first_time must be one of welcoming, neutral, terse"));
  assert.ok(errs.includes("review.yaml: risk.low_max_lines must not exceed risk.high_over_lines"));
  assert.ok(errs.includes("review.yaml: path_rules[0] needs a glob and a note"));
});

test("compile passes the review settings to the gateway", () => {
  const out = compile(loadAll());
  assert.equal(out.review.max_nits, 3);
  assert.ok(out.review.risk.high_paths.includes(".github/**"));
  assert.ok(out.action_kinds["github.review"].auto);
});

test("validate lets ada have file tools for her memory and nothing else", () => {
  const cfg = loadAll();
  const withAda = (builtin_tools: string[], mcp_servers: object = []) =>
    validate({ ...cfg, permissions: { ...cfg.permissions, agents: { ...cfg.permissions.agents, ada: { ...cfg.permissions.agents.ada, builtin_tools, mcp_servers } } } } as typeof cfg);
  const err = "ada must have no MCP servers and no built-in tools other than read, write, edit, glob";
  assert.ok(!withAda(["read", "write", "edit", "glob"]).includes(err));
  assert.ok(withAda(["read", "bash"]).includes(err));
  assert.ok(withAda(["web_fetch"]).includes(err));
  assert.ok(withAda([], { github: { mode: "read" } }).includes(err));
});
