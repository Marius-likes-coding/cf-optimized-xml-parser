/**
 * Helpers for measuring code in standalone local workerd, outside vitest: bundle a Worker with
 * esbuild, start Miniflare with V8 flags, and read heap usage through the DevTools protocol.
 *
 * `miniflare` resolves to the copy @cloudflare/vitest-pool-workers installs, so these tools run
 * the same workerd build as `npm run bench`.
 */
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { readdirSync, readFileSync } from "node:fs";
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
 * `workers: [{ name, script }]` instead to give isolates different scripts. `directSockets`
 * gives every Worker its own socket (`mf.unsafeGetDirectURL(name)`), bypassing Miniflare's entry
 * Worker, which costs ~0.4 ms of workerd CPU per request.
 */
export async function startWorkerd({
  script,
  names = ["main"],
  workers = names.map((name) => ({ name, script })),
  flags = "",
  inspectorPort,
  directSockets = false,
}) {
  // Miniflare splits on single spaces and workerd aborts on the resulting empty flag.
  process.env.MINIFLARE_WORKERD_V8_FLAGS = flags.trim().replaceAll(/\s+/g, " ");
  const options = convertV4MiniflareOptions({
    workers: workers.map((worker) => ({
      name: worker.name,
      modules: true,
      script: worker.script,
      compatibilityDate: "2026-08-01",
      ...(directSockets && { unsafeDirectSockets: [{ port: 0, proxy: false }] }),
    })),
  });
  const mf = new Miniflare(inspectorPort === undefined ? options : { ...options, inspectorPort });
  await mf.ready;
  return mf;
}

/** pids of the workerd processes this Node process started (Linux; empty elsewhere). */
function workerdChildren() {
  const pids = new Set();
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (ppid === process.pid && stat.slice(stat.indexOf("(") + 1, close) === "workerd") {
        pids.add(Number(entry));
      }
    } catch {
      // the process exited meanwhile
    }
  }
  return pids;
}

/**
 * CPU time of workerd's main thread in ns, from /proc (Linux). Every isolate's JavaScript runs on
 * that thread, and with PROD_FLAGS so does all JIT compilation; V8's helper threads (parallel GC)
 * add 1–3% that Cloudflare doesn't bill to the request either. Read between requests, while the
 * thread waits, the value is exact. Returns null when /proc isn't available.
 */
export function threadCpuReader(pid) {
  const path = `/proc/${pid}/task/${pid}/schedstat`;
  try {
    readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return () => Number(readFileSync(path, "utf8").split(" ", 1)[0]);
}

/**
 * Starts workerd for paired benchmarks: every Worker gets a direct socket, and `cpuNs()` reads the
 * process's JavaScript thread (null off Linux). `call(name, query)` sends /run?query to one Worker
 * and returns the parsed JSON body.
 */
export async function startBenchWorkerd({ workers, flags }) {
  const before = workerdChildren();
  const mf = await startWorkerd({ workers, flags, directSockets: true });
  const started = [...workerdChildren()].filter((pid) => !before.has(pid));
  const cpuNs = started.length === 1 ? threadCpuReader(started[0]) : null;
  const urls = new Map(
    await Promise.all(workers.map(async (w) => [w.name, await mf.unsafeGetDirectURL(w.name)])),
  );
  return {
    cpuNs,
    async call(name, query) {
      const response = await fetch(new URL(`/run?${new URLSearchParams(query)}`, urls.get(name)));
      const text = await response.text();
      if (!response.ok) throw new Error(`/run ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
    dispose: () => mf.dispose(),
  };
}

/** The CPU affinity of this process (Linux), e.g. "1-3"; inherited by workerd. */
export function cpuAffinity() {
  try {
    return readFileSync("/proc/self/status", "utf8").match(/Cpus_allowed_list:\s*(\S+)/)?.[1];
  } catch {
    return;
  }
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
