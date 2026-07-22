// Set-bonus loader + lookup (SPEC §13.2). The SetBonuses tab maps a gear system
// (Orna / Uaithne / Eriu) and a piece count (1..6) to the bonus stats granted for
// wearing that many of the system's weapon/armor pieces. Only SCORED stats (SPEC
// §2) are kept; the tab's HP/Stam/STR/AGI/INT/WIL columns are carried game-side but
// not part of the ranking, so they're dropped here.
//
//   bonuses[system][pieceCount] = { def, bal, ... }   // scored keys, zeros omitted
//
// Values are the TOTAL bonus at that piece count (not incremental) — you get exactly
// the row matching your count, so setBonusAt() returns the single highest tier ≤ N.

import {
  SETBONUS_CSV_URL, SETBONUS_CSV_FALLBACK, SETBONUS_COLUMNS, SETBONUS_STAT_COLUMNS,
} from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

export function rowsToSetBonuses(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], SETBONUS_COLUMNS);
  const statIdx = headerIndex(
    rows[0],
    Object.fromEntries(Object.keys(SETBONUS_STAT_COLUMNS).map((c) => [c, c]))
  );
  const bonuses = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const system = (row[idx.set] || "").trim();
    const pieces = toInt(row[idx.pieces]);
    if (!system || !pieces) continue;
    const stats = {};
    for (const [col, key] of Object.entries(SETBONUS_STAT_COLUMNS)) {
      const v = toInt(row[statIdx[col]]);
      if (v) stats[key] = v; // omit zero/blank
    }
    (bonuses[system] ||= {})[pieces] = stats;
  }
  return bonuses;
}

// Scored bonus stats active when wearing `count` pieces of `system` — the row for
// the highest tier ≤ count ({} when none / count ≤ 0). Tolerant of gaps in the
// tier list (picks the best populated tier you've reached).
export function setBonusAt(bonuses, system, count) {
  const tiers = bonuses?.[system];
  if (!tiers || count <= 0) return {};
  let best = null;
  for (const n of Object.keys(tiers).map(Number))
    if (n <= count && (best == null || n > best)) best = n;
  return best == null ? {} : tiers[best];
}

// Summed scored set-bonus stats for a whole composition (map of tier-slot → system,
// blanks ignored): tally pieces per system, look up each system's active tier, add.
export function setBonusTotals(bonuses, composition) {
  const counts = {};
  for (const sys of Object.values(composition || {})) if (sys) counts[sys] = (counts[sys] || 0) + 1;
  const totals = {};
  for (const sys in counts) {
    const b = setBonusAt(bonuses, sys, counts[sys]);
    for (const k in b) totals[k] = (totals[k] || 0) + b[k];
  }
  return totals;
}

// Scored set-bonus stat DELTA of moving ONE tier slot to `newSystem`: the change in
// whole-loadout set bonuses (both the system you leave and the one you join shift a
// tier). Keys with a zero net change are omitted. Used to fold the set-bonus swing
// into a tierStep's pointGain + statDiff (SPEC §13.2).
export function setBonusDelta(bonuses, composition, slot, newSystem) {
  const before = setBonusTotals(bonuses, composition);
  const after = setBonusTotals(bonuses, { ...composition, [slot]: newSystem });
  const delta = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) delta[k] = d;
  }
  return delta;
}

// ── Ring set bonus (SPEC §13.1) ──
// The two ring slots grant a scored bonus ONLY when they hold two DIFFERENT rings of the
// SAME level (exactly two named rings exist per level, so "different + same level" == the
// intended pair). Keyed in the SetBonuses tab as "<level> Rings" with Pieces=2 (e.g.
// "110 Rings" → Crit 1). `rings` maps ring slot id → { name, level }; a blank slot, two of
// the same ring, or a level mismatch yields {} (no bonus). 2× the same ring never sets.
export function ringSetStats(bonuses, rings) {
  const a = rings?.ring1, b = rings?.ring2;
  if (!a?.name || !b?.name || a.name === b.name) return {};
  if (a.level == null || a.level !== b.level) return {};
  return setBonusAt(bonuses, `${a.level} Rings`, 2);
}

// Scored ring-set DELTA of changing ONE ring slot to `newRing` ({ name, level } | null):
// the swing in the ring-pair bonus (breaking or forming a matched pair). Keys with a zero
// net change are omitted. Folded into a ring baseSwap's statDiff + pointGain like §13.2.
export function ringSetDelta(bonuses, rings, slot, newRing) {
  const before = ringSetStats(bonuses, rings);
  const after = ringSetStats(bonuses, { ...rings, [slot]: newRing });
  const delta = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) delta[k] = d;
  }
  return delta;
}

// Returns { bonuses, source, liveError? }.
export async function loadSetBonuses() {
  const { rows, source, liveError } = await fetchSheetRows(SETBONUS_CSV_URL, SETBONUS_CSV_FALLBACK);
  return { bonuses: rowsToSetBonuses(rows), source, liveError };
}
