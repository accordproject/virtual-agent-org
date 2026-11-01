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
