// Legacy loader: the Legacy tab is one row per retired item (gear, material, or
// enchant scroll) that is still price-tracked but no longer in circulation.
//
//   legacy[name] = {
//     name,   // price-feed key (scroll names carry the full "... Enchant Scroll")
//     type,   // "Gear" | "Material" | "Enchant" ("" if blank); display/sort grouping only
//     affix,  // "P" | "S" | "" (enchants only; informational)
//     rank,   // rank (enchants) or item level (gear); "" if blank
//     stats,  // the old stat line as display TEXT, never parsed or scored
//   }
//
// Purely cosmetic data: the catalog uses it to render Legacy-kind rows (numeric
// columns blanked, hidden behind the Legacy chip). Pricing, craft costs, and the
// solver never consult it.

import { LEGACY_CSV_URL, LEGACY_CSV_FALLBACK, LEGACY_COLUMNS } from "./config.js";
import { fetchSheetRows, headerIndex } from "./sheet.js";

export function rowsToLegacy(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], LEGACY_COLUMNS);
  const byName = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    byName[name] = {
      name,
      type: (row[idx.type] || "").trim(),
      affix: (row[idx.affix] || "").trim().toUpperCase(),
      rank: (row[idx.rank] || "").trim(),
      stats: (row[idx.stats] || "").trim(),
    };
  }
  return byName;
}

// A legacy name that is still a live recipe ingredient is probably tagged by
// mistake (it keeps pricing fine — legacy is display-only — but it hides a row
// the user may want visible). Returns the offending names for a console warning.
export function legacyIngredientConflicts(legacy, recipes) {
  const inRecipes = new Set();
  for (const r of Object.values(recipes)) {
    for (const m of r.materials || []) inRecipes.add(m.material);
  }
  return Object.keys(legacy).filter((n) => inRecipes.has(n)).sort();
}

// Returns { legacy, source, liveError? }.
export async function loadLegacy() {
  const { rows, source, liveError } = await fetchSheetRows(LEGACY_CSV_URL, LEGACY_CSV_FALLBACK);
  return { legacy: rowsToLegacy(rows), source, liveError };
}
