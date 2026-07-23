// Enhancement loader (SPEC §12 gear +N→+15). The Enhancement tab → one row per
// +level step, keyed by the FROM level:
//
//   steps[from] = {
//     from, to,            // +level step (e.g. 12 → 13)
//     rates,               // ABSOLUTE per-attempt success %, rates[0] = 1st attempt,
//                          // rates[k] = the rate after k consecutive failures, last = 100
//     gold,                // flat gold fee per attempt
//     materials,           // { name: qty } consumed per attempt
//   }
//
// Failure keeps the level (no downgrade), so a step is a finite EV series
// (gearEnhanceCost in cost.js). Rates are read as ABSOLUTE per-attempt values
// (Base + Fail1..N columns) so there's no additive/cumulative ambiguity.

import {
  ENHANCEMENT_CSV_URL, ENHANCEMENT_CSV_FALLBACK, ENHANCEMENT_COLUMNS,
  ENHANCEMENT_MAX_FAILS, ENHANCEMENT_MAX_MATERIALS,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

export function rowsToEnhancement(rows) {
  if (!rows.length) return {};
  const header = rows[0].map((h) => h.trim());
  const idx = headerIndex(rows[0], ENHANCEMENT_COLUMNS);

  // Absolute per-attempt rate columns in order: Base, then Fail1..N.
  const rateCols = [idx.base];
  for (let n = 1; n <= ENHANCEMENT_MAX_FAILS; n++) {
    const c = header.indexOf(`Fail${n}`);
    if (c !== -1) rateCols.push(c);
  }
  // Material name/qty pairs: "Material N" + "Qty N".
  const matCols = [];
  for (let n = 1; n <= ENHANCEMENT_MAX_MATERIALS; n++) {
    const name = header.indexOf(`Material ${n}`), qty = header.indexOf(`Qty ${n}`);
    if (name !== -1 && qty !== -1) matCols.push({ name, qty });
  }

  const steps = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const from = toInt(row[idx.from]);
    if (from == null) continue;
    // Trailing blanks (a step that guarantees earlier) drop out → rates ends at 100.
    const rates = rateCols.map((c) => toInt(row[c])).filter((v) => v != null);
    const materials = {};
    for (const { name, qty } of matCols) {
      const nm = (row[name] || "").trim();
      const q = toInt(row[qty]);
      if (nm && q) materials[nm] = q;
    }
    steps[from] = { from, to: toInt(row[idx.to]), rates, gold: toInt(row[idx.gold]) ?? 0, materials };
  }
  return steps;
}

// Returns { enhancement, source, liveError? }.
export async function loadEnhancement() {
  const { rows, source, liveError } = await fetchSheetRows(ENHANCEMENT_CSV_URL, ENHANCEMENT_CSV_FALLBACK);
  return { enhancement: rowsToEnhancement(rows), source, liveError };
}
