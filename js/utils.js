// Shared pure helpers (SPEC §6, §13, §14). Currently the small functions that
// decompose stat deltas and normalize gear names into the keys the SetBonuses /
// Tuning tabs and the family grouping use, move generation itself lives in
// `solver.js` (`slotMoves`/`generateMoves`).
//
// This is the catch-all utility module: any small, dependency-light pure function
// that's shared across modules but doesn't belong to a specific data loader, the
// coster, the scorer, or the solver can live here. Keep it to genuinely reusable,
// side-effect-free helpers, not feature logic.

import { FAMILY_TIER_WORDS, RANKING_WEIGHTS, GEAR_SYSTEMS, ITEM_TIER_WORDS, tuneStatCanon } from "./config.js";

// Per-stat delta (new − old) over the scored stats only, the decomposition of a
// move's pointGain, for the UI's "what changed vs equipped" detail (SPEC §14).
// Keys match the ranking formula; zero deltas are omitted so only changes show.
// Both args default to {} so an empty/absent current item reads as all-zero.
export function statDelta(newStats = {}, oldStats = {}) {
  const diff = {};
  for (const key of Object.keys(RANKING_WEIGHTS)) {
    const d = (newStats[key] || 0) - (oldStats[key] || 0);
    if (d !== 0) diff[key] = d;
  }
  return diff;
}

// An artifact/rhod item's "family", the shared core name that groups same-effect
// variants regardless of owner prefix or tier word. Drop the leading possessive
// owner phrase (everything up to and including the first "...'s" token, e.g.
// "Usurper's", "Fallen One's", "The Watcher's"), then strip leading tier adjectives.
//   "Greater Mysterious Cat Statue"            → "Mysterious Cat Statue"
//   "The Watcher's Glowing Mysterious Cat Statue" → "Mysterious Cat Statue"
//   "Usurper's Rusty Rhod Compass"             → "Rhod Compass"
const TIER_SET = new Set(FAMILY_TIER_WORDS);
export function itemFamily(name) {
  let words = name.trim().split(/\s+/);
  const owns = words.findIndex((w) => /['’]s$/.test(w));
  if (owns !== -1) words = words.slice(owns + 1);
  while (words.length && TIER_SET.has(words[0].toLowerCase())) words = words.slice(1);
  return words.join(" ");
}

// The gear SYSTEM a weapon/armor base belongs to (Orna / Uaithne / Eriu), for set-
// bonus piece counting (SPEC §13.2). Derived from the name, matches the bare system
// word the SetBonuses tab keys on, regardless of tier word or "+N" baseline prefix
// ("+15 Orna Helm" → "Orna", "Legendary Uaithne Weapon" → "Uaithne"). null for items
// in no tracked system. GEAR_SYSTEMS is longest-first so "Uaithne" wins before "Eriu".
export function itemSystem(name) {
  if (!name) return null;
  return GEAR_SYSTEMS.find((sys) => new RegExp(`\\b${sys}\\b`, "i").test(name)) || null;
}

// The tuning key for a weapon/armor base, the system + piece noun the Tuning tab
// keys on, shared across every tier within a system (tuning rows don't vary by tier).
// Strips a leading "+N" baseline token and any leading tier word:
//   "+15 Orna Helm" → "Orna Helm" ; "Legendary Uaithne Mail" → "Uaithne Mail".
const ITEM_TIER_SET = new Set(ITEM_TIER_WORDS);
export function tuningKey(name) {
  if (!name) return null;
  let words = name.trim().split(/\s+/);
  if (words.length && /^\+?\d+$/.test(words[0])) words = words.slice(1); // drop "+15"/"+12"
  while (words.length && ITEM_TIER_SET.has(words[0].toLowerCase())) words = words.slice(1);
  return words.join(" ");
}

// Re-key a loadout's per-slot `tuning` map to the CURRENT sheet stat labels by
// canonical token (SPEC §12). The destruction capstone has been renamed across patches
// (ATT Surplus → DES → Dest I/II), so a persisted/saved loadout may carry an older
// label; matching the live tuning rows by exact label would then read 0. Mutates each
// slot's `tuning` in place (safe on a working clone). Called at startup AND after
// loading a saved profile/preset into the working loadout, both may predate a rename.
//   `tuning` = the loaded Tuning-tab data map (keyed by tuningKey(base)).
export function healTuning(loadout, tuning) {
  if (!loadout || !tuning) return loadout;
  for (const s of Object.keys(loadout)) {
    const slot = loadout[s];
    if (!slot?.tuning || !slot.base) continue;
    const rows = tuning[tuningKey(slot.base)];
    if (!rows) continue;
    const fixed = {};
    for (const [k, v] of Object.entries(slot.tuning)) {
      const row = rows.find((r) => tuneStatCanon(r.stat) === tuneStatCanon(k));
      fixed[row ? row.stat : k] = v;
    }
    slot.tuning = fixed;
  }
  return loadout;
}

// Stable per-move identity, shared by the UI (row keys, expand state) and the veto
// filter. tuneStep moves carry no `affix`/`to`, so they'd all collapse to
// `tuneStep:slot:base:undefined`, disambiguate by the tuned stat / target level.
export const moveKey = (m) => `${m.type}:${m.slot}:${m.affix || "base"}:${m.to ?? m.stat ?? m.toLevel ?? ""}`;

// Veto filter (SPEC §7.4): `vetoes` is a list of rules; a move is hidden app-wide if
// ANY rule matches it. Three scopes, chosen per-veto in the UI:
//   { kind: "move", key }            – one exact move row (by moveKey)
//   { kind: "target", to }           – every move producing item/scroll `to`
//   { kind: "slotType", slot, type } – every move of a type on a slot
// Empty/absent list ⇒ nothing vetoed (the no-op default), so the move lists and the
// solver are unchanged for users who never veto.
export function moveVetoed(m, vetoes) {
  if (!vetoes || !vetoes.length) return false;
  const key = moveKey(m);
  return vetoes.some((v) =>
    v.kind === "move" ? v.key === key
    : v.kind === "target" ? v.to != null && m.to === v.to
    : v.kind === "slotType" ? v.slot === m.slot && v.type === m.type
    : false);
}
