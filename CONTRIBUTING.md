# Contributing to virtual-agent-org

## Accord Project Contribution Guide

We'd love your help. Please follow the [Accord Project Contribution guidelines][apcontribute].
For questions, join the [Accord Project Discord][apdiscord].

## Specific to this repo

- **Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)**
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:` …), as the
  [Accord Project guide](https://github.com/accordproject/techdocs/blob/master/DEVELOPERS.md)
  requires, and use the same form for the pull request title.
- **Sign off every commit** (`git commit -s`) under the
  [Developer Certificate of Origin](https://developercertificate.org/). The DCO check
  fails a pull request whose commits aren't signed off.
- **Run `npm test` before opening a pull request.** It validates the config, runs the
  script tests, type-checks the gateway and runs its tests. CI runs the same, and also
  checks that `gateway/src/generated/network.json` is up to date (`npm run compile`).
- **Every behaviour change in the gateway gets a test** in `gateway/test/gateway.test.ts`,
  using `makeTestCtx()` from `helpers.ts`. Tests use fakes; never call real APIs.
- **Agent specs (`agents/`), `config/permissions.yaml` and `config/models.yaml`** decide
  what the agents may do. Changes to them are welcome as proposals, and the TSC chair
  decides. The rules in [ARCHITECTURE.md](ARCHITECTURE.md#safety-rules) aren't relaxed to
  make a feature easier.
- **A design change** that needs a decision: explain the options in the pull request; once
  settled, it is recorded in [docs/decisions.md](docs/decisions.md).
- **No secrets or personal data.** Tokens and keys belong in Worker secrets or agent
  vaults; people's Discord and Telegram ids belong in the git-ignored
  `config/people.ids.yaml`. `npm test` rejects ids in `config/people.yaml`.
- **Content agents read is data.** If you find a way for text in a PR, issue or
  transcript to make an agent act against its spec, report it privately
  ([SECURITY.md](SECURITY.md)) rather than in an issue.

Deploying needs the project's credentials, so maintainers deploy after merging; the
commands are in [CLAUDE.md](CLAUDE.md#commands).

[apcontribute]: https://github.com/accordproject/techdocs/blob/master/CONTRIBUTING.md
[apdiscord]: https://discord.com/invite/Zm99SKhhtA
