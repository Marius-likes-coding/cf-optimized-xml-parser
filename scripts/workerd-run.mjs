/**
 * Helpers for measuring code in standalone local workerd, outside vitest: bundle a Worker with
 * esbuild, start Miniflare with V8 flags, and read heap usage through the DevTools protocol.
 *
 * `miniflare` resolves to the copy @cloudflare/vitest-pool-workers installs, so these tools run
 * the same workerd build as `npm run bench`.
 */
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const MATRIX_DIR = "test/fixtures/generated/matrix";

/** Matrix fixture names (without .xml), sorted. */
export function matrixFixtures() {
  return readdirSync(MATRIX_DIR)
    .filter((file) => file.endsWith(".xml"))
    .map((file) => file.slice(0, -4))
    .sort();
}

/** Parses "path/to/module.ts#exportName"; the export defaults to `parse`. */
export function parserSpec(spec) {
  const [path, exportName = "parse"] = spec.split("#");
  return { path: resolve(path), exportName };
}

/** Bundles an ES module source (imports may use absolute paths) into one script for workerd. */
export async function bundleWorker(source) {
  const result = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * Starts local workerd with one isolate per name, all running `script`, under `flags`. Pass
 * `workers: [{ name, script }]` instead to give isolates different scripts.
 */
export async function startWorkerd({
  script,
  names = ["main"],
  workers = names.map((name) => ({ name, script })),
  flags = "",
  inspectorPort,
}) {
  // Miniflare splits on single spaces and workerd aborts on the resulting empty flag.
  process.env.MINIFLARE_WORKERD_V8_FLAGS = flags.trim().replaceAll(/\s+/g, " ");
  const options = convertV4MiniflareOptions({
    workers: workers.map((worker) => ({
      name: worker.name,
      modules: true,
      script: worker.script,
      compatibilityDate: "2026-08-01",
    })),
  });
  const mf = new Miniflare(inspectorPort === undefined ? options : { ...options, inspectorPort });
  await mf.ready;
  return mf;
}

/** Opens a DevTools session on one Worker's isolate. `heapUsed()` returns V8's used heap bytes. */
export async function inspect(port, name) {
  const listing = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listing.json();
  const target = targets.find((t) => t.webSocketDebuggerUrl?.endsWith(`/core:user:${name}`));
  if (!target) throw new Error(`no inspector target for worker "${name}"`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok);
    ws.addEventListener("error", fail);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const call = (method) =>
    new Promise((ok) => {
      id++;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method }));
    });
  return {
    heapUsed: async () => {
      const usage = await call("Runtime.getHeapUsage");
      return usage.usedSize;
    },
    close: () => ws.close(),
  };
}
