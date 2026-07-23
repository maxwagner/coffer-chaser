// Accessory enhancement loader (SPEC §6 enhanceStep). The source CSV is unlike the
// other tabs: it stacks several tables separated by blank rows.
//
//   1. a shared "Chances" pity table: rows = enhance level 1-20, columns 1x..10x =
//      the additive % bonus to the base success rate after that many CONSECUTIVE
//      failures (a 100 sentinel = guaranteed; see SPEC §6);
//   2. one stat/cost table per item-level bracket ("Level 125", "Level 120", …),
//      rows = enhance level 1-20, fixed columns [Level, Success Rate, Att, Def Pen,
//      Gold] then per-bracket material columns named by that block's own header.
//
// Failure keeps the level (no downgrade), so step cost is a finite EV series
// (computed in cost.js). Output:
//
//   { pity:     { [level]: [bonus1, bonus2, …] },          // % points per fail count
//     brackets: { [itemLevel]: [ { level, successRate, att, defPen, gold,
//                                  materials: { name: qty } }, … ] } }

import { ACCESSORIES_CSV_URL, ACCESSORIES_CSV_FALLBACK, ACCESSORY_ENHANCE_COLUMNS } from "./config.js";
import { fetchSheetRows, toInt } from "./sheet.js";

const isBlank = (row) => row.every((c) => (c || "").trim() === "");

// Split the sheet into blocks of contiguous non-blank rows.
function splitBlocks(rows) {
  const blocks = [];
  let cur = [];
  for (const row of rows) {
    if (isBlank(row)) { if (cur.length) blocks.push(cur); cur = []; }
    else cur.push(row);
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

export function rowsToAccessories(rows) {
  const pity = {};
  const brackets = {};
  const C = ACCESSORY_ENHANCE_COLUMNS;

  for (const block of splitBlocks(rows)) {
    const header = block[0];
    const label = (header[0] || "").trim();

    if (label.toLowerCase() === "chances") {
      for (let r = 1; r < block.length; r++) {
        const level = toInt(block[r][0]);
        if (level == null) continue;
        // bonuses are the filled columns after the level; blanks (early levels) → []
        pity[level] = block[r].slice(1).map(toInt).filter((v) => v != null);
      }
      continue;
    }

    const m = label.match(/^Level\s+(\d+)/i);
    if (!m) continue; // unknown block → skip
    const itemLevel = +m[1];

    // Material columns: every named header from firstMaterial onward.
    const materialCols = [];
    for (let c = C.firstMaterial; c < header.length; c++) {
      const name = (header[c] || "").trim();
      if (name) materialCols.push({ c, name });
    }

    const table = [];
    for (let r = 1; r < block.length; r++) {
      const row = block[r];
      const level = toInt(row[C.level]);
      if (level == null) continue;
      const materials = {};
      for (const { c, name } of materialCols) {
        const qty = toInt(row[c]); // "-"/blank → null → omitted
        if (qty) materials[name] = qty;
      }
      table.push({
        level,
        successRate: toInt(row[C.successRate]),
        att: toInt(row[C.att]) || 0,
        defPen: toInt(row[C.defPen]) || 0,
        gold: toInt(row[C.gold]) || 0,
        materials,
      });
    }
    brackets[itemLevel] = table;
  }
  return { pity, brackets };
}

// Returns { accessories: { pity, brackets }, source, liveError? }.
export async function loadAccessories() {
  const { rows, source, liveError } = await fetchSheetRows(ACCESSORIES_CSV_URL, ACCESSORIES_CSV_FALLBACK);
  return { accessories: rowsToAccessories(rows), source, liveError };
}
