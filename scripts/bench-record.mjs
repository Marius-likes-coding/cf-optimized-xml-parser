#!/usr/bin/env node
/**
 * Commit a bench results file to the `bench-history` branch (created on first use).
 * History lives off `main` so these commits never race semantic-release's release
 * commit, and local and remote results stay in separate folders.
 *
 * Usage: node scripts/bench-record.mjs <results.json> <local|remote>
 * Writes <local|remote>/<UTC timestamp>-<sha>.json, so names sort chronologically.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRANCH = "bench-history";
const [source, kind] = process.argv.slice(2);
if (!source || (kind !== "local" && kind !== "remote")) {
  console.error("Usage: node scripts/bench-record.mjs <results.json> <local|remote>");
  process.exit(2);
}

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};
const git = (args, cwd) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
function tryGit(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

const sha = git(["rev-parse", "--short", "HEAD"]);
const stamp = new Date().toISOString().replaceAll(":", "-");
const dest = `${kind}/${stamp}-${sha}.json`;
const dir = mkdtempSync(join(tmpdir(), "bench-history-"));

try {
  if (tryGit(["fetch", "--quiet", "origin", BRANCH])) {
    git(["worktree", "add", "--quiet", "--detach", dir, "FETCH_HEAD"]);
  } else {
    git(["worktree", "add", "--quiet", "--orphan", "-b", BRANCH, dir]);
  }
  mkdirSync(join(dir, kind), { recursive: true });
  copyFileSync(source, join(dir, dest));
  git(["add", dest], dir);
  git(["commit", "--quiet", "--no-verify", "-m", `chore(bench): record ${dest}`], dir);

  // Another run may have pushed meanwhile; file names are unique, so rebasing never conflicts.
  for (let attempt = 1; ; attempt++) {
    if (tryGit(["push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`], dir)) break;
    if (attempt === 5) throw new Error(`could not push to ${BRANCH} after ${attempt} attempts`);
    git(["fetch", "--quiet", "origin", BRANCH], dir);
    git(["rebase", "--quiet", "FETCH_HEAD"], dir);
  }
  console.log(`Recorded ${dest} on ${BRANCH}`);
} finally {
  tryGit(["worktree", "remove", "--force", dir]);
}
