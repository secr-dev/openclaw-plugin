# @secr/openclaw-plugin

Native [OpenClaw](https://openclaw.ai) plugin for the [secr](https://secr.dev) secrets manager. Replaces plaintext API keys in OpenClaw deployments with scoped, allowlisted, audited credentials — and gates every tool call through an MCP gateway with allow/deny rules, rate limits, and human-in-the-loop approval queues.

## Install

```bash
openclaw plugins install npm:@secr/openclaw-plugin
```

## Configure

Add a `secr` entry to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "secr": {
        "enabled": true,
        "config": {
          "token": "secr_agent_...",
          "org": "acme",
          "project": "support-bot",
          "environment": "production"
        }
      }
    }
  }
}
```

Then `openclaw gateway restart`.

## What it does

- **Credentials broker** — replaces plaintext API keys with a short-lived agent-token session against the secr API. Per-agent server-side `secretAllowlist` enforced on every read.
- **Tool-call governance** — registers `before_tool_call` via `api.on()` and:
  - blocks tools listed in deny rules (rules accept arbitrary string tool names, not just MCP secret operations)
  - enforces per-agent rate limits (per-minute / per-hour)
  - returns `requireApproval` for tools matching approval-required rules, surfacing OpenClaw's native approval UI
  - atomically consumes one-shot approval grants via Postgres `FOR UPDATE SKIP LOCKED` (no double-spend under concurrent retries)
- **Audit** — every secret read and tool call recorded server-side with redacted parameters, agent identity, environment, IP.
- **OpenClaw-native tools** — also registers `secr.get_secret`, `secr.list_envs`, and `secr.materialize_env` for explicit calls from agent code.

## Get started

The fastest path is the [`secr openclaw init`](https://secr.dev/integrations/openclaw) command — it scaffolds an `IDENTITY.md` with the secr binding, creates a scoped agent identity (project + env + allowlist + 90d expiry), and prints the plugin install command.

## Documentation

- [Integration landing page](https://secr.dev/integrations/openclaw)
- [Getting started tutorial](https://secr.dev/blog/getting-started-with-openclaw-and-secr)
- [Approval queues deep-dive](https://secr.dev/blog/openclaw-mcp-approval-queues)
- [NHI posture checklist](https://secr.dev/blog/openclaw-nhi-posture-checklist)

## License

MIT
