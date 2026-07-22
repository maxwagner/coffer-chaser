// Raid Info loader (SPEC §7.2 "raid targets"): published Google Sheet CSV → one
// entry per raid with the stat goals needed to take it on.
//
// Each raid yields:
//   { raid, level, qb:{stat:val}, caps:{stat:val}, targets:{stat:val} }
// where `targets` = the QB ENTRY floors with bal/crit/critRes raised to their CAPS
// (the cap is ≥ the QB floor in the data, so it's the effective goal for a capped
// stat). Crit Res has only a cap, no floor → its target is the cap alone.
//
// Rows are returned sorted ASCENDING difficulty (by level, then QB Att). The sheet
// lists raids hardest→easiest, so without sorting "next raid" would pick the
// HARDEST unmet one; ascending makes "next" the easiest raid you can't yet enter.

import {
  RAID_INFO_CSV_URL, RAID_INFO_CSV_FALLBACK, RAID_INFO_COLUMNS,
  RAID_QB_COLUMNS, RAID_CAP_COLUMNS, RAID_BOSS_COLUMNS, RAID_HERO_COLUMN, RAID_GOLD_COLUMNS, RAID_CORE_GOLD_COLUMN,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

// A "has hero version" cell → boolean. Lenient (yes/y/true/1/hero); blank/no → false.
const isHeroYes = (v) => /^(y|yes|true|1|hero)/i.test(String(v || "").trim());

export function rowsToRaids(rows) {
  if (!rows.length) return [];
  // Build one combined header map so a single headerIndex call validates every
  // column we read (name/level + all QB + all cap headers).
  const cols = { ...RAID_INFO_COLUMNS };
  for (const [k, h] of Object.entries(RAID_QB_COLUMNS)) cols[`qb_${k}`] = h;
  for (const [k, h] of Object.entries(RAID_CAP_COLUMNS)) cols[`cap_${k}`] = h;
  const idx = headerIndex(rows[0], cols);
  // Hero column is OPTIONAL — look it up directly so a sheet without it still loads.
  const heroIdx = rows[0].findIndex((h) => (h || "").trim().toLowerCase() === RAID_HERO_COLUMN.toLowerCase());
  // Base-gold columns are OPTIONAL too (added incrementally as runs are done) — look up by name.
  const findCol = (name) => rows[0].findIndex((h) => (h || "").trim().toLowerCase() === name.toLowerCase());
  const goldNormalIdx = findCol(RAID_GOLD_COLUMNS.goldNormal);
  const goldHeroIdx = findCol(RAID_GOLD_COLUMNS.goldHero);
  const coreGoldIdx = findCol(RAID_CORE_GOLD_COLUMN);
  // Bare boss-stat columns are OPTIONAL too (exact-name match, so "Crit Res" never
  // collides with "Crit Res Cap"). Blank/0 cells → field omitted from boss{}.
  const bossIdx = {};
  for (const [k, h] of Object.entries(RAID_BOSS_COLUMNS)) bossIdx[k] = findCol(h);

  const raids = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    const qb = {}, caps = {};
    for (const k of Object.keys(RAID_QB_COLUMNS)) {
      const v = toInt(row[idx[`qb_${k}`]]);
      if (v != null && v > 0) qb[k] = v; // 0/blank = no floor for this stat
    }
    for (const k of Object.keys(RAID_CAP_COLUMNS)) {
      const v = toInt(row[idx[`cap_${k}`]]);
      if (v != null) caps[k] = v;
    }
    // targets: QB floors, with capped stats raised to their cap (cap ≥ floor).
    const targets = { ...qb };
    for (const [k, v] of Object.entries(caps)) targets[k] = v;
    const hero = heroIdx >= 0 ? isHeroYes(row[heroIdx]) : false;
    const goldNormal = goldNormalIdx >= 0 ? (toInt(row[goldNormalIdx]) || 0) : 0;
    const goldHero = goldHeroIdx >= 0 ? (toInt(row[goldHeroIdx]) || 0) : 0;
    const coreGold = coreGoldIdx >= 0 ? (toInt(row[coreGoldIdx]) || 0) : 0;
    const boss = {};
    for (const [k, ci] of Object.entries(bossIdx)) {
      const v = ci >= 0 ? toInt(row[ci]) : null;
      if (v != null && v > 0) boss[k] = v;
    }
    raids.push({ raid: name, level: toInt(row[idx.level]), type: (row[idx.type] || "").trim(), hero, goldNormal, goldHero, coreGold, qb, caps, targets, boss });
  }
  // Ascending difficulty so "next raid" = easiest unmet.
  raids.sort((a, b) => (a.level - b.level) || ((a.qb.att ?? 0) - (b.qb.att ?? 0)));
  return raids;
}

// The "next" raid = the easiest one whose QB ENTRY floors `current` doesn't all
// meet. Entry is gated by QB only (caps are optimization, not a gate). Returns the
// raid name, or the hardest raid if every one is already cleared (null if no data).
export function nextRaid(raids, current) {
  for (const r of raids) {
    const meets = Object.entries(r.qb).every(([k, v]) => (current[k] ?? 0) >= v);
    if (!meets) return r.raid;
  }
  return raids.length ? raids[raids.length - 1].raid : null;
}

// Returns { raids, source, liveError? }.
export async function loadRaids() {
  const { rows, source, liveError } = await fetchSheetRows(RAID_INFO_CSV_URL, RAID_INFO_CSV_FALLBACK);
  return { raids: rowsToRaids(rows), source, liveError };
}
