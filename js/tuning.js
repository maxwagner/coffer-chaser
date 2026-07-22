// Tuning loader (SPEC §12 tuneStep). The Tuning tab → tunable-stat rows keyed by a
// system base ("Uaithne Helm", "Orna Weapon"), each row describing one stat's tuning
// economics. Reuses the Crafting tab's `[Mat N, #]` material-pair convention.
//
//   tuning[key] = [ {
//     stat,      // canonical in-game label (e.g. "ATT/M. ATT", "ATT Surplus II")
//     key,       // scored-stat key (SPEC §2); ATT Surplus/DES → "destruction"
//     step,      // stat gain per tick
//     maxTune,   // max TOTAL increase (a delta over the untuned Items value)
//     gold,      // flat gold per tick
//     materials, // [ { material, qty }, ... ] per tick
//     unlock,    // 0 base / 1 Surplus I / 2 Surplus II — cumulative gate
//   }, ... ]
//
// The cost of tuning a stat to its cap is ceil(MaxTune / Step) ticks × the per-tick
// (gold + Σ qty·cost(material)); the final tick may yield a partial stat gain but
// still costs a full tick. Pricing + the unlock gate live in solver.js (tuneMoves).

import {
  TUNING_CSV_URL, TUNING_CSV_FALLBACK, TUNING_COLUMNS, TUNING_MAX_MATERIALS,
  TUNING_STAT_TO_KEY,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

export function rowsToTuning(rows) {
  if (!rows.length) return {};
  const header = rows[0].map((h) => h.trim());
  const idx = headerIndex(rows[0], TUNING_COLUMNS);

  // Locate each "Mat N" block (name + following "#" qty) by header position.
  const blocks = [];
  for (let n = 1; n <= TUNING_MAX_MATERIALS; n++) {
    const c = header.indexOf(`Mat ${n}`);
    if (c === -1) continue;
    blocks.push({ name: c, qty: c + 1 });
  }

  const tuning = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const item = (row[idx.item] || "").trim();
    const statLabel = (row[idx.stat] || "").trim();
    if (!item || !statLabel) continue;
    const key = TUNING_STAT_TO_KEY[statLabel];
    if (!key) continue; // unknown stat label → skip (never guess a mapping)

    const materials = [];
    for (const b of blocks) {
      const mat = (row[b.name] || "").trim();
      if (!mat) continue;
      materials.push({ material: mat, qty: toInt(row[b.qty]) ?? 1 });
    }

    (tuning[item] ||= []).push({
      stat: statLabel,
      key,
      step: toInt(row[idx.step]) ?? 0,
      maxTune: toInt(row[idx.maxTune]) ?? 0,
      gold: toInt(row[idx.gold]) ?? 0,
      materials,
      unlock: toInt(row[idx.unlock]) ?? 0,
    });
  }
  return tuning;
}

// Returns { tuning, source, liveError? }.
export async function loadTuning() {
  const { rows, source, liveError } = await fetchSheetRows(TUNING_CSV_URL, TUNING_CSV_FALLBACK);
  return { tuning: rowsToTuning(rows), source, liveError };
}
