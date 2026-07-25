// Crafting recipe loader: the Crafting tab → a recipe map keyed by output item.
//
//   recipes[itemName] = { fee, materials: [ { material, qty }, ... ] }
//
// One unified tab now holds ordinary craftables AND the weapon/armor tier-chain
// recipes (SPEC §4). Both are "just crafting". Each material is a name + qty
// ("#") pair; per-line "$" / "Craft Price" snapshots are gone (the app recomputes
// craft cost live, see craftCost in cost.js). A tier's recipe lists the PREVIOUS
// tier as a material, so the recursive craftCost rolls up the whole chain.

import {
  CRAFTING_CSV_URL, CRAFTING_CSV_FALLBACK, CRAFTING_COLUMNS, CRAFTING_MAX_MATERIALS,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

export function rowsToRecipes(rows) {
  if (!rows.length) return { recipes: {} };
  const header = rows[0].map((h) => h.trim());
  const idx = headerIndex(rows[0], CRAFTING_COLUMNS);

  // Locate each "Item N" block (name + following "#" qty) by header position.
  const blocks = [];
  for (let n = 1; n <= CRAFTING_MAX_MATERIALS; n++) {
    const c = header.indexOf(`Item ${n}`);
    if (c === -1) continue;
    blocks.push({ name: c, qty: c + 1 }); // name, "#"
  }

  const recipes = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    const materials = [];
    for (const b of blocks) {
      const mat = (row[b.name] || "").trim();
      if (!mat) continue;
      materials.push({ material: mat, qty: toInt(row[b.qty]) ?? 1 });
    }
    const fee = toInt(row[idx.fee]);
    // A row with NO materials is a recipe only when its Gold cell is explicitly filled.
    // That is how the sheet declares a FREE-ISSUE item: the "+12 Orna <slot>" starting
    // gear from the Lv.115 box, obtainable at a flat fee (0) with nothing consumed. It
    // has no market listing, so without this it would price as null and make the whole
    // Orna→Uaithne chain above it unpriceable. Requiring the fee cell keeps a stray
    // name typed into column A (no gold, no materials) from silently becoming free.
    if (!materials.length && fee == null) continue; // no recipe → not craftable
    recipes[name] = { fee: fee ?? 0, materials };
  }
  return { recipes };
}

// Returns { recipes, source, liveError? }.
export async function loadRecipes() {
  const { rows, source, liveError } = await fetchSheetRows(CRAFTING_CSV_URL, CRAFTING_CSV_FALLBACK);
  return { ...rowsToRecipes(rows), source, liveError };
}
