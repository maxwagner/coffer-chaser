// Raid Drops loader (SPEC §16.8): published Google Sheet CSV → a { raid: [item, …] }
// map, one entry per raid/battle listing its canonical drop table. The Scanner
// raid-drop tracker uses this to scope OCR name-matching to the picked raid's known
// drops (a tiny exact vocabulary) and to label a scanned run.

import { RAID_DROPS_CSV_URL, RAID_DROPS_CSV_FALLBACK, RAID_DROPS_COLUMNS } from "./config.js";
import { fetchSheetRows, headerIndex } from "./sheet.js";

// rows (incl. header) → { raidName: [itemName, …] }, preserving sheet order and
// de-duplicating repeated (raid,item) pairs. Rows missing a raid or item are skipped.
export function rowsToRaidDrops(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], RAID_DROPS_COLUMNS);
  const out = {};
  for (let r = 1; r < rows.length; r++) {
    const raid = (rows[r][idx.raid] || "").trim();
    const item = (rows[r][idx.item] || "").trim();
    if (!raid || !item) continue;
    (out[raid] ||= []);
    if (!out[raid].includes(item)) out[raid].push(item);
  }
  return out;
}

// Returns { raidDrops, source, liveError? }.
export async function loadRaidDrops() {
  const { rows, source, liveError } = await fetchSheetRows(RAID_DROPS_CSV_URL, RAID_DROPS_CSV_FALLBACK);
  return { raidDrops: rowsToRaidDrops(rows), source, liveError };
}
