<!--- Provide a Conventional Commits message describing this PR in the Title above, e.g. "feat: add repo:add" -->
<!--- See https://github.com/accordproject/techdocs/blob/master/DEVELOPERS.md#commits -->
<!--- Sign off every commit: git commit -s -->
# Closes #<CORRESPONDING ISSUE NUMBER>
<!--- Provide an overall summary of the pull request -->

### Changes
<!--- More detailed and granular description of changes -->
- <ONE>
- <TWO>

### Safety
<!--- Does this touch a safety rule, an action kind, a credential or an agent's permissions? Say which, or "none" -->

### Deploy
<!--- What the maintainer runs after merging: npm run gateway:deploy, npm run deploy:agents, npm run people:ids, D1 migration, or "none" -->

### Decision
<!--- If this settles a design decision, its number in docs/decisions.md -->

### Checks
- [ ] `npm test` passes
- [ ] A test in `gateway/test/gateway.test.ts` covers any gateway behaviour change
- [ ] `network.json` regenerated if `config/` changed
- [ ] No secrets or Discord/Telegram ids added
