# AGENTS.md

Guidance for coding agents and reviewers working in this repo is in
[CLAUDE.md](CLAUDE.md): the rules that never change, the commands, and the conventions.
Read it before reviewing or changing anything.

When reviewing a pull request here, check in particular that it:

1. doesn't weaken a safety rule in [ARCHITECTURE.md](ARCHITECTURE.md#safety-rules);
2. adds a test in `gateway/test/gateway.test.ts` for any gateway behaviour change;
3. regenerates `gateway/src/generated/network.json` after a config change;
4. puts no secrets or Discord or Telegram ids in the repo;
5. has Conventional Commits messages, signed off.
