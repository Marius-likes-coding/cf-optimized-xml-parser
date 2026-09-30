#!/usr/bin/env node
/**
 * Combines bench/results/perf-local.json and perf-remote.json into one markdown report. With
 * --comment it keeps the report as a single pull request comment, updated on every run.
 *
 * Usage: node scripts/bench-report.mjs [--comment]
 *   env: LOCAL_RESULT, REMOTE_RESULT (the jobs' results, for a missing report),
 *        BENCH ("false" when the change touches nothing the benchmarks measure),
 *        REMOTE ("false" when the remote check wasn't requested: no `perf-remote` label),
 *        REMOTE_SKIPPED ("true" when the remote job had no Cloudflare token), RUN_URL;
 *        with --comment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { renderReport } from "./bench-stats.mjs";

const MARKER = "<!-- perf-report -->";
const load = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

function section(report, label, result, skippedNote) {
  if (report) return renderReport(report);
  if (skippedNote) return `### ${label}\n\n${skippedNote}`;
  return `### ${label}\n\nNo result: the job ended with \`${result ?? "unknown"}\`. See the run log.`;
}

const benchSkipped = process.env.BENCH === "false";
const local = load("bench/results/perf-local.json");
const remote = load("bench/results/perf-remote.json");
const body = [
  MARKER,
  "## Performance: base vs this PR",
  "",
  section(
    local,
    "Local",
    process.env.LOCAL_RESULT,
    benchSkipped
      ? "Skipped: this pull request changes nothing the benchmarks measure (parser, bench scripts, gates, dependencies, the perf workflow)."
      : undefined,
  ),
  "",
  section(
    remote,
    "Remote",
    process.env.REMOTE_RESULT,
    benchSkipped
      ? "Skipped, like the local check."
      : process.env.REMOTE_SKIPPED === "true"
        ? "Skipped: no Cloudflare token (pull requests from forks and Dependabot get no secrets)."
        : process.env.REMOTE === "false"
          ? "Not requested: add the `perf-remote` label to measure on Cloudflare (report only; it missed a 14% slowdown in calibration, see bench/README.md)."
          : undefined,
  ),
  "",
  `<sub>Gate: local ≥ 5% (cold, warm) when the change is significant; override with the label \`perf-regression-accepted\`. The Cloudflare comparison is report-only. ${process.env.RUN_URL ? `[Run](${process.env.RUN_URL})` : ""}</sub>`,
].join("\n");

console.log(body);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);

if (process.argv.includes("--comment")) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = process.env;
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    return response.json();
  };
  try {
    let existing;
    for (let page = 1; page <= 10 && !existing; page++) {
      const comments = await api(`/issues/${pr}/comments?per_page=100&page=${page}`);
      existing = comments.find((c) => c.body?.startsWith(MARKER));
      if (comments.length < 100) break;
    }
    await (existing
      ? api(`/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
      : api(`/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
    console.error(existing ? `updated comment ${existing.id}` : "created the report comment");
  } catch (error) {
    // Pull requests from forks get a read-only token; the step summary still has the report.
    console.error(`could not write the PR comment: ${error.message}`);
  }
}
