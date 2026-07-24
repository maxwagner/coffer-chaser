// Refresh the offline CSV snapshots in data/ from the published Google Sheet.
//
//   node scripts/refresh-data.mjs            # fetch every tab, write changed files
//   node scripts/refresh-data.mjs --check    # fetch + report drift, write nothing (exit 1 if drift)
//   node scripts/refresh-data.mjs prices raid_info    # only these snapshots
//
// The tab list is NOT maintained here: it is read straight out of js/config.js by
// pairing each `*_CSV_URL` export with its `*_CSV_FALLBACK` sibling, so a tab added
// to config is picked up automatically. The snapshots are the app's ONLY runtime data
// (js/sheet.js is snapshot-only; the Sheet pushes edits here via repository_dispatch),
// so this script is the sole bridge between the Sheet and what users see.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await import(path.join(root, "js", "config.js").replace(/\\/g, "/").replace(/^/, "file:///"));

// { name, url, file } per tab, derived from the config exports.
const tabs = Object.keys(config)
  .filter((k) => k.endsWith("_CSV_URL") && typeof config[`${k.slice(0, -4)}_FALLBACK`] === "string")
  .map((k) => ({
    name: path.basename(config[`${k.slice(0, -4)}_FALLBACK`], ".csv"),
    url: config[k],
    file: path.join(root, config[`${k.slice(0, -4)}_FALLBACK`]),
  }));

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.filter((a) => !a.startsWith("--"));
const wanted = only.length ? tabs.filter((t) => only.includes(t.name)) : tabs;
if (!wanted.length) {
  console.error(`No matching tabs. Known: ${tabs.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const rowCount = (s) => norm(s).split("\n").length;

// Order-insensitive comparison. Sorting (or un-filtering) the Sheet reorders
// the published CSV without changing its content; comparing the two sides as
// sorted record sets makes a pure reorder a no-op, so no churn commit. Used
// ONLY for the compare: written snapshots stay verbatim in Sheet order.
// Records, not lines: a quoted field may contain a newline, so a line with an
// odd quote count is glued to the next until quotes balance.
const canon = (s) => {
  const records = [];
  let buf = null;
  for (const line of norm(s).split("\n")) {
    buf = buf == null ? line : buf + "\n" + line;
    if (((buf.match(/"/g) || []).length) % 2 === 0) { records.push(buf); buf = null; }
  }
  if (buf != null) records.push(buf); // unbalanced tail: keep rather than drop
  const [head, ...rows] = records;
  rows.sort();
  return [head, ...rows].join("\n");
};

// Tabs where row POSITION carries meaning (accessories = blank-row-separated
// blocks with per-block headers): moving rows there is a real change, so they
// get the plain byte compare. Never sort/filter these sheets.
const ORDER_SENSITIVE = new Set(["accessories"]);

// The publish endpoint sometimes stalls a request without erroring (the same
// behavior that made the app go snapshot-only). Abort at 30s and retry once so
// one hung tab costs a minute, not the workflow's whole job budget.
const FETCH_TIMEOUT_MS = 30_000;
async function fetchCsv(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // A published sheet that 404s inside Google still answers 200 with HTML.
      if (/^\s*</.test(text)) throw new Error("got HTML, not CSV (bad gid or unpublished tab?)");
      return text;
    } catch (err) {
      lastErr = err.name === "TimeoutError" ? new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`) : err;
    }
  }
  throw lastErr;
}

let changed = 0, failed = 0;
for (const tab of wanted) {
  let live;
  try {
    live = await fetchCsv(tab.url);
  } catch (err) {
    console.error(`  FAIL ${tab.name}: ${err.message}`);
    failed++;
    continue;
  }
  const old = await readFile(tab.file, "utf8").catch(() => null);
  const cmp = ORDER_SENSITIVE.has(tab.name) ? norm : canon;
  if (old != null && cmp(old) === cmp(live)) {
    console.log(`  same ${tab.name} (${rowCount(live)} rows)`);
    continue;
  }
  // No snapshot at all = a tab was added to config.js without one, so an offline
  // load would 404 that fetch. Called out separately from ordinary content drift.
  const delta = old == null ? "NO SNAPSHOT YET — creating" : `${rowCount(old)} → ${rowCount(live)} rows`;
  const oldHead = old == null ? "" : norm(old).split("\n")[0];
  const newHead = norm(live).split("\n")[0];
  const shape = oldHead && oldHead !== newHead ? " · HEADER CHANGED" : "";
  changed++;
  if (check) { console.log(`  DRIFT ${tab.name} (${delta})${shape}`); continue; }
  await writeFile(tab.file, norm(live) + "\n", "utf8");
  console.log(`  wrote ${tab.name} (${delta})${shape}`);
}

console.log(check
  ? `${changed} snapshot(s) drifted, ${failed} failed`
  : `${changed} snapshot(s) updated, ${failed} failed`);
process.exit(failed ? 1 : (check && changed ? 1 : 0));
