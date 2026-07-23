// Enchant loader: the Enchants tab is one row per unique scroll. Applicability is
// encoded by the Tag column (expanded to slot ids via TAG_TO_SLOT_IDS); Family
// groups a tag's scrolls into upgrade chains / effect sets.
//
//   enchant = {
//     scroll,      // marketplace name; key into the price feed
//     affix,       // "prefix" | "suffix"  (one of each allowed per item)
//     rank,        // R (game rank; lower number = rarer/stronger)
//     tag,         // slot-group label (e.g. "Helm & Pants", "Accessory")
//     family,      // upgrade-chain / effect group within the slot ("" = default family)
//     minLevel,    // minimum ITEM level the scroll can be applied to (null = no requirement)
//     stats,       // scored stats only (SPEC §2), zero-valued keys omitted
//     appliesTo,   // [slotId, ...]  (secondary is excluded, no enchants/stats)
//     scrap,       // "Enchant Scroll Scrap: <base>" name (priced via the feed; the
//                  // feed gates availability, null only for unnamable scrolls)
//     effect,      // informational text (e.g. "27 Crit Dmg"); "" if none
//   }

import {
  ENCHANT_CSV_URL, ENCHANT_CSV_FALLBACK, ENCHANT_COLUMNS, ENCHANT_COL_WIDTH,
  ENCHANT_STAT_COLUMNS, TAG_TO_SLOT_IDS,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

// "Advent Enchant Scroll" → "Enchant Scroll Scrap: Advent"
function scrapName(scroll) {
  const base = scroll.replace(/\s*Enchant Scroll\s*$/i, "").trim();
  return base ? `Enchant Scroll Scrap: ${base}` : null;
}

export function rowsToEnchants(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], ENCHANT_COLUMNS, ENCHANT_COL_WIDTH);
  const statIdx = headerIndex(
    rows[0],
    Object.fromEntries(Object.keys(ENCHANT_STAT_COLUMNS).map((c) => [c, c])),
    ENCHANT_COL_WIDTH
  );

  const byScroll = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    // The tab lists short names ("Cool"); the price feed + loadout key on the full
    // marketplace name ("Cool Enchant Scroll"). Normalize so both resolve.
    const scroll = /enchant scroll$/i.test(name) ? name : `${name} Enchant Scroll`;

    const tag = (row[idx.tag] || "").trim();
    const slotIds = TAG_TO_SLOT_IDS[tag];
    if (!slotIds) continue; // unknown tag → skip (surface later if needed)

    const stats = {};
    for (const [col, key] of Object.entries(ENCHANT_STAT_COLUMNS)) {
      const v = toInt(row[statIdx[col]]);
      if (v) stats[key] = v; // omit zero/blank
    }
    byScroll[scroll] = {
      scroll,
      affix: (row[idx.affix] || "").trim().toUpperCase() === "S" ? "suffix" : "prefix",
      // numeric ranks kept as numbers; letter ranks (A/B/C…) kept as strings
      rank: (() => { const r = (row[idx.rank] || "").trim(); return /^\d+$/.test(r) ? +r : (r || null); })(),
      tag,
      family: (row[idx.family] || "").trim(),
      minLevel: toInt(row[idx.minLevel]) || null, // blank/0 → no requirement
      stats,
      appliesTo: [...slotIds],
      scrap: scrapName(scroll),
      effect: (row[idx.effect] || "").trim(),
    };
  }
  return byScroll;
}

// Returns { enchants, source, liveError? }.
export async function loadEnchants() {
  const { rows, source, liveError } = await fetchSheetRows(ENCHANT_CSV_URL, ENCHANT_CSV_FALLBACK);
  return { enchants: rowsToEnchants(rows), source, liveError };
}
