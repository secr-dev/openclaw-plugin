# @secr/openclaw-plugin

Native [OpenClaw](https://openclaw.dev) plugin that brokers credentials to your
agents from [secr](https://secr.dev), enforces per-agent secret allowlists,
gates tool calls through the secr MCP gateway, and redacts known secret values
from agent message logs.

It is the recommended way to give an OpenClaw agent access to API keys,
database URLs, and other secrets without baking them into config or `.env`
files.

## What it does

- **Resolves secrets on demand** — `secr.get_secret`, `secr.list_envs`, and
  `secr.materialize_env` tools fetch the agent's allowlisted secrets from the
  secr broker. Optionally inject them into `process.env` at startup.
- **Gates every tool call** — the `before_tool_call` hook calls into the secr
  MCP gateway to apply per-agent rate limits, allow/deny rules, and
  approval-required workflows (one-shot grants are atomically consumed).
- **Records outcomes** — the `after_tool_call` hook reports success/error +
  duration so the gateway dashboard reflects real behaviour, not just
  attempted calls.
- **Redacts secrets from logs** — the `before_message_write` hook strips
  known secret values out of agent messages before they hit the session log.
- **Conditional access** — the broker honours IP allowlists, time windows,
  and user-agent matching configured on the agent identity in the secr
  dashboard.

## Install

```bash
openclaw plugins install npm:@secr/openclaw-plugin
```

Or, once the plugin is published to ClawHub:

```bash
openclaw plugins install clawhub:secr
```

## Setup

1. **Create an agent identity** in the secr dashboard
   (`/dashboard/agents` → "New agent"). Pick a project + environment, set the
   secret allowlist, and copy the `secr_agent_…` token shown once.

2. **Bind your repo to the agent** by adding a `secr:` block to the
   frontmatter of `IDENTITY.md` at your project root:

   ```markdown
   ---
   secr:
     org: my-org
     project: my-project
     environment: development
   ---
   ```

3. **Expose the token** via environment variable (recommended):

   ```bash
   export SECR_AGENT_TOKEN=secr_agent_…
   ```

   The plugin reads `SECR_AGENT_TOKEN` by default; change the variable name
   via `tokenEnvVar` in the plugin config if needed.

That's it — restart your OpenClaw session and the agent can call
`secr.get_secret` (or pre-load env with `materializeOnStartup: true`).

## Configuration

All fields are optional. Set them under `plugins.entries.secr.config` in
`~/.openclaw/openclaw.json`:

| Field | Default | Description |
| --- | --- | --- |
| `apiUrl` | `https://api.secr.dev` | secr API base URL. Override for self-hosted. |
| `identityPath` | `./IDENTITY.md` | Path to the file with the `secr:` frontmatter binding. |
| `tokenEnvVar` | `SECR_AGENT_TOKEN` | Env var holding the `secr_agent_…` token. |
| `token` | _(unset)_ | Inline token. Takes precedence over `tokenEnvVar`. Avoid in plain config. |
| `org` | _(from IDENTITY.md)_ | secr org slug. Overrides the frontmatter binding. |
| `project` | _(from IDENTITY.md)_ | secr project slug. Overrides the frontmatter binding. |
| `environment` | _(from IDENTITY.md)_ | secr environment slug. Overrides the frontmatter binding. |
| `materializeOnStartup` | `false` | Inject allowlisted secrets into `process.env` when the plugin loads. |
| `enforceGateway` | `true` | Apply MCP gateway rules (rate limits, allow/deny, approvals) on every tool call. |

## Tools the agent gains

| Tool | Purpose |
| --- | --- |
| `secr.get_secret` | Fetch a single secret by key. Subject to the allowlist. |
| `secr.list_envs` | List environments the agent can see. |
| `secr.materialize_env` | Materialise the allowlisted secrets as an env-style object. |

## Hooks the plugin registers

- `before_tool_call` (priority 100) — gateway gating: allow/deny, rate limit,
  approval-required.
- `after_tool_call` (priority 100) — records actual outcome + duration.
- `before_message_write` (priority 100) — redacts known secret values from
  outgoing messages.

## Requirements

- Node.js 20+
- OpenClaw runtime 2026.5.7 or newer (plugin API ≥ 2026.5.0)
- A secr account (free tier includes one agent identity)

## Links

- Plugin reference: [secr.dev/integrations/openclaw](https://secr.dev/integrations/openclaw)
- Dashboard: [secr.dev/dashboard/agents](https://secr.dev/dashboard/agents)
- Issues: [github.com/secr-dev/openclaw-plugin/issues](https://github.com/secr-dev/openclaw-plugin/issues)

## License

MIT
