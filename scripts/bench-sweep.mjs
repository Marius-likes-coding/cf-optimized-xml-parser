#!/usr/bin/env node
/**
 * Deletes per-run bench Workers (`cfxp-bench-*`, see scripts/bench-remote.mjs) that are older
 * than MAX_AGE_HOURS, left behind by runs that died before their cleanup step.
 *
 * Usage: node scripts/bench-sweep.mjs
 *   env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, MAX_AGE_HOURS (default 2)
 */
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const maxAgeMs = Number(process.env.MAX_AGE_HOURS ?? "2") * 3_600_000;
if (!token || !account) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}

const api = async (path, method = "GET") => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts${path}`,
    { method, headers: { authorization: `Bearer ${token}` } },
  );
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`${method} ${path || "/"}: ${response.status} ${JSON.stringify(body.errors)}`);
  }
  return body.result;
};

const scripts = await api("");
const stale = scripts.filter(
  (script) =>
    script.id.startsWith("cfxp-bench-") &&
    Date.now() - Date.parse(script.modified_on ?? script.created_on) > maxAgeMs,
);
for (const script of stale) {
  await api(`/${script.id}?force=true`, "DELETE");
  console.log(`deleted ${script.id}`);
}
console.log(`${stale.length} stale bench Worker(s) deleted, ${scripts.length - stale.length} kept`);
