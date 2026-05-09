import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pluginEntry, { PluginState, buildToolCallHook, registerSecrTools } from "../index.js";
import type {
  OpenClawPluginApi,
  RegisterToolDef,
  BeforeToolCallEvent,
  PluginContext,
  BeforeToolCallResult,
} from "../types.js";

const FAKE_TOKEN = "secr_agent_" + "f".repeat(48);

interface RegisteredHook {
  event: string;
  handler: (e: BeforeToolCallEvent, c: PluginContext) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  opts?: { name?: string };
}

function makeApi(mode: "full" | "discovery" = "full"): {
  api: OpenClawPluginApi;
  tools: RegisterToolDef[];
  hooks: RegisteredHook[];
} {
  const tools: RegisterToolDef[] = [];
  const hooks: RegisteredHook[] = [];
  return {
    api: {
      registrationMode: mode,
      registerTool(def) { tools.push(def); },
      on(event, handler, opts) {
        hooks.push({ event, handler: handler as any, opts });
      },
    },
    tools,
    hooks,
  };
}

describe("plugin entry contract", () => {
  it("exports valid PluginEntryDef", () => {
    expect(pluginEntry.id).toBe("secr");
    expect(pluginEntry.name).toContain("secr");
    expect(typeof pluginEntry.register).toBe("function");
  });

  it("registers hook + tools in full mode", () => {
    const { api, tools, hooks } = makeApi("full");
    pluginEntry.register(api);
    expect(hooks.map((h) => h.event)).toContain("before_tool_call");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["secr.get_secret", "secr.list_envs", "secr.materialize_env"].sort()
    );
  });

  it("registers tools + hooks in discovery mode (metadata-only)", () => {
    // Per OpenClaw's plugin-sdk semantics, lightweight registrations (tool
    // factories, hook handlers) run in every mode so `openclaw plugins
    // inspect` can surface their metadata. Only heavy services are gated.
    const { api, tools, hooks } = makeApi("discovery");
    pluginEntry.register(api);
    expect(hooks.length).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);
  });
});

describe("before_tool_call hook", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalToken: string | undefined;
  let reportedCalls: any[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.SECR_AGENT_TOKEN;
    process.env.SECR_AGENT_TOKEN = FAKE_TOKEN;
    reportedCalls = [];

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/mcp-gateway/config")) {
        // Return a config that denies "github.delete_repo" and requires
        // approval for "github.archive_repo".
        return new Response(JSON.stringify({
          config: {
            allowedTools: null,
            deniedTools: ["github.delete_repo"],
            requireApprovalTools: ["github.archive_repo"],
            requireApprovalEnvironments: null,
            maxRequestsPerMinute: null,
            maxRequestsPerHour: null,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/mcp-gateway/check-grant")) {
        return new Response(JSON.stringify({ granted: false }), { status: 200 });
      }
      if (url.includes("/mcp-gateway/report")) {
        reportedCalls.push(JSON.parse(init?.body ?? "{}"));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SECR_AGENT_TOKEN;
    else process.env.SECR_AGENT_TOKEN = originalToken;
  });

  // Helper: build a state with an in-memory broker that already has identity
  // resolved (skip the IDENTITY.md read).
  async function buildHook() {
    const { OpenClawSecretBroker } = await import("@secr/openclaw");
    const { McpGateway } = await import("@secr/mcp/gateway");

    const broker = new OpenClawSecretBroker({
      token: FAKE_TOKEN,
      org: "acme",
      project: "core",
      environment: "production",
      apiUrl: "http://test",
      useSessionTokens: false,
    });

    const state = {
      async getBroker() { return broker; },
      async getGateway() {
        const gw = new McpGateway(broker.sdk);
        await gw.initialize();
        return gw;
      },
    } as unknown as PluginState;

    return buildToolCallHook(state);
  }

  it("blocks denied tools with blockReason", async () => {
    const hook = await buildHook();
    const result = await hook(
      { toolName: "github.delete_repo", params: {} },
      { pluginConfig: { enforceGateway: true } }
    );
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("denied");
  });

  it("returns requireApproval for approval-required tools without active grant", async () => {
    const hook = await buildHook();
    const result = await hook(
      { toolName: "github.archive_repo", params: { repo: "acme/x" } },
      { pluginConfig: { enforceGateway: true } }
    );
    expect(result?.requireApproval).toBeDefined();
    expect(result?.requireApproval?.title).toContain("github.archive_repo");
    expect(result?.requireApproval?.severity).toBe("warning");
    expect(result?.requireApproval?.timeoutBehavior).toBe("deny");
  });

  it("redacts sensitive params in approval description", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "github.archive_repo", params: { repo: "x", token: "supersecret" } },
      { pluginConfig: { enforceGateway: true } }
    );
    // Wait for fire-and-forget report
    await new Promise((r) => setTimeout(r, 20));
    const approvalReport = reportedCalls.find((r) => r.status === "approval_required");
    expect(approvalReport?.parameters?.token).toBe("[REDACTED]");
  });

  it("allows non-restricted tools (no block)", async () => {
    const hook = await buildHook();
    const result = await hook(
      { toolName: "github.list_issues", params: {} },
      { pluginConfig: { enforceGateway: true } }
    );
    expect(result).toBeUndefined();
  });

  it("skips secr.* tools (no double-gating)", async () => {
    const hook = await buildHook();
    const result = await hook(
      { toolName: "secr.get_secret", params: { key: "FOO" } },
      { pluginConfig: { enforceGateway: true } }
    );
    expect(result).toBeUndefined();
  });

  it("respects enforceGateway=false config", async () => {
    const hook = await buildHook();
    const result = await hook(
      { toolName: "github.delete_repo", params: {} },
      { pluginConfig: { enforceGateway: false } }
    );
    expect(result).toBeUndefined();
  });

  it("fails open if gateway init throws", async () => {
    // Build a state that throws on getGateway
    const state = {
      async getGateway() { throw new Error("net down"); },
    } as unknown as PluginState;
    const hook = buildToolCallHook(state);
    const result = await hook(
      { toolName: "github.delete_repo", params: {} },
      { pluginConfig: { enforceGateway: true } }
    );
    expect(result).toBeUndefined();
  });
});

