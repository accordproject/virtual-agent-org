# virtual-agent-org

A virtual organisation of Claude agents that helps run the Accord Project, steered
from Telegram. Matt instructs **Ada**, the Chief of Staff; Ada delegates to
specialist agents; every critical action waits in a decision queue for Matt.

## Layout

| Path | What it is |
| --- | --- |
| `agents/` | One job spec per agent, plus `_protocol.md` included in every agent's instructions |
| `config/network.yaml` | Phase, agents per phase, repos in scope, budgets, Telegram roles |
| `config/models.yaml` | Model tiers; specs name a tier, never a model ID |
| `config/permissions.yaml` | Built-in tools, MCP servers and requestable actions per agent |
| `config/schedules.yaml` | Recurring work (check-ins, triage, scorecards) |
| `config/mcp_servers.yaml` | MCP server URLs and where each agent's token comes from |
| `context/accord.md` | Shared, read-only project context for every agent |
| `evaluation/` | Weekly evaluation rubric and scorecard schema |
| `gateway/` | Cloudflare Worker: Telegram bot, decision queue, custom tools, audit log |
| `scripts/` | `compile.ts` validates config; `deploy.ts` syncs agents to Claude Managed Agents |

## How it fits together

1. `scripts/deploy.ts` creates each agent on Claude Managed Agents with its spec,
   model, tools and a vault for its own credentials.
2. Agents call **custom tools** (`request_action`, `report_status`, `assign_task`,
   `send_to_matt`, …). Managed Agents notifies the gateway by webhook; the gateway
   runs the tool and sends the result back.
3. `request_action` puts a card in Telegram with Approve / Reject / Ask Ada and
   returns a decision id immediately, so the agent keeps working.
4. On approval the gateway executes the action with its own GitHub App, or hands
   it to Matt to do by hand for channels without an executor.

## Everyday commands (Telegram)

Plain text goes to Ada. `/status`, `/queue`, `/ask <agent> <text>`,
`/pause <agent>`, `/resume <agent>`, `/stop <agent|all>`, `/revoke <agent> confirm`.

## Development

```sh
npm ci && npm ci --prefix gateway
npm test                     # config validation, type-check, gateway tests
npm run deploy:agents:dry    # what deploy would change
```

Changes to specs, permissions and models are pull requests. Ada proposes them;
Matt merges them.

## Status

Phase 0. API details marked `VERIFY` in `gateway/src/managed.ts`,
`gateway/src/webhookVerify.ts` and `scripts/deploy.ts` are confirmed during the
Phase 0 gate test.
