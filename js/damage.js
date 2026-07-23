// Post-rework (Ver 3.30, Nov 2025) damage model (SPEC §19). Pure functions, no DOM.
// Stat keys are the canonical scored keys (att/addDmg/bal/crit/defPen/destruction) so
// `currentStats` and a move's `statDiff` plug in directly.
//
// Pipeline (4 stages; stage 1 verified to the decimal against the in-game
// "Applied ATT Graph", stages 2–3 community-derived, treat as beta):
//   1. Applied ATT, piecewise on gap = att − boss DEF (raw DEF; DEF Pen excluded here)
//   2. Effective ATT. DEF Pen applies (endDEF = DEF − 8·pen), then the legacy
//                      5th-degree polynomial in x = (att − def + 900)/(def + 900)
//   3. + Additional Damage × an attack-dependent multiplier keyed on applied − endDEF
//   4. × Balance × Critical × Destruction (final multipliers)
//
// attSpd is deliberately NOT modeled (no honest conversion to damage); def/critRes are
// defensive. Boss shape: { def, balCap, critCap }.

const DEST_RATE = 0.0022;   // % final damage per Destruction point (confirmed live)
const CRIT_MULT = 1.95;     // crit damage multiplier. TODO: Lann 2.25; temp crit-mult buff scrolls
const CRIT_CAP_PCT = 50;    // crit CHANCE (%) reached at the boss's crit cap. TODO: Lann 65
const DEF_PEN_RATE = 8;     // boss DEF ignored per DEF Pen point (confirmed live)
const CURVE_BP1 = 4000;     // applied-ATT graph: 1:1 up to boss DEF + BP1
const CURVE_BP2 = 22000;    // diminishing curve ends at boss DEF + BP2
const CURVE_FLOOR = 0.1;    // applied ATT per ATT point beyond BP2

// The six stats the model responds to (order = display order in the Damage tab).
export const DAMAGE_STAT_KEYS = Object.freeze(["att", "addDmg", "bal", "crit", "destruction", "defPen"]);

// Stage 1: Applied ATT vs raw boss DEF. Matches the in-game graph exactly
// (Morgant DEF 48620: ATT 66366 → 61642; inflections 52620 / 70620 → 62520).
export function appliedATT(att, bossDef) {
  const gap = att - bossDef;
  if (gap <= CURVE_BP1) return Math.max(0, att);
  if (gap <= CURVE_BP2) return bossDef + Math.floor(gap * gap * -0.000025 + 1.2 * gap - 400);
  return bossDef + 13900 + (gap - CURVE_BP2) * CURVE_FLOOR;
}

// Stage 2: the legacy pre-rework effective-ATT polynomial, still alive downstream
// of the applied-ATT graph. `endDef` = boss DEF − 8×DEF Pen.
export function legacyEffATT(att, endDef) {
  const x = (att - endDef + 900) / (endDef + 900);
  if (x < 1) {
    const f = 0.1856 + 0.5525 * x + 0.4214 * x * x - 0.3094 * Math.pow(x, 3)
            + 0.3643 * Math.pow(x, 4) - 0.2144 * Math.pow(x, 5);
    return Math.trunc((endDef + 900) * f);
  }
  return Math.trunc(att - endDef + 900);
}

// Stage 3: Additional Damage multiplier, keyed on applied ATT − effective DEF.
export function adMult(applied, endDef) {
  const diff = applied - endDef;
  if (diff <= 3000) return 1.875;
  if (diff <= 10000) return diff / 1600;
  return 6.25 + (diff - 10000) / 2400;
}

// Full pipeline → a relative damage rating (arbitrary units; ratios are what matter).
// Returns 0 when boss data is unusable. Also exposes the stage values for UI display.
export function damageBreakdown(stats, boss) {
  const def = boss?.def;
  if (!Number.isFinite(def) || def <= 0) return null;
  const applied = Math.floor(appliedATT(stats.att || 0, def));
  const endDef = def - (stats.defPen || 0) * DEF_PEN_RATE;
  const endATT = legacyEffATT(applied, endDef);
  const adm = adMult(applied, endDef);
  const adTerm = (stats.addDmg || 0) * adm;
  const finalATT = endATT + adTerm;

  const balCap = boss.balCap > 0 ? boss.balCap : null;
  const effBal = balCap ? Math.min(stats.bal || 0, balCap) : (stats.bal || 0);
  const balFac = balCap ? ((100 * effBal / balCap) + 100) / 200 : 1;

  const critCap = boss.critCap > 0 ? boss.critCap : null;
  const critChance = critCap ? Math.min(stats.crit || 0, critCap) / critCap * (CRIT_CAP_PCT / 100) : 0;
  const critFac = 1 + critChance * (CRIT_MULT - 1);

  const destFac = 1 + (stats.destruction || 0) * DEST_RATE / 100;
  return {
    applied, endDef, endATT, adm, adTerm, finalATT, balFac, critFac, destFac,
    rating: finalATT * balFac * critFac * destFac,
  };
}

export function damageRating(stats, boss) {
  return damageBreakdown(stats, boss)?.rating ?? 0;
}

// % damage change from applying a statDiff (a move's per-stat deltas) to `stats`.
// Returns null when the boss is unusable or the baseline rating is 0.
export function dpsGain(statDiff, stats, boss) {
  const base = damageRating(stats, boss);
  if (!(base > 0)) return null;
  const after = { ...stats };
  for (const [k, v] of Object.entries(statDiff || {})) after[k] = (after[k] || 0) + v;
  return (damageRating(after, boss) / base - 1) * 100;
}

// % damage gain per +1 of each damage stat at the current position, the Damage
// tab's main table. Bal/crit report 0 once at/over the boss's cap.
//
// The pipeline floors intermediate values (Math.floor/trunc), so a literal +1
// probe stairsteps, 0 on most points, a whole point at floor boundaries. Probe
// with a larger stat-appropriate step and normalize back to per-+1 for a smooth,
// honest per-point value. Bal/crit stay at 1 (integer stats near small caps:
// a wide probe would cross the cap and understate them).
const MARGINAL_PROBE = Object.freeze({ att: 100, addDmg: 10, bal: 1, crit: 1, destruction: 100, defPen: 10 });
export function statMarginals(stats, boss) {
  const out = {};
  for (const k of DAMAGE_STAT_KEYS) {
    const step = MARGINAL_PROBE[k];
    const g = dpsGain({ [k]: step }, stats, boss);
    out[k] = g == null ? null : g / step;
  }
  return out;
}
