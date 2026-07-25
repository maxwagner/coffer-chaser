// Items loader: the Items tab → the full candidate menu per slot. Each row is one
// purchasable/craftable base item with its point-giving stat line (SPEC §8).
//
//   item = {
//     name,      // marketplace name; key into the price feed and recipes
//     level,     // game item level (informational / within-slot ordering)
//     slotIds,   // [slotId, ...]  ("Ring 1, Ring 2" → ["ring1","ring2"])
//     stats,     // scored stats only (SPEC §2), zero-valued keys omitted
//     effect,    // informational text; "" if none
//   }
//
// Slot labels are shared with the Enchants tab (SLOT_NAME_TO_ID), but stat columns
// are not: this tab uses the long headers (ITEM_STAT_COLUMNS). HP/Stam columns
// exist in the sheet but are deliberately not parsed, not part of the score.

import {
  ITEMS_CSV_URL, ITEMS_CSV_FALLBACK, ITEMS_COLUMNS,
  ITEM_STAT_COLUMNS, SLOT_NAME_TO_ID,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

export function rowsToItems(rows) {
  if (!rows.length) return [];
  const idx = headerIndex(rows[0], ITEMS_COLUMNS);
  const statIdx = headerIndex(
    rows[0],
    Object.fromEntries(Object.keys(ITEM_STAT_COLUMNS).map((c) => [c, c]))
  );

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;

    // A Slot cell may name more than one slot ("Ring 1, Ring 2").
    // Slot=Legacy keeps the row with NO slots: catalog-only old gear, priced and
    // tracked but never a base-swap candidate (mirrors the enchant Legacy group).
    const legacy = (row[idx.slot] || "").trim() === "Legacy";
    const slotIds = legacy ? [] : (row[idx.slot] || "")
      .split(",")
      .map((s) => SLOT_NAME_TO_ID[s.trim()])
      .filter(Boolean);
    if (!slotIds.length && !legacy) continue; // unknown/empty slot label → skip

    const stats = {};
    for (const [col, key] of Object.entries(ITEM_STAT_COLUMNS)) {
      const v = toInt(row[statIdx[col]]);
      if (v) stats[key] = v; // omit zero/blank
    }

    items.push({
      name,
      level: toInt(row[idx.level]),
      slotIds,
      legacy,
      stats,
      effect: (row[idx.effect] || "").trim(),
    });
  }
  return items;
}

// Group a flat item list by slot id. An item that applies to several slots
// appears under each (a shared candidate menu, same item, two ring slots).
export function itemsBySlot(items) {
  const bySlot = {};
  for (const item of items) {
    for (const slotId of item.slotIds) (bySlot[slotId] ||= []).push(item);
  }
  return bySlot;
}

// Returns { items, bySlot, source, liveError? }.
export async function loadItems() {
  const { rows, source, liveError } = await fetchSheetRows(ITEMS_CSV_URL, ITEMS_CSV_FALLBACK);
  const items = rowsToItems(rows);
  return { items, bySlot: itemsBySlot(items), source, liveError };
}
