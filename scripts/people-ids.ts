// Loads people's Discord and Telegram ids into the gateway's PEOPLE_IDS secret.
// The ids live in the git-ignored config/people.ids.yaml, so this repo can be public.
//
//   npm run people:ids             # validate, then wrangler secret put PEOPLE_IDS
//   npm run people:ids -- --dry-run  # say who has which ids, without the ids

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./compile";
import { PEOPLE_IDS_PATH, ROOT, loadAll } from "./lib";

const DRY = process.argv.includes("--dry-run");

if (!existsSync(join(ROOT, PEOPLE_IDS_PATH))) {
  console.error(`No ${PEOPLE_IDS_PATH}. Copy config/people.ids.example.yaml and fill it in.`);
  process.exit(1);
}
const cfg = loadAll();
const errs = validate(cfg);
if (errs.length) {
  console.error(`Config invalid:\n- ${errs.join("\n- ")}`);
  process.exit(1);
}

const ids: Record<string, { discord?: string; telegram?: string }> = {};
for (const [name, v] of Object.entries(cfg.peopleIds)) {
  const discord = v?.discord ? String(v.discord) : undefined;
  const telegram = v?.telegram ? String(v.telegram) : undefined;
  if (discord || telegram) ids[name] = { ...(discord ? { discord } : {}), ...(telegram ? { telegram } : {}) };
}
for (const [name, v] of Object.entries(ids)) console.log(`  ${name}: ${Object.keys(v).join(", ")}`);
const missing = (cfg.people.people ?? []).map((p) => p.name).filter((n) => !ids[n]);
if (missing.length) console.log(`  No ids (can't reach the network or be pinged): ${missing.join(", ")}`);

if (DRY) process.exit(0);
execFileSync("npx", ["wrangler", "secret", "put", "PEOPLE_IDS"], {
  cwd: join(ROOT, "gateway"),
  input: JSON.stringify(ids),
  stdio: ["pipe", "inherit", "inherit"],
});
console.log("PEOPLE_IDS set. The gateway picks it up on its next request.");
