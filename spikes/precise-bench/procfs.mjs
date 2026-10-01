// /proc helpers for measuring workerd's thread CPU from outside the Worker.
import { readdirSync, readFileSync } from "node:fs";

/** pids of direct children of `parent` whose comm matches. */
export function childPids(parent = process.pid, comm = /workerd/) {
  const out = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (ppid === parent && comm.test(name)) out.push(Number(entry));
    } catch {}
  }
  return out;
}

/** Map tid -> { comm, ns } for every thread of pid. */
export function threads(pid) {
  const map = new Map();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const ns = Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]);
      const comm = readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim();
      map.set(Number(tid), { comm, ns });
    } catch {}
  }
  return map;
}

export function diff(before, after) {
  const out = [];
  for (const [tid, a] of after) {
    const b = before.get(tid);
    out.push({ tid, comm: a.comm, ns: a.ns - (b?.ns ?? 0) });
  }
  return out.sort((x, y) => y.ns - x.ns);
}

export const threadNs = (pid, tid) =>
  Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]);

/** Steal and total jiffies from /proc/stat (aggregate cpu line). */
export function stealJiffies() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  return { steal: line[7], total: line.reduce((a, b) => a + b, 0) };
}
