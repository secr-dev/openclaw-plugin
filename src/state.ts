import { OpenClawSecretBroker, loadIdentity } from "@secr/openclaw";
import { McpGateway } from "@secr/mcp/gateway";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "./types.js";

/**
 * Best-effort load of the resolved plugin config from ~/.openclaw/openclaw.json.
 * The file is the canonical source for `plugins.entries.<id>.config`; reading
 * it directly avoids depending on a runtime API surface that varies between
 * OpenClaw versions. Returns {} if the file is missing or has no entry.
 */
async function loadOpenClawPluginConfig(): Promise<PluginConfig> {
  const path =
    process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(path, "utf-8");
    const json = JSON.parse(raw) as {
      plugins?: { entries?: Record<string, { config?: PluginConfig }> };
    };
    return json.plugins?.entries?.secr?.config ?? {};
  } catch {
    return {};
  }
}

/**
 * Lazily-initialised plugin singleton. The plugin loads at OpenClaw startup
 * but we defer the actual broker construction (which reads SECR_AGENT_TOKEN)
 * until first use so plugin discovery / setup-only registration modes don't
 * fail when the token isn't yet present.
 */
export class PluginState {
  private broker: OpenClawSecretBroker | null = null;
  private gateway: McpGateway | null = null;
  private gatewayInitialized = false;
  private brokerInitPromise: Promise<OpenClawSecretBroker> | null = null;

  // Cached secret values for the redaction hook. Refreshed lazily; never
  // exposed outside the plugin (only used to build a redaction set).
  private secretValuesCache: Set<string> | null = null;
  private secretValuesCachedAt = 0;
  private static readonly SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly MIN_REDACT_VALUE_LEN = 8;

  constructor(private readonly config: PluginConfig) {}

  /**
   * Returns the set of secret VALUES the agent is allowed to read, suitable
   * for content-filter redaction. Caches for 5 minutes. Excludes values
   * shorter than 8 chars (too many false positives).
   *
   * Never logs values. Never returns the cache externally — callers receive
   * a fresh Set each call so they can iterate without persisting refs.
   */
  async getRedactionValues(): Promise<Set<string>> {
    const now = Date.now();
    if (this.secretValuesCache && (now - this.secretValuesCachedAt) < PluginState.SECRET_CACHE_TTL_MS) {
      return new Set(this.secretValuesCache);
    }
    try {
      const broker = await this.getBroker();
      const all = await broker.getAll();
      const set = new Set<string>();
      for (const v of Object.values(all)) {
        if (typeof v === "string" && v.length >= PluginState.MIN_REDACT_VALUE_LEN) {
          set.add(v);
        }
      }
      this.secretValuesCache = set;
      this.secretValuesCachedAt = now;
      return new Set(set);
    } catch {
      return new Set();
    }
  }

  async getBroker(): Promise<OpenClawSecretBroker> {
    if (this.broker) return this.broker;
    if (this.brokerInitPromise) return this.brokerInitPromise;

    this.brokerInitPromise = (async () => {
      // Lift resolved plugin config from ~/.openclaw/openclaw.json. File config
      // wins over the constructor defaults so users can change scope without
      // rebuilding the plugin.
      const fileCfg = await loadOpenClawPluginConfig();
      const merged: PluginConfig = { ...this.config, ...fileCfg };

      // Token resolution: config.token wins, then env var.
      const tokenVar = merged.tokenEnvVar ?? "SECR_AGENT_TOKEN";
      const token = merged.token ?? process.env[tokenVar];
      if (!token) {
        throw new Error(
          `secr plugin: no agent token. Set plugins.entries.secr.config.token in ` +
          `~/.openclaw/openclaw.json, or export ${tokenVar}.`
        );
      }

      // Scope resolution priority:
      //   1. Plugin config (org/project/environment)
      //   2. IDENTITY.md frontmatter — only loaded if config is incomplete
      let org = merged.org;
      let project = merged.project;
      let environment = merged.environment;

      if (!org || !project || !environment) {
        const identityPath = merged.identityPath ?? "./IDENTITY.md";
        const exists = await access(identityPath).then(() => true).catch(() => false);
        if (!exists) {
          throw new Error(
            `secr plugin: missing org/project/environment in plugin config and ` +
            `${identityPath} not found. Either set plugins.entries.secr.config.{org,project,environment} ` +
            `in ~/.openclaw/openclaw.json, or create an IDENTITY.md with a secr: frontmatter block.`
          );
        }
        try {
          const parsed = await loadIdentity(identityPath);
          const binding = parsed.binding;
          org = org ?? binding?.org;
          project = project ?? binding?.project;
          environment = environment ?? binding?.environment;
        } catch (err: any) {
          throw new Error(
            `secr plugin: failed to parse ${identityPath}: ${err?.message ?? err}`
          );
        }
      }

      if (!org || !project || !environment) {
        throw new Error(
          `secr plugin: incomplete scope. Need org=${org ?? "?"}, project=${project ?? "?"}, environment=${environment ?? "?"}.`
        );
      }

      const broker = new OpenClawSecretBroker({
        token,
        org,
        project,
        environment,
        apiUrl: merged.apiUrl,
      });
      this.broker = broker;
      return broker;
    })();

    return this.brokerInitPromise;
  }

  async getGateway(): Promise<McpGateway> {
    const broker = await this.getBroker();
    if (!this.gateway) {
      this.gateway = new McpGateway(broker.sdk);
    }
    if (!this.gatewayInitialized) {
      await this.gateway.initialize();
      this.gatewayInitialized = true;
    }
    return this.gateway;
  }
}
