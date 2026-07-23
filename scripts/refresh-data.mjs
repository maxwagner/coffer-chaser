// Refresh the offline CSV snapshots in data/ from the published Google Sheet.
//
//   node scripts/refresh-data.mjs            # fetch every tab, write changed files
//   node scripts/refresh-data.mjs --check    # fetch + report drift, write nothing (exit 1 if drift)
//   node scripts/refresh-data.mjs prices raid_info    # only these snapshots
//
// The tab list is NOT maintained here: it is read straight out of js/config.js by
// pairing each `*_CSV_URL` export with its `*_CSV_FALLBACK` sibling, so a tab added
// to config is picked up automatically. The snapshots are only the offline fallback
// (js/sheet.js prefers the live sheet), so the point of refreshing is mainly SHAPE:
// new columns/rows must exist in the snapshot or an offline load reads a stale schema.

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

let changed = 0, failed = 0;
for (const tab of wanted) {
  let live;
  try {
    const res = await fetch(tab.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live = await res.text();
    // A published sheet that 404s inside Google still answers 200 with HTML.
    if (/^\s*</.test(live)) throw new Error("got HTML, not CSV (bad gid or unpublished tab?)");
  } catch (err) {
    console.error(`  FAIL ${tab.name}: ${err.message}`);
    failed++;
    continue;
  }
  const old = await readFile(tab.file, "utf8").catch(() => null);
  if (old != null && norm(old) === norm(live)) {
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