describe("after_tool_call hook", () => {
  let originalFetch: typeof globalThis.fetch;
  let reportedCalls: any[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    reportedCalls = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/mcp-gateway/config")) {
        return new Response(JSON.stringify({
          config: { allowedTools: null, deniedTools: null, requireApprovalTools: null,
                    requireApprovalEnvironments: null, maxRequestsPerMinute: null, maxRequestsPerHour: null },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/mcp-gateway/report")) {
        reportedCalls.push(JSON.parse(init?.body ?? "{}"));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  async function buildHook() {
    const { OpenClawSecretBroker } = await import("@secr/openclaw");
    const { McpGateway } = await import("@secr/mcp/gateway");
    const broker = new OpenClawSecretBroker({
      token: "secr_agent_" + "f".repeat(48),
      org: "acme", project: "core", environment: "production",
      apiUrl: "http://test", useSessionTokens: false,
    });
    const state = {
      async getBroker() { return broker; },
      async getGateway() {
        const gw = new McpGateway(broker.sdk);
        await gw.initialize();
        return gw;
      },
    } as unknown as PluginState;
    const { buildAfterToolCallHook } = await import("../tool-call-hook.js");
    return buildAfterToolCallHook(state);
  }

  it("reports success with durationMs when result is set", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "github.create_issue", params: { repo: "acme/x" }, result: { ok: true }, durationMs: 142 },
      { pluginConfig: { enforceGateway: true } }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reportedCalls.length).toBe(1);
    expect(reportedCalls[0].status).toBe("success");
    expect(reportedCalls[0].durationMs).toBe(142);
    expect(reportedCalls[0].toolName).toBe("github.create_issue");
  });

  it("reports error with errorMessage when error is set", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "github.delete_repo", params: { repo: "acme/x" }, error: "Repo locked", durationMs: 27 },
      { pluginConfig: { enforceGateway: true } }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reportedCalls[0].status).toBe("error");
    expect(reportedCalls[0].errorMessage).toBe("Repo locked");
  });

  it("redacts sensitive params before reporting", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "send_request", params: { url: "https://x", token: "supersecret" }, result: "ok" },
      { pluginConfig: { enforceGateway: true } }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reportedCalls[0].parameters.token).toBe("[REDACTED]");
    expect(reportedCalls[0].parameters.url).toBe("https://x");
  });

  it("skips secr.* tools (already audited via tool execute)", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "secr.list_envs", params: {}, result: "..." },
      { pluginConfig: { enforceGateway: true } }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reportedCalls.length).toBe(0);
  });

  it("respects enforceGateway=false config", async () => {
    const hook = await buildHook();
    await hook(
      { toolName: "github.create_issue", params: {}, result: "ok" },
      { pluginConfig: { enforceGateway: false } }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reportedCalls.length).toBe(0);
  });
});

describe("registerSecrTools", () => {
  it("registers all three secr.* tools with correct names + descriptions", () => {
    const { api, tools } = makeApi("full");
    const state = {} as PluginState;
    registerSecrTools(api, state);

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["secr.get_secret"]).toBeDefined();
    expect(byName["secr.list_envs"]).toBeDefined();
    expect(byName["secr.materialize_env"]).toBeDefined();

    expect(byName["secr.get_secret"].description).toContain("allowlist");
    expect(byName["secr.list_envs"].description).toContain("never values");
  });
});
