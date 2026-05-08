#!/usr/bin/env tsx
/**
 * Smoke test: load plugin config from ~/.openclaw/openclaw.json, init the
 * broker, and call list_envs against the secr API. Proves that what the
 * `secr.list_envs` tool will do at runtime works end-to-end.
 *
 * Run: cd integrations/openclaw-plugin && npx tsx scripts/smoke-broker.ts
 */
import { PluginState } from "../src/state.js";

async function main() {
  const state = new PluginState({ enforceGateway: true });
  console.log("Initialising broker (reads ~/.openclaw/openclaw.json)…");
  const broker = await state.getBroker();
  console.log(`Broker ready: ${broker.org}/${broker.project}/${broker.environment}\n`);

  console.log("Calling broker.getAll()…");
  const all = await broker.getAll();
  const keys = Object.keys(all).sort();
  if (keys.length === 0) {
    console.log("No allowlisted secrets visible.");
  } else {
    console.log(`Allowlisted secrets (${keys.length}): ${keys.join(", ")}`);
  }
  // Never print values — just counts.
}

main().catch((err) => {
  console.error("smoke-broker failed:", err?.message ?? err);
  process.exit(1);
});
