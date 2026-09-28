/**
 * V8 flag sets for local workerd, passed through MINIFLARE_WORKERD_V8_FLAGS (honored by
 * wrangler dev, vitest-pool-workers and Miniflare). workerd aborts on an unknown flag, so every
 * name here was checked against workerd 1.20260815 (V8 15.1).
 */

/**
 * Cloudflare's production embedder turns these off (workerd src/workerd/jsg/setup.h), so all
 * JIT compilation runs on the request thread and is billed as its CPU time. Open-source
 * workerd leaves them on; every profile below starts from this list to match production.
 */
export const PROD_FLAGS = [
  "--no-concurrent-recompilation",
  "--no-concurrent-sparkplug",
  "--no-maglev-build-code-on-background",
  "--no-maglev-deopt-data-on-background",
  "--no-lazy-compile-dispatcher",
  "--no-parallel-compile-tasks-for-eager-toplevel",
  "--no-parallel-compile-tasks-for-lazy",
].join(" ");

/**
 * Tier-pinned profiles. Cold isolates and rarely called functions run in the first two, which
 * is where research/v8-jit-tiering-workers-production.md says most production parses happen.
 */
export const PROFILES = {
  ignition: `${PROD_FLAGS} --no-sparkplug --no-maglev --no-turbofan`,
  sparkplug: `${PROD_FLAGS} --no-maglev --no-turbofan`,
  maglev: `${PROD_FLAGS} --no-turbofan`,
  full: PROD_FLAGS,
};
