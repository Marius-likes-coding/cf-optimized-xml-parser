#!/usr/bin/env node
/**
 * Run a command with MINIFLARE_WORKERD_V8_FLAGS set to one profile from scripts/v8-profiles.mjs,
 * so every workerd it starts (vitest pool, wrangler dev, Miniflare) uses those V8 flags.
 *
 * Usage: node scripts/with-v8-profile.mjs <profile> <command> [args...]
 *   e.g. node scripts/with-v8-profile.mjs full vitest bench --run --project workers
 */
import { spawnSync } from "node:child_process";
import { PROFILES } from "./v8-profiles.mjs";

const [profile, command, ...args] = process.argv.slice(2);
const flags = PROFILES[profile];
if (flags === undefined || command === undefined) {
  console.error(
    `usage: node scripts/with-v8-profile.mjs <${Object.keys(PROFILES).join("|")}> <command> [args...]`,
  );
  process.exit(2);
}
const run = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, MINIFLARE_WORKERD_V8_FLAGS: flags },
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
