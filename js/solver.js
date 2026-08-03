// State-model move generation + re-baselining solver (SPEC §6, §7.1 knapsack,
// §7.2 threshold). Pricing each move from the FIXED current loadout is correct in
// isolation but double-counts when moves are COMBINED in a bundle (e.g. a base swap
// restores the old prefix, then a separate enchant upgrade re-buys the prefix, you
// pay for the discarded scroll). This module avoids that by tracking live per-slot
// STATE and regenerating a slot's moves from its new state after each pick
// (re-baselining), so:
//   • adding a new base then enchanting/enhancing IT becomes reachable, and
//   • replacing a just-RESTORED affix credits back the restore cost (no double-pay).
//
// Cost model for a base swap (the subtle part): a freshly bought/crafted accessory
// is BARE, enchants wiped (no extraction rune, SPEC §3) AND enhancement reset to
// +0 (confirmed). To keep a standalone swap an honest, positive-gain, apples-to-
// apples move, the swap RESTORES the slot's current configuration on the new base:
//   goldCost  = cost(newBase) + Σ reEnchant(current affix) + reEnhance(0 → curLevel)
//   pointGain = score(newBase + enhance@curLevel) − score(oldBase + enhance@curLevel)
//             = base-stat delta + the enhance-bracket delta (affixes cancel)
// Pushing an affix/enhance BEYOND the restored config is then a separate move from
// the new state. When such a move replaces an affix the swap just restored, its
// cost is credited the now-wasted restore (enchantCost(new) − enchantCost(old)),
// making the combined cost exactly cost(newBase)+reEnchant(kept)+enchantCost(new).

import { score } from "./score.js";
import { statDelta, itemFamily, itemSystem, tuningKey, moveVetoed } from "./utils.js";
import { setBonusDelta, ringSetDelta } from "./setbonuses.js";
import { enchantCost, enhanceStepCost, reEnhanceCost } from "./cost.js";
import {
  ACCESSORY_SLOT_IDS, ENHANCEABLE_SLOT_IDS, SPECIAL_SLOT_IDS, COMPLETE_VARIANT_RE,
  TIER_SLOT_IDS, RING_SLOT_IDS, EXTRACTION_RUNE_NAME, tuneStatCanon, TUNING_STAT_TO_KEY,
} from "./config.js";

const AFFIXES = ["prefix", "suffix"];

// A tier slot's CURRENT scored stat line for diffing against the NEXT tier: its
// untuned base item stats PLUS the per-stat tuned amounts the player has applied,
// EXCEPT Destruction (SPEC §12). A piece can only advance once fully tuned, so the
// honest "vs equipped" diff is target-base minus your tuned current, but on the
// system jump the base-stat tuning (def/crit/att/…) RESETS to the new piece's base
// while Destruction (Dest I/II) CARRIES OVER free. Destruction is therefore present
// on BOTH sides of the advance and cancels, so it's excluded here (folding it would
// show a spurious multi-thousand-point Destruction "loss" and bury the advance).
// Stat labels map to scored keys via TUNING_STAT_TO_KEY.
function tunedBaseStats(state) {
  const out = { ...(state.base?.stats || {}) };
  if (state.tuning)
    for (const [label, amt] of Object.entries(state.tuning)) {
      const k = TUNING_STAT_TO_KEY[label];
      if (k && amt && k !== "destruction") out[k] = (out[k] || 0) + amt;
    }
  return out;
}

// Merge two scored stat-diff objects (summing per key, dropping any net-zero entry).
// Used to fold a tierStep's set-bonus delta into its item-stat delta.
function mergeStats(a, b) {
  const out = { ...a };
  for (const k in b) {
    const v = (out[k] || 0) + b[k];
    if (v === 0) delete out[k]; else out[k] = v;
  }
  return out;
}

// Combine two inventory-"used" maps ({name:count}|null) into one (null when empty). Used to
// report a move's total owned-item draw when it nets stock from more than one place (a tierStep's
// craft BOM + its tuning prerequisite).
function mergeUsed(a, b) {
  if (!a && !b) return null;
  const out = { ...(a || {}) };
  for (const [n, c] of Object.entries(b || {})) out[n] = (out[n] || 0) + c;
  return Object.keys(out).length ? out : null;
}

// Round an inventory-"used" map's counts to whole items, the enhancement EV consumes a fractional
// EXPECTED quantity, but the reported draw + Craft button should be whole units. null → null.
function roundUsed(used) {
  if (!used) return null;
  const out = {};
  for (const [n, c] of Object.entries(used)) { const r = Math.round(c); if (r > 0) out[n] = r; }
  return Object.keys(out).length ? out : null;
}

// The current gear-system composition across the 6 tier slots (slot → system), for
// set-bonus piece counting (SPEC §13.2). Recomputed from live state so a bundle's
// successive system jumps each see the up-to-date piece counts.
export function compositionOf(states) {
  const comp = {};
  for (const slot of TIER_SLOT_IDS) {
    const name = states[slot]?.base?.name;
    if (name) comp[slot] = itemSystem(name);
  }
  return comp;
}

// The current ring pair (slot → { name, level }), for ring set-bonus matching (SPEC §13.1).
// Recomputed from live state so a bundle's ring swaps see the up-to-date pair.
export function ringsOf(states) {
  const rings = {};
  for (const slot of RING_SLOT_IDS) {
    const b = states[slot]?.base;
    if (b) rings[slot] = { name: b.name, level: b.level };
  }
  return rings;
}

// Total tunable cap per scored stat for a base, the sum of `maxTune` over its tuning
// rows (e.g. Orna Helm destruction cap 700, Uaithne 2020, Eriu 3340). Used to compute
// the tuning HEADROOM a tier upgrade unlocks, so stat-maximize climbs tiers (SPEC §12).
function tuningCaps(baseName, ctx) {
  const caps = {};
  const rows = ctx.tuning?.[tuningKey(baseName)];
  if (rows) for (const r of rows) caps[r.key] = (caps[r.key] || 0) + r.maxTune;
  return caps;
}

// Cost + stat to MAX every NON-Destruction base tuning (Unlock-0 rows) on a piece from
// its CURRENT tuning up to the cap, the in-game PREREQUISITE for advancing Orna→Uaithne
// (an Orna piece must be fully base-tuned, Destruction aside, before it can jump; SPEC §12).
// The maxed tuning is WIPED on the jump (only Destruction carries, SPEC §12), so `caps`/`maxes` do
// NOT become stats on the new piece and are NOT recorded on apply, the gate is a sunk gold tax and
// its stat loss is folded into the tierStep `statDiff`. Returns { gold, caps, maxes, breakdown, ok }
//, `caps[key]` = the maxed tuned amount (Σ maxTune of that key's base rows), `maxes` = per-row
// {stat, amount} (every unlock-0 row at its cap). `caps`/`maxes` survive only to CHAIN a multi-jump
// path (accumTuningPrereq): each gate's maxed amounts carry into the NEXT jump-source's starting
// tuning so the later gate climbs only from the already-bought caps (never re-paying those ticks).
// `breakdown` rows mirror tuneStep's shape. `ok=false` if a tuning material is unpriceable (that
// row's gold is skipped, not guessed).
// Core prereq for ONE piece by name: cost to max its Unlock-0 rows from `curByCanon`
// (canon stat token → current tuned amount) up to their caps. Same return shape as
// baseTuningPrereq. Split out so a MULTI-jump path can chain pieces (accumTuningPrereq).
function baseTuningPrereqFor(baseName, curByCanon, ctx) {
  const rows = ctx.tuning?.[tuningKey(baseName)];
  if (!rows || !rows.length) return { gold: 0, caps: {}, maxes: [], breakdown: [], ok: true };
  const amountOf = (row) => curByCanon[tuneStatCanon(row.stat)] || 0;
  let gold = 0, ok = true;
  const caps = {}, maxes = [], breakdown = [];
  for (const row of rows) {
    if (row.unlock !== 0) continue;                      // base stats only (Destruction is gated, not required)
    caps[row.key] = (caps[row.key] || 0) + row.maxTune;  // the tuned amount once maxed (chains to the next jump's gate)
    maxes.push({ stat: row.stat, amount: row.maxTune }); // chained by accumTuningPrereq (wiped on the jump, not kept)
    const from = amountOf(row);
    if (from >= row.maxTune) continue;                   // already maxed → no cost/breakdown row
    let pt = row.gold || 0, priced = true;
    for (const { material, qty } of row.materials) {
      const c = ctx.cost(material);
      if (c == null) { priced = false; break; }
      pt += qty * c;
    }
    if (!priced) { ok = false; continue; }               // unpriceable → skip its gold, flag
    const ticks = Math.ceil((row.maxTune - from) / row.step);
    const rowGold = ticks * pt;
    gold += rowGold;
    breakdown.push({
      stat: row.stat, key: row.key, ticks, gain: row.maxTune - from, rowGold,
      feeGold: ticks * (row.gold || 0),
      materials: row.materials.map(({ material, qty }) => ({ material, qty: qty * ticks })),
    });
  }
  return { gold, caps, maxes, breakdown, ok };
}

function baseTuningPrereq(state, ctx) {
  const curByCanon = {};
  for (const [k, v] of Object.entries(state.tuning || {})) curByCanon[tuneStatCanon(k)] = v;
  return baseTuningPrereqFor(state.base.name, curByCanon, ctx);
}

// Accumulated base-tuning prerequisite for a path crossing jumps whose SOURCE pieces are
// `jumpBases` (in walk order, e.g. ["Orna Helm","Uaithne Helm"] for Orna→Uaithne→Eriu).
// Each jump requires its source piece fully base-tuned to THAT piece's caps; the maxed
// amounts carry FREE into the next piece, so a later jump climbs only from the carried
// caps to its own (higher) caps, never re-paying the ticks the earlier jump already
// bought. Returns the merged {gold, ok} plus the FINAL carried tuning as caps/maxes (the
// last source's, which the target then inherits) and the concatenated breakdown. Fixes the
// old single-jump limitation where a direct Orna→Eriu charged only Orna's tuning (SPEC §12).
function accumTuningPrereq(jumpBases, startByCanon, ctx) {
  let carried = { ...startByCanon };
  let gold = 0, ok = true, caps = {}, maxes = [];
  const breakdown = [];
  for (const baseName of jumpBases) {
    const p = baseTuningPrereqFor(baseName, carried, ctx);
    gold += p.gold; ok = ok && p.ok;
    breakdown.push(...p.breakdown);
    carried = { ...carried };
    for (const { stat, amount } of p.maxes) carried[tuneStatCanon(stat)] = amount;
    caps = p.caps; maxes = p.maxes;                      // final piece's = what the target inherits
  }
  return { gold, caps, maxes, breakdown, ok };
}

// NOTE: base-stat tuning IS wiped on a system jump (only Destruction carries; confirmed mechanic,
// SPEC §12). It is NOT modeled as a "re-tune across a jump" gold line: the lost tuning's stat cost
// is folded into the tier `statDiff` (diff measured vs your current tuning), and the required
// base-tuning gate is charged separately as a sunk tax (`baseTuningPrereq`). A rune preserves only
// the enchants, it cannot save tuning. (Earlier `reTuneCost` / `reTuneMaterials` / `tuneWipeAdvisory`
// helpers were removed.)

// Tier chain graph (SPEC §4)
// Map each tier item NAME → the item one step ABOVE it in its weapon/armor chain:
//   nextOf.get("Uaithne Helm") = { name:"Beginner Uaithne Helm", item, slot:"helm",
//                                  wipe:false, prevName:"Uaithne Helm", prevQty:1 }
// A recipe's "previous tier" is the first material that is itself an equipment item
// in the SAME slot (e.g. Beginner Uaithne Helm lists Uaithne Helm; the advancement
// stones/essences aren't equippable). `prevQty` is how many of the previous tier the
// recipe consumes, so the marginal cost subtracts the right amount of the
// already-owned current tier.
// `wipe` is DERIVED whenever the step crosses gear systems (itemSystem differs), so
// both orna→uaithne (+15 Orna Helm → Uaithne Helm) and uaithne→eriu (Legendary
// Uaithne Helm → Eriu Helm) are wipes and pay a re-enchant.
// The Orna +12→+15 climb is an ordinary link in this chain: each "+N Orna <slot>"
// recipe lists "+N−1 Orna <slot>" as a material, with the expected number of
// enhancement attempts already baked into its gold + material quantities (see
// docs/orna-enhancement.md). Same system on both sides → wipe:false, since enhancing
// keeps your enchants.
export function buildTierChain(recipes, items) {
  const itemByName = Object.fromEntries(items.map((it) => [it.name, it]));
  const nextOf = new Map();
  for (const [name, recipe] of Object.entries(recipes)) {
    const out = itemByName[name];
    const slot = out?.slotIds?.[0];
    if (!slot || !TIER_SLOT_IDS.includes(slot)) continue; // recipe output isn't tiered gear
    let prevName = null, prevQty = 0;
    for (const { material, qty } of recipe.materials) {
      const mi = itemByName[material];
      if (mi && mi.slotIds.includes(slot)) { prevName = material; prevQty = qty; break; }
    }
    if (prevName) {
      const wipe = itemSystem(prevName) !== itemSystem(name); // orna→uaithne, uaithne→eriu
      nextOf.set(prevName, { name, item: out, slot, wipe, prevName, prevQty });
    }
  }
  return nextOf;
}

function addStats(a, b) {
  const out = { ...a };
  for (const k in b) out[k] = (out[k] || 0) + (b[k] || 0);
  return out;
}

// Enhancement's {att, defPen} contribution at a bracket+level (0 when bare/unknown).
function enhanceStatsAt(accessories, bracket, level) {
  if (!level || bracket == null) return { att: 0, defPen: 0 };
  const row = accessories?.brackets?.[bracket]?.find((e) => e.level === level);
  return row ? { att: row.att || 0, defPen: row.defPen || 0 } : { att: 0, defPen: 0 };
}

// A move is worth emitting if it improves ANY scored stat, even if it lowers
// another (net-negative points). Consumers filter: the ranked points view keeps
// pointGain>0; the stat-target/threshold views keep statDiff[stat]>0. This is what
// lets "give me Att Spd" surface a +AttSpd/−Bal enchant the points view hides.
const improvesAnyStat = (diff) => Object.values(diff).some((v) => v > 0);

// Point-weighted value of a stat delta over a chosen subset of stats (Σ weight[s]·Δs).
// Used to RANK maximize picks so different-unit stats are comparable (a raw sum is
// dominated by Att/Def magnitude; point weights put Crit/Bal/etc. on equal footing).
const scoreSubset = (statDiff, keys) => {
  const o = {};
  for (const s of keys) if (statDiff?.[s]) o[s] = statDiff[s];
  return score(o);
};

// Penalty-aware ranking (SPEC §7.2): the point-weighted harm a move does to scored stats the
// goal did NOT ask for. The greedy's net-useful metric already nets gains against losses on the
// OPEN needs; this extends it to every scored stat, so a cleaner-but-pricier scroll (Tempestuous:
// same Att Spd, smaller Bal hit) can beat a cheap lossy one (Fast) instead of both surviving the
// binary allow-lossy gate untouched. Weight 1 = the harm costs exactly what it is worth on the
// ranking scale, i.e. a pick is judged the way the Upgrades tab judges it (`pointGain`), with the
// goal-stat gains still capped at what is actually still needed.
// EXCLUDED from the penalty: goal stats (the caller already nets those) and floored stats
// (`floorBudgetPenalty` charges those scarcity-scaled, so counting both would double-charge).
// Unscored stats carry weight 0, so `score` restricts this to the nine ranked stats for free.
const COLLATERAL_WEIGHT = 1;
const collateralPenalty = (statDiff, needSet, floors) => {
  let harm = 0;
  for (const s in (statDiff || {})) {
    if (needSet.has(s) || (floors && s in floors)) continue;
    if (statDiff[s] < 0) harm += score({ [s]: -statDiff[s] });
  }
  return COLLATERAL_WEIGHT * harm;
};

// A move is "lossy" if it's a NET ranking-point LOSS, you're sacrificing overall
// value to chase one stat (e.g. a Fast scroll: +Att Spd but −Bal/−Att, net negative).
// NOT lossy: a net-positive move that merely dips a minor stat (a +10-crit earring
// base swap that gives up a little Att is still a big gain). Defining lossy by
// pointGain<0. Not "lowers any stat". Keeps those genuine upgrades in by default.
// The lossy toggle (default off) hides true net-losses; it gates EVERY mode including
// maximize, so "max att spd" only pulls in net-loss tradeoff moves (a Fast scroll) when
// you opt in.
export const isLossy = (m) => m.pointGain < 0;

// Hard-floor check (SPEC §7.2, issue 6/7): a move must not REDUCE a floored stat below its floor.
// `totals` = the running projected stat totals (current + Σ picked statDiffs); `floors` = stat→min.
// Only a DECREASE that lands below the floor blocks (a stat already below its floor, a goal being
// pursued, isn't blocked from rising, and an increase never violates). Returns the FIRST blocking
// stat (for the "you could go higher if you sacrifice X" warning) or null. No floors ⇒ never blocks.
function floorViolation(m, totals, floors) {
  if (!floors) return null;
  for (const s in floors) {
    const d = m.statDiff?.[s] || 0;
    if (d < 0 && (totals[s] || 0) + d < floors[s]) return s;
  }
  return null;
}

// Point-weighted penalty for the floor budget a move CONSUMES, scaled by SCARCITY (the share of the
// stat's remaining headroom the drop eats). This makes the greedy prefer a floor-EFFICIENT move (a
// small drop per unit of goal) over a cheaper-but-floor-hungry one as a floor gets tight, so ADDING
// a floor-hungry option (a Fast scroll: big Bal drop, cheap gold) never makes a goal that WAS reachable
// (via Bal-efficient Tempestuous scrolls) unreachable. Without it the greedy, ranking on gold alone,
// burns the whole floor budget on the cheap move and stalls short (issue 6/7 monotonicity). Stats that
// are themselves open needs are skipped (their gain is scored separately). Headroom floored at 1 so a
// drop AT the floor (which floorViolation already hard-blocks) yields a large, move-killing penalty.
function floorBudgetPenalty(m, totals, floors, need) {
  if (!floors) return 0;
  let harm = 0;
  for (const s in floors) {
    if (need && need.includes(s)) continue;
    const d = m.statDiff?.[s] || 0;
    if (d >= 0) continue;
    const head = Math.max((totals[s] || 0) - floors[s], 0);
    const frac = Math.min(1, (-d) / Math.max(head, 1));
    harm += score({ [s]: -d }) * frac;
  }
  return harm;
}

// Minimal enhance level on `bracket` whose def pen ≥ targetDefPen (def pen is the
// point of enhancing). A base swap need only re-enhance far enough to RECOVER the
// def pen you had. Not back to the same +level. And a higher bracket reaches it
// sooner, so the swap is cheaper. Returns 0 when nothing to match, or the max
// available level if even +20 can't reach it (recover as much as possible).
function matchDefPenLevel(accessories, bracket, targetDefPen) {
  const table = accessories?.brackets?.[bracket];
  if (!table) return null;
  if (targetDefPen <= 0) return 0;
  let best = null;
  for (const e of table) {
    if ((e.defPen || 0) >= targetDefPen) best = best == null ? e.level : Math.min(best, e.level);
  }
  return best == null ? Math.max(...table.map((e) => e.level)) : best;
}

const mk = (slot, type, props) => ({
  slot, type, ...props,
  goldPerPoint: props.pointGain > 0 ? props.goldCost / props.pointGain : Infinity,
});

// Inventory netting (SPEC §5.2)
// The player declares how many of each priced item they OWN (ctx.inventory, a live
// {name:count} map). A move that buys/crafts those items is cheaper by the value of the
// stock it consumes. Netting is naive PER MOVE: each move clones the FULL inventory and
// draws it down independently (nothing is globally allocated across the ranked list, so the
// same unit may credit several rows, an optimistic estimate, SPEC §7.1). No inventory (or
// no netCost) → a no-op that returns the full cost, so empty-inventory output is unchanged.
const hasInventory = (ctx) => ctx.inventory && ctx.netCost && Object.keys(ctx.inventory).length > 0;

// Net `qty`×`name` against a fresh per-move inventory clone. Returns { gold, credit, used }:
// gold = inventory-adjusted acquisition cost, credit = full−net (≥0, the stock's gold value),
// used = the units drawn from stock. `seed` pre-credits owned-but-not-stock units (the
// equipped tier a tierStep already holds) at no gold and WITHOUT reporting them as stock used.
// `baseOwned` (optional): net against a CLONE of this owned map instead of ctx.inventory.
// Lets a caller thread ONE shared clone through several netting steps of a single move (so a
// material used in more than one component isn't double-credited). Each call clones it, so the
// passed map is not mutated (the loop can reuse the same reduced base across targets).
function netBuy(ctx, name, qty, fullGold, seed = null, baseOwned = null) {
  if (!ctx.netCost || (!hasInventory(ctx) && !seed)) return { gold: fullGold, credit: 0, used: null };
  const owned = { ...(baseOwned || ctx.inventory || {}) };
  if (seed) for (const [n, c] of Object.entries(seed)) owned[n] = (owned[n] || 0) + c;
  const used = {};
  const gold = ctx.netCost(name, qty, owned, used);
  if (gold == null) return { gold: fullGold, credit: 0, used: null }; // unpriced → leave full
  if (seed) for (const [n, c] of Object.entries(seed)) { used[n] = (used[n] || 0) - c; if (used[n] <= 0) delete used[n]; }
  return { gold, credit: Math.max(0, fullGold - gold), used: Object.keys(used).length ? used : null };
}

// Inventory credit for a list of MATERIAL totals (a tuneStep / enhancement breakdown). `owned`
// (optional): a shared clone the caller threads through several netting steps of one move (drawn
// down in place, so stock isn't double-credited across components); omitted → a fresh clone of
// ctx.inventory. Only the materials are netted (flat fees are never owned). Returns { credit, used }.
function netBreakdown(ctx, breakdown, owned = null) {
  if (!hasInventory(ctx)) return { credit: 0, used: null };
  const stock = owned || { ...ctx.inventory };
  const used = {};
  let credit = 0;
  for (const b of breakdown) for (const { material, qty } of b.materials) {
    const full = qty * (ctx.cost(material) ?? 0);
    // Draw on a scratch clone and commit only on success: netCost mutates its owned/used args
    // BEFORE discovering a leaf is unpriceable (null), which would silently deplete the shared
    // stock. And report items as used. For a material that earned NO credit. `stock` keeps
    // its identity (it may be the caller's shared per-move clone), so commit in place.
    const scratch = { ...stock }, draw = {};
    const net = ctx.netCost(material, qty, scratch, draw);
    if (net == null) continue;
    for (const k of Object.keys(stock)) delete stock[k];
    Object.assign(stock, scratch);
    for (const [n, c] of Object.entries(draw)) used[n] = (used[n] || 0) + c;
    credit += Math.max(0, full - net);
  }
  return { credit, used: Object.keys(used).length ? used : null };
}

// Build the initial per-slot mutable state from the loadout. `restored` flags an
// affix the bundle has re-bought (so replacing it later refunds that cost).
export function initStates(loadout, { bySlot, enchants }) {
  const states = {};
  const slots = new Set([...ACCESSORY_SLOT_IDS, ...SPECIAL_SLOT_IDS, ...Object.keys(loadout)]);
  for (const slot of slots) {
    const ld = loadout[slot] || {};
    const cands = bySlot[slot] || [];
    const baseItem = ld.base ? cands.find((it) => it.name === ld.base) ?? null : null;
    states[slot] = {
      slot,
      base: baseItem ? { name: baseItem.name, stats: baseItem.stats, level: baseItem.level } : null,
      prefix: ld.prefix ? { scroll: ld.prefix, restored: false } : null,
      suffix: ld.suffix ? { scroll: ld.suffix, restored: false } : null,
      enhance: ld.enhance ? { level: ld.enhance.level, bracket: ld.enhance.bracket } : null,
      tuning: ld.tuning ? { ...ld.tuning } : {}, // per-stat current tuned amount (SPEC §12)
      // Infusion line (SPEC §14/§17): not a solver move, but carried on the state so a planner
      // infuse step can read/advance it and "what's already here" checks see the plan tail
      // (slotMoves/applyMove never touch this field, it's inert to move generation).
      infusion: ld.infusion?.stat && ld.infusion.amount ? { stat: ld.infusion.stat, amount: ld.infusion.amount } : null,
    };
  }
  return states;
}

// All positive-gain moves available from ONE slot's current state.
export function slotMoves(state, ctx) {
  const { enchants, prices, cost, accessories, bySlot, opts } = ctx;
  const slot = state.slot;
  const moves = [];

  // enchant swaps (prefix / suffix)
  // An enchant applies to the ITEM equipped in the slot; an EMPTY slot (no base, e.g. the
  // base-gear preset's empty artifact/rhod, or a slot cleared to "(none)") has nothing to
  // enchant, so skip enchant generation for it entirely (SPEC §9.1). A slot with a base but
  // a bare AFFIX (no scroll) is still enchantable, that's the acquire path.
  for (const affix of AFFIXES) {
    if (!state.base) break;
    const cur = state[affix];                       // { scroll, restored } | null
    const curScroll = cur?.scroll || null;
    const old = curScroll ? enchants[curScroll] : null;
    // Only offer same-effect upgrades: if a scroll with a known family is equipped,
    // restrict candidates to that family. No scroll (or a familyless one) → show all.
    const lockFamily = old?.family || null;
    const oldStats = old ? old.stats : {};
    const oldScore = score(oldStats);
    // refund a restore we paid in this bundle if we're now replacing that affix
    const creditBack = cur?.restored && old ? (enchantCost(old, prices, opts)?.gold ?? 0) : 0;
    const raw = [];
    for (const cand of Object.values(enchants)) {
      if (cand.affix !== affix) continue;
      if (!cand.appliesTo.includes(slot)) continue;
      if (cand.minLevel && state.base.level < cand.minLevel) continue; // item too low-level for this scroll
      if (cand.scroll === curScroll) continue;      // already on → no-op
      if (lockFamily && cand.family !== lockFamily) continue; // off-effect → skip
      const statDiff = statDelta(cand.stats, oldStats);
      if (!improvesAnyStat(statDiff)) continue;     // helps no stat → skip (tradeoffs kept)
      const ec = enchantCost(cand, prices, opts);
      if (!ec) continue;
      // Inventory: only the deterministic single-scroll buy is netted (owning a scroll →
      // it's free). The scrap/spam/exquisite EV paths are stochastic, so a finite stock
      // can't net cleanly against them (SPEC §5.2/§5.3). Left full there.
      const nb = ec.method === "scroll"
        ? netBuy(ctx, cand.scroll, 1, ec.gold)
        : { gold: ec.gold, credit: 0, used: null };
      raw.push({
        cand, statDiff, ec, nb,
        goldCost: nb.gold - creditBack,
        pointGain: score(cand.stats) - oldScore,
      });
    }
    // Within a family (upgrade chain), drop any candidate strictly dominated by another
    // member, same-or-better point gain at same-or-lower gold (the lower tier of the
    // chain, e.g. an r5 scroll when the cheaper-or-equal, stronger r4 is also a candidate).
    // Non-family (standalone) candidates are never compared. SPEC §12.
    const survivors = raw.filter((r) => !r.cand.family || !raw.some((o) =>
      o !== r && o.cand.family === r.cand.family &&
      o.pointGain >= r.pointGain && o.goldCost <= r.goldCost &&
      (o.pointGain > r.pointGain || o.goldCost < r.goldCost)
    ));
    for (const { cand, statDiff, ec, nb, goldCost, pointGain } of survivors) {
      moves.push(mk(slot, "enchantSwap", {
        affix, from: curScroll, to: cand.scroll,
        tag: cand.tag, family: cand.family, // family-scoped "better:" hint (SPEC §7.3/§12)
        goldCost,
        pointGain, statDiff,
        method: ec.method, credited: creditBack > 0 ? creditBack : 0,
        inventoryCredit: nb.credit, inventoryUsed: nb.used,
        apply: { kind: "enchant", affix, scroll: cand.scroll },
      }));
    }
  }

  // base swaps (accessory + special)
  const isSpecial = SPECIAL_SLOT_IDS.includes(slot);
  const isAccessory = ACCESSORY_SLOT_IDS.includes(slot);
  if (state.base && (isSpecial || isAccessory)) {
    const cands = bySlot[slot] || [];
    const fam = isSpecial ? itemFamily(state.base.name) : null;
    const curLevel = state.enhance?.level || 0;
    const curBracket = state.enhance?.bracket ?? null;
    const oldEnh = enhanceStatsAt(accessories, curBracket, curLevel);
    const enhanceableSlot = ENHANCEABLE_SLOT_IDS.includes(slot) && curLevel > 0;

    // restore cost for the affixes currently on the slot (re-bought on the new base). The move
    // carries the per-affix priced list; the UI applies any EPHEMERAL "ignore / change scroll"
    // what-if on top at render time (issue 3). The solver stays honest (same scroll, full price).
    let reEnchant = 0, reEnchantOk = true;
    const reEnchantItems = []; // { affix, scroll, gold } per kept affix, for the detail UI
    for (const affix of AFFIXES) {
      const s = state[affix]?.scroll;
      if (!s) continue;
      const e = enchants[s];
      if (!e) continue;
      const ec = enchantCost(e, prices, opts);
      if (!ec) { reEnchantOk = false; break; }     // a kept affix can't be priced → no swaps
      reEnchant += ec.gold;
      reEnchantItems.push({ affix, scroll: s, gold: ec.gold });
    }

    if (reEnchantOk) for (const item of cands) {
      if (item.name === state.base.name) continue;  // already equipped
      if (isSpecial) {
        if (COMPLETE_VARIANT_RE.test(item.name)) continue;       // unobtainable
        if (itemFamily(item.name) !== fam) continue;             // off-family
      }
      const baseCost = cost(item.name);
      if (baseCost == null) continue;               // neither buyable nor craftable

      // re-enhance the bare new base only far enough to RECOVER the def pen we had
      // (a higher bracket reaches it below +20 → cheaper than matching the +level)
      let reEnh = 0, newEnh = { att: 0, defPen: 0 }, reEnhLevel = 0;
      if (enhanceableSlot) {
        reEnhLevel = matchDefPenLevel(accessories, item.level, oldEnh.defPen);
        if (reEnhLevel == null) continue;
        reEnh = reEnhanceCost(accessories, item.level, 0, reEnhLevel, prices, opts?.basis, ctx.freeItems);
        if (reEnh == null) continue;                // can't price the re-enhance → drop
        newEnh = enhanceStatsAt(accessories, item.level, reEnhLevel);
      }
      const newTotal = addStats(item.stats, newEnh);
      const oldTotal = addStats(state.base.stats, oldEnh);
      // Ring set-bonus swing (SPEC §13.1): swapping one ring can break or form a matched
      // pair (two DIFFERENT rings of the same level). Fold the scored delta into statDiff +
      // pointGain so a swap that only forms/breaks a set is judged on net value.
      const ringDelta = (ctx.setBonuses && RING_SLOT_IDS.includes(slot))
        ? ringSetDelta(ctx.setBonuses, ctx.rings || {}, slot, { name: item.name, level: item.level })
        : {};
      const statDiff = mergeStats(statDelta(newTotal, oldTotal), ringDelta); // affixes restored → cancel
      if (!improvesAnyStat(statDiff)) continue;

      // Inventory nets the new base's own BOM (owning part of the craft → cheaper).
      const nb = netBuy(ctx, item.name, 1, baseCost);
      moves.push(mk(slot, "baseSwap", {
        from: state.base.name, to: item.name,
        goldCost: nb.gold + reEnchant + reEnh,
        pointGain: score(newTotal) - score(oldTotal) + score(ringDelta), statDiff,
        setDelta: ringDelta, // ring set-bonus change folded into this swap (for the UI detail)
        reEnchant, reEnchantItems, reEnhance: reEnh,
        inventoryCredit: nb.credit, inventoryUsed: nb.used,
        toLevel: enhanceableSlot ? reEnhLevel : null,
        apply: { kind: "base", item, level: enhanceableSlot ? reEnhLevel : (ENHANCEABLE_SLOT_IDS.includes(slot) ? 0 : null) },
      }));
    }
  }

  // acquire into an EMPTY slot (no base equipped, SPEC §6)
  // An empty accessory/special slot (the base-gear preset's empty artifact/rhod, or a slot the
  // player cleared to "(none)") has no base to swap FROM, but acquiring one is still an upgrade,
  // so offer each obtainable candidate as an "acquire" move (nothing → the item's full stats).
  // Nothing to re-enchant and no prior enhance level, so it's a bare buy/craft at +0. Special slots
  // normally family-lock to the equipped item; with nothing equipped there's no family to lock, so
  // every family's candidates are offered (strictly dominated ones pruned so the list isn't flooded).
  if (!state.base && (isSpecial || isAccessory)) {
    const cands = bySlot[slot] || [];
    const enhanceable = ENHANCEABLE_SLOT_IDS.includes(slot);
    const acq = [];
    for (const item of cands) {
      if (isSpecial && COMPLETE_VARIANT_RE.test(item.name)) continue; // unobtainable
      const baseCost = cost(item.name);
      if (baseCost == null) continue;                                 // neither buyable nor craftable
      // Ring set-bonus (SPEC §13.1): acquiring a ring can form a matched pair with the other ring.
      const ringDelta = (ctx.setBonuses && RING_SLOT_IDS.includes(slot))
        ? ringSetDelta(ctx.setBonuses, ctx.rings || {}, slot, { name: item.name, level: item.level })
        : {};
      const statDiff = mergeStats(item.stats, ringDelta); // vs an empty slot → the item's own stats
      if (!improvesAnyStat(statDiff)) continue;
      const nb = netBuy(ctx, item.name, 1, baseCost);
      acq.push({ item, statDiff, ringDelta, goldCost: nb.gold, pointGain: score(item.stats) + score(ringDelta), nb });
    }
    // Prune strictly dominated acquisitions (another candidate costs ≤ and gains ≥, strictly better
    // on one axis) so an empty slot doesn't flood the ranked list with every inferior variant.
    const survivors = acq.filter((r) => !acq.some((o) => o !== r &&
      o.pointGain >= r.pointGain && o.goldCost <= r.goldCost &&
      (o.pointGain > r.pointGain || o.goldCost < r.goldCost)));
    for (const { item, statDiff, ringDelta, goldCost, pointGain, nb } of survivors) {
      moves.push(mk(slot, "baseSwap", {
        from: null, to: item.name,          // from:null → the UI renders "acquire → X" (index.html)
        goldCost,
        pointGain, statDiff,
        setDelta: ringDelta,
        reEnchant: 0, reEnchantItems: [], reEnhance: 0,
        inventoryCredit: nb.credit, inventoryUsed: nb.used,
        toLevel: enhanceable ? 0 : null,
        apply: { kind: "base", item, level: enhanceable ? 0 : null },
      }));
    }
  }

  // tier steps (weapon/armor: craft UP the chain, SPEC §4)
  // Emit one move per reachable TARGET tier (cumulative cost+gain from the current base),
  // not just the immediate next tier. An intermediate tier can be a low-value PREREQUISITE
  //, e.g. +15 Orna Helm → Uaithne Helm is only +4 Crit Res, but it UNLOCKS the Add-Dmg
  // tiers above it. Judging that first step alone (poor gold/pt) would make the ranked view
  // and the greedy solver skip it and never reach the good tiers; a move straight to the
  // deeper target prices the whole path so the climb is judged as one decision.
  if (TIER_SLOT_IDS.includes(slot) && state.base && ctx.tierChain && ctx.craftCost) {
    const first = ctx.tierChain.get(state.base.name);
    if (first) {
      // Tuning headroom of the CURRENT base, a tier target that raises a stat's cap
      // ENABLES more tuning of it (a higher system unlocks bigger ATT Surplus / Destruction
      // caps). Recorded per target as `enables` so stat-maximize/threshold climbs tiers to
      // reach destruction it can't tune on the current base (SPEC §12).
      const curCaps = tuningCaps(state.base.name, ctx);
      // Diff baseline depends on whether the step crosses a SYSTEM JUMP (SPEC §12):
      //   • intra-system advance (e.g. Uaithne → Fine Uaithne, no wipe): ALL tuning carries
      //     over, so it's present on both sides and cancels → diff against the BARE base.
      //   • system jump (orna→uaithne / uaithne→eriu, wipe): base-stat tuning RESETS to the
      //     new piece's base (you re-tune it) while Destruction carries free → diff against
      //     the base + non-destruction tuning (`tunedBaseStats`). Picked per-step below once
      //     `crossedWipe` is known.
      const bareBase = state.base?.stats || {};
      const jumpBase = tunedBaseStats(state);
      // own-tier credit (constant across targets): the currently-owned tier's cost is
      // counted once at the bottom of craftCost(target). The free-issue +12 Orna piece
      // costs 0, so a climb starting there gets no credit, which is correct.
      const ownCredit = first.prevQty > 0 ? first.prevQty * (cost(state.base.name) ?? 0) : 0;
      // Crossing a system jump requires the CURRENT piece fully base-tuned first (Destruction aside)
      //, a REQUIRED in-game gate, true for Orna→Uaithne AND Uaithne→Eriu. That maxing is a real
      // prerequisite COST (current → cap), but the base-stat tuning it buys is then WIPED to 0 by the
      // jump (only Destruction carries), so it is a sunk gate tax. NOT added to the target's stats.
      // A path crossing MULTIPLE jumps (Orna→Uaithne→Eriu) charges the prereq PER jump-source piece,
      // chained (accumTuningPrereq), computed per-target in the walk from the jump sources so far.
      const stateTuningByCanon = {};
      for (const [k, v] of Object.entries(state.tuning || {})) stateTuningByCanon[tuneStatCanon(k)] = v;
      // On a wipe (system jump) the kept affixes are lost. Two ways to preserve them:
      //   (a) re-enchant each kept affix from scratch (Σ enchantCost), or
      //   (b) consume ONE extraction rune, saves BOTH affixes at a flat per-rune
      //       price (armor/weapon only; SPEC §3). Whichever is cheaper is the wipe
      //       cost. The rune is irrelevant if the slot has no affixes to keep.
      let reEnchant = 0, reEnchantOk = true, keptAffixes = 0;
      const keptScrolls = [];   // {scroll, gold, ignored} per kept affix, for the detail's material view
      for (const affix of AFFIXES) {
        const s = state[affix]?.scroll;
        if (!s) continue;
        const e = enchants[s];
        if (!e) continue;
        keptAffixes++;
        const ec = enchantCost(e, prices, opts);
        if (!ec) { reEnchantOk = false; break; }
        reEnchant += ec.gold;
        keptScrolls.push({ scroll: s, gold: ec.gold });
      }
      // On a system jump BOTH enchants and base-stat tuning are wiped (a fundamentally new item);
      // only Destruction carries. Tuning can't be preserved at all, its loss is folded into the
      // stat diff (and re-tuning the new piece is a separate tuneStep). The ONLY thing an extraction
      // rune preserves is the ENCHANTS, so the wipe-keep choice is purely re-enchant the kept affixes
      // vs one rune (whichever is cheaper).
      const preserveAny = keptAffixes > 0;
      const runeGold = preserveAny ? (cost(EXTRACTION_RUNE_NAME) ?? null) : null;
      let wipeKeepCost, wipeKeepOk, wipePreserved;
      if (!preserveAny) { wipeKeepCost = 0; wipeKeepOk = true; wipePreserved = false; }
      else if (reEnchantOk && (runeGold == null || reEnchant <= runeGold)) {
        wipeKeepCost = reEnchant; wipeKeepOk = true; wipePreserved = false;
      } else if (runeGold != null) {
        wipeKeepCost = runeGold; wipeKeepOk = true; wipePreserved = true;
      } else { wipeKeepCost = 0; wipeKeepOk = false; wipePreserved = false; }
      let node = state.base.name, wipeCount = 0, steps = 0;
      const seen = new Set([node]);
      const jumpBases = []; // SOURCE piece of each jump crossed so far (for the chained tuning prereq)
      while (true) {
        const up = ctx.tierChain.get(node);
        if (!up || seen.has(up.name)) break;
        seen.add(up.name);
        steps++;
        if (up.wipe) { wipeCount++; jumpBases.push(node); } // each system jump wipes + must be base-tuned first
        const craft = ctx.craftCost(up.item.name);
        if (craft == null) break;                     // can't price this tier (or beyond) → stop
        node = up.name;                               // advance the walk
        const crossedWipe = wipeCount > 0;
        if (crossedWipe && !wipeKeepOk) continue;     // a wipe target can't preserve affixes at any priceable cost
        // Chained base-tuning prereq for every jump crossed to reach THIS target (each source
        // piece maxed, carrying free into the next). Orna→Eriu now pays Orna + Uaithne tuning.
        const tunePrereq = crossedWipe
          ? accumTuningPrereq(jumpBases, stateTuningByCanon, ctx)
          : { gold: 0, caps: {}, maxes: [], breakdown: [], ok: true };
        // A path crossing TWO system jumps (orna→uaithne→eriu) pays the preservation cost
        // once PER jump, each boundary wipes again, needing its own rune / re-enchant+re-tune.
        // The base-tuning prerequisite applies only when this target CROSSES a jump
        // (`crossedWipe`). Intra-system advances (e.g. Uaithne→Fine Uaithne, or an Orna +level)
        // don't pay it. Net owned stock across both components through ONE shared clone (per
        // target, since crossedWipe varies), so a material in both (e.g. Superior Enhancement
        // Elixir, in the Orna steps and the Uaithne craft) isn't double-credited; the craft BOM
        // draws from what the tuning prereq left. The equipped current tier is seeded as owned
        // (prevQty units) so it stays the free own-tier credit, not reported as stock.
        const moveOwned = hasInventory(ctx) ? { ...ctx.inventory } : null;
        let tuneNb = { credit: 0, used: null };
        if (moveOwned && crossedWipe && tunePrereq.breakdown.length) {
          tuneNb = netBreakdown(ctx, tunePrereq.breakdown, moveOwned);
        }
        const nb = netBuy(ctx, up.item.name, 1, craft - ownCredit,
          first.prevQty > 0 ? { [state.base.name]: first.prevQty } : null, moveOwned);
        const tuneGold = crossedWipe ? tunePrereq.gold : 0;
        const goldCost = nb.gold + wipeCount * wipeKeepCost + (tuneGold - tuneNb.credit);
        // Set-bonus swing (SPEC §13.2): jumping this slot to the target's system shifts
        // a piece-count tier on BOTH the system it leaves and the one it joins. Fold the
        // scored delta into statDiff + pointGain so the climb is judged on net value
        // (an Orna→Uaithne armor jump loses a little Orna bonus, gains the Uaithne one).
        const setDelta = ctx.setBonuses
          ? setBonusDelta(ctx.setBonuses, ctx.composition || {}, slot, itemSystem(up.item.name))
          : {};
        // Diff baseline (SPEC §12):
        //   • Intra-system advance (no wipe): ALL tuning carries, so it's on both sides and
        //     cancels → diff the target's BARE base against the current BARE base.
        //   • System jump (wipe): it's a fundamentally new item. ALL base-stat tuning
        //     (Crit Res/Def/Att/Bal/Att Spd) is WIPED to 0; only Destruction (Dest I/II)
        //     carries over. So the equipped side folds in the current non-Destruction tuning
        //     (`jumpBase`). The stat you're LEAVING. While the new side is the target's
        //     bare base with NO base-stat tuning (`up.item.stats`), reflecting that the tuning
        //     is lost until you re-tune the new piece. Destruction is excluded from both sides
        //     (present on each, unchanged → cancels). Net effect: an Orna→Uaithne Greaves shows
        //     +6 Crit Res (52 new base − 46 tuned Orna), NOT +13, the +7 Crit Res tuning is a
        //     loss folded into the diff, not carried forward.
        const baseStats = crossedWipe ? jumpBase : bareBase;
        const endStats = up.item.stats;
        const statDiff = mergeStats(statDelta(endStats, baseStats), setDelta);
        // Tuning headroom this target unlocks vs the current base (per scored stat).
        const newCaps = tuningCaps(up.item.name, ctx);
        const enables = {};
        for (const k in newCaps) { const d = newCaps[k] - (curCaps[k] || 0); if (d > 0) enables[k] = d; }
        if (!improvesAnyStat(statDiff) && !Object.keys(enables).length) continue;
        moves.push(mk(slot, "tierStep", {
          from: state.base.name, to: up.item.name, steps,
          goldCost,
          pointGain: score(endStats) - score(baseStats) + score(setDelta), statDiff,
          setDelta, // scored set-bonus change folded into this step (for the UI detail)
          enables,  // per-stat tuning cap INCREASE this tier unlocks (stat-maximize climbs to it)
          // wipe = enchants lost on the jump; wipePreserved = they were carried via an
          // extraction rune (cheaper than re-enchant) → enchanting now is NOT wasted.
          wipe: crossedWipe, wipePreserved: crossedWipe && wipePreserved,
          // A wipe loses the enchants (the rune, if cheaper than re-enchanting, carries them) AND
          // the base-stat tuning (unpreservable, its loss is folded into statDiff/pointGain).
          reEnchant: crossedWipe && !wipePreserved ? wipeCount * reEnchant : 0,
          extraction: crossedWipe && wipePreserved ? wipeCount * (runeGold || 0) : 0, ownCredit,
          // Base-tuning-to-max prerequisite for crossing a system jump (Orna→Uaithne, Uaithne→Eriu;
          // folded into goldCost, carries free to the new system). Only on a jump target, intra-
          // system advances don't force tuning. `tunePrereqOk` false = a tuning material was
          // unpriceable (cost under-counted, flagged in the UI).
          tunePrereqGold: tuneGold, tunePrereqBreakdown: crossedWipe ? tunePrereq.breakdown : [],
          tunePrereqOk: tunePrereq.ok,
          // Inventory credit spans the craft BOM (nb) AND the tuning prereq (tuneNb), both drawn
          // from one shared clone (no double-credit). The cost LINES above are gross; the
          // "From inventory" line nets both.
          inventoryCredit: nb.credit + tuneNb.credit,
          inventoryUsed: mergeUsed(nb.used, tuneNb.used),
          // Stock the tuning prereq drew BEFORE the craft BOM. The UI nets its recipe/carousel
          // totals from inventory minus this, so those totals reconcile with the Math grid
          // instead of re-crediting shared materials from a fresh clone.
          preCraftUsed: tuneNb.used,
          // The enchant-keep DECISION for the detail: re-enchant the kept affixes vs one rune, per
          // jump (×`jumps` for the total). Only when there are affixes to preserve.
          wipeMath: crossedWipe && preserveAny ? {
            jumps: wipeCount, reEnchant, rune: runeGold,
            chose: wipePreserved ? "rune" : "redo", keptAffixes, affixes: keptScrolls,
          } : null,
          // On a jump, applyMove wipes base-stat tuning to 0 (keeps Destruction). See the
          // `a.wipe` branch. No tuning is carried, so nothing to record here.
          apply: { kind: "tier", item: up.item, wipe: crossedWipe, wipePreserved },
        }));
      }
    }
  }

  // enhance one level (current → +1)
  if (ENHANCEABLE_SLOT_IDS.includes(slot) && state.base && state.enhance) {
    const { level, bracket } = state.enhance;
    if (level != null && level < 20 && bracket != null) {
      const table = accessories?.brackets?.[bracket];
      const next = table?.find((e) => e.level === level + 1);
      const prev = level === 0 ? { att: 0, defPen: 0 } : table?.find((e) => e.level === level);
      if (next && prev) {
        const pointGain = score({ att: next.att - prev.att, defPen: next.defPen - prev.defPen });
        const ec = pointGain > 0 ? enhanceStepCost(next, accessories.pity?.[level + 1] || [], prices, opts?.basis, ctx.freeItems) : null;
        if (ec) {
          // Credit owned enhancement materials against the EXPECTED consumption (per-attempt
          // qty × expected attempts). Same inventory netting every other move kind gets, so
          // owning e.g. Superior Enhancement Elixirs discounts the accessory enhance step.
          const enhBreakdown = [{ materials: Object.entries(ec.materials).map(([material, qty]) => ({ material, qty: qty * ec.attempts })) }];
          const enhNb = netBreakdown(ctx, enhBreakdown);
          moves.push(mk(slot, "enhanceStep", {
            from: `+${level}`, to: `+${level + 1}`, bracket,
            goldCost: ec.gold - enhNb.credit, pointGain,
            statDiff: statDelta({ att: next.att, defPen: next.defPen }, prev),
            attempts: ec.attempts, perAttempt: ec.perAttempt, fee: ec.fee, materials: ec.materials,
            inventoryCredit: enhNb.credit, inventoryUsed: roundUsed(enhNb.used),
            apply: { kind: "enhance", level: level + 1 },
          }));
        }
      }
    }
  }

  moves.push(...tuneMoves(state, ctx));

  // Veto filter (SPEC §7.4): drop user-vetoed moves at the single move-gen source, so
  // they vanish app-wide, the ranked list, the stat-target views, the Target solver
  // candidates, AND the rebase/better hints all read through slotMoves. `ctx.vetoes` is
  // held by reference (like inventory), so a veto edit + recompute re-filters with no ctx
  // rebuild; an empty/absent list is a no-op.
  return ctx.vetoes?.length ? moves.filter((m) => !moveVetoed(m, ctx.vetoes)) : moves;
} // end slotMoves, the veto filter belongs HERE (covers all move kinds), not on tuneMoves below.

// Tuning moves (SPEC §12 tuneStep). For a weapon/armor slot, surface the priced path
// to its tuning caps as ranked moves. Two kinds, mirroring the §4 tier chain's
// cumulative pricing:
//   • per unlocked base stat (Unlock 0) not yet maxed → "tune <stat> to cap" (granular,
//     so a cheap ATT tune ranks apart from an expensive BAL tune);
//   • per locked capstone (Unlock 1 = Surplus I, 2 = Surplus II) → a CUMULATIVE move
//     that ALSO maxes every PREREQUISITE row still short of its cap, so the gated
//     Destruction capstone is reachable as ONE decision the greedy can't skip past
//     (maxing the cheap prerequisites alone could rank too poorly to ever be taken).
//     What counts as a prerequisite is system-dependent: on Orna a capstone gates on the
//     base stats being maxed; on Uaithne/Eriu it gates only on the lower Destruction tier
//     (Dest I unlocks freely, Dest II behind Dest I). See `gatesOnBase` below.
// Per-tick cost recurses through ctx.cost for materials (like craftCost); a stat whose
// per-tick can't be priced is dropped. Re-baselining (applyMove updates per-stat tuning
// amounts) keeps a cumulative move from double-counting prerequisites maxed elsewhere.
// Per-tick price of one tuning row: flat gold + Σ qty·cost(material). null when a
// material is unpriceable (the row can't be costed at all).
const tunePerTick = (ctx, row) => {
  let g = row.gold || 0;
  for (const { material, qty } of row.materials) {
    const c = ctx.cost(material);
    if (c == null) return null;
    g += qty * c;
  }
  return g;
};
// One row's contribution to a tune move's cost, exposed for the detail's breakdown: the
// flat fee (gold × ticks) and each material's TOTAL qty (per-tick × ticks). `rowGold` is
// the row's full cost (fee + materials), matching what `climb` summed into goldCost.
const tuneRowDetail = (row, c) => ({
  stat: row.stat, key: row.key, ticks: c.ticks, gain: c.gain, rowGold: c.gold,
  feeGold: c.ticks * (row.gold || 0),
  materials: row.materials.map(({ material, qty }) => ({ material, qty: qty * c.ticks })),
});

function tuneMoves(state, ctx) {
  if (!ctx.tuning || !state.base || !TIER_SLOT_IDS.includes(state.slot)) return [];
  const rows = ctx.tuning[tuningKey(state.base.name)];
  if (!rows || !rows.length) return [];
  const cur = state.tuning || {};
  // Read the current amount by canonical token, so a tuning persisted under an older
  // destruction label (ATT Surplus/DES) is still recognised against a renamed row (Dest I/II)
  // instead of reading 0 and treating the stat as untuned.
  const curByCanon = {};
  for (const [k, v] of Object.entries(cur)) curByCanon[tuneStatCanon(k)] = v;
  const amountOf = (row) => curByCanon[tuneStatCanon(row.stat)] || 0;
  // Climb one row from its current amount to its cap: { gold, gain (stat amount), ticks }.
  // The final tick may be partial (gain capped at maxTune) but still costs a full tick.
  const climb = (row) => {
    const from = amountOf(row);
    if (from >= row.maxTune) return { gold: 0, gain: 0, ticks: 0 };
    const pt = tunePerTick(ctx, row);
    if (pt == null) return null;
    const ticks = Math.ceil((row.maxTune - from) / row.step);
    return { gold: ticks * pt, gain: row.maxTune - from, ticks };
  };
  const tunes = [], slot = state.slot; // named `tunes`, not `moves`: this is tuneMoves, a
  // SEPARATE function from slotMoves above, keep the two tails distinct so an edit meant for
  // slotMoves' `return moves` doesn't land on this one (the veto filter once did, see §7.4).
  // Destruction already tuned on this slot, the tiebreak for "finish the piece with the
  // most existing destruction first" when two tune moves have equal gold/pt (SPEC §12).
  const existingDest = rows.filter((r) => r.key === "destruction")
    .reduce((s, r) => s + amountOf(r), 0);
  // Whether the Destruction capstones gate on the base stats being maxed. On Orna they do
  // (Dest I. Its only Destruction tier. Is locked behind base tuning). On Uaithne/Eriu they
  // do NOT: Dest I unlocks freely and only Dest II is gated, behind Dest I maxing out. So on
  // those systems a capstone bundles only the LOWER Destruction tiers as prerequisites, never
  // base stats. (Base stats stay separately tunable either way via the Unlock-0 moves above.)
  const gatesOnBase = itemSystem(state.base.name) === "Orna";

  // per-stat base tunes (Unlock 0, always available)
  for (const row of rows) {
    if (row.unlock !== 0 || amountOf(row) >= row.maxTune) continue;
    const c = climb(row);
    if (!c || c.gold <= 0 || c.gain <= 0) continue;
    const statDiff = statDelta({ [row.key]: c.gain }, {});
    const maxes = [{ stat: row.stat, amount: row.maxTune }];
    const breakdown = [tuneRowDetail(row, c)];
    const nb = netBreakdown(ctx, breakdown);
    tunes.push(mk(slot, "tuneStep", {
      stat: row.stat, capstone: 0, ticks: c.ticks, existingDest,
      tickSize: row.step, cap: row.maxTune, // the Planner's tune-target stepper grid (§17.7)
      goldCost: c.gold - nb.credit, pointGain: score(statDiff), statDiff,
      inventoryCredit: nb.credit, inventoryUsed: nb.used,
      apply: { kind: "tune", maxes },
      breakdown,
    }));
  }

  // cumulative capstones (Unlock 1 = Surplus I, then 2 = Surplus II)
  for (const U of [1, 2]) {
    const capRows = rows.filter((r) => r.unlock === U);
    if (!capRows.length || capRows.every((r) => amountOf(r) >= r.maxTune)) continue;
    // Prerequisites bundled into this capstone: lower Destruction tiers always, plus base
    // stats only when the system gates on them (Orna). On Uaithne/Eriu base stats (unlock 0)
    // are excluded, so Dest I has no prerequisite and Dest II gates only on Dest I.
    const isPrereq = (r) => (gatesOnBase ? r.unlock < U : r.unlock >= 1 && r.unlock < U);
    const involved = rows.filter(
      (r) => (r.unlock === U || isPrereq(r)) && amountOf(r) < r.maxTune,
    );
    let gold = 0, ok = true;
    const statSum = {}, maxes = [], breakdown = [];
    for (const r of involved) {
      const c = climb(r);
      if (!c) { ok = false; break; }
      gold += c.gold;
      if (c.gain > 0) statSum[r.key] = (statSum[r.key] || 0) + c.gain;
      maxes.push({ stat: r.stat, amount: r.maxTune });
      // Prerequisite rows bundled in (the capstone is gated behind them being maxed). Flag
      // them so the detail can show the prereq cost explicitly.
      if (c.gain > 0) breakdown.push({ ...tuneRowDetail(r, c), prereq: isPrereq(r) });
    }
    if (!ok) continue;
    const statDiff = statDelta(statSum, {});
    const pointGain = score(statDiff);
    if (pointGain <= 0 || gold <= 0) continue;
    const nb = netBreakdown(ctx, breakdown);
    tunes.push(mk(slot, "tuneStep", {
      stat: capRows.map((r) => r.stat).join(" + "), capstone: U, existingDest,
      // Stepper grid only when the move is a single row (no bundled prereqs). A multi-row
      // capstone can't be tick-adjusted (the prereq portion isn't optional).
      ...(involved.length === 1 ? { tickSize: involved[0].step, cap: involved[0].maxTune } : {}),
      goldCost: gold - nb.credit, pointGain, statDiff,
      inventoryCredit: nb.credit, inventoryUsed: nb.used,
      apply: { kind: "tune", maxes },
      breakdown,
    }));
  }
  return tunes;
}

// Partial tuning (SPEC §17.7, the Planner's tune-target stepper)
// The tuning row backing `statLabel` on the slot's current base, or null. Exposed so the
// Planner's stepper knows the row's tick size + cap to move a target by whole ticks.
export function tuneRowFor(state, ctx, statLabel) {
  if (!ctx.tuning || !state?.base) return null;
  const rows = ctx.tuning[tuningKey(state.base.name)] || [];
  return rows.find((r) => tuneStatCanon(r.stat) === tuneStatCanon(statLabel)) || null;
}

// A tick-limited tuneStep: climb `statLabel` from its current amount to `target` (clamped
// to the row's cap) instead of all the way. Same move shape as tuneMoves' output so
// reconcilePath prices a below-cap Planner step like any other; `partial: true` marks it.
// Tuning cost is LINEAR (every tick = same gold, same gain), so a partial chunk has the
// same gold/point as the to-cap move, this exists for affordability/planning granularity,
// never ranking (tuneMoves stays to-cap; the Upgrades list is unchanged). Returns null when
// the row is missing/unpriceable, the target adds nothing, or the row's unlock gate isn't
// open yet, a partial can't bundle prerequisites; the to-cap capstone move owns that.
export function tunePartialMove(state, ctx, statLabel, target) {
  const row = tuneRowFor(state, ctx, statLabel);
  if (!row || !(row.step > 0)) return null;
  const rows = ctx.tuning[tuningKey(state.base.name)];
  const curByCanon = {};
  for (const [k, v] of Object.entries(state.tuning || {})) curByCanon[tuneStatCanon(k)] = v;
  const amountOf = (r) => curByCanon[tuneStatCanon(r.stat)] || 0;
  if (row.unlock > 0) {
    // Same gate shape as tuneMoves: Orna capstones sit behind the base stats; Uaithne/Eriu
    // ones only behind the lower Destruction tier.
    const gatesOnBase = itemSystem(state.base.name) === "Orna";
    const prereq = rows.filter((r) =>
      (gatesOnBase ? r.unlock < row.unlock : r.unlock >= 1 && r.unlock < row.unlock));
    if (prereq.some((r) => amountOf(r) < r.maxTune)) return null;
  }
  const cur = amountOf(row);
  const to = Math.min(target, row.maxTune);
  if (to <= cur) return null;
  const pt = tunePerTick(ctx, row);
  if (pt == null) return null;
  const c = { ticks: Math.ceil((to - cur) / row.step), gain: to - cur };
  c.gold = c.ticks * pt;
  const statDiff = statDelta({ [row.key]: c.gain }, {});
  const breakdown = [tuneRowDetail(row, c)];
  const nb = netBreakdown(ctx, breakdown);
  const existingDest = rows.filter((r) => r.key === "destruction")
    .reduce((s, r) => s + amountOf(r), 0);
  return mk(state.slot, "tuneStep", {
    stat: row.stat, capstone: row.unlock, partial: true, ticks: c.ticks, existingDest,
    tickSize: row.step, cap: row.maxTune,
    goldCost: c.gold - nb.credit, pointGain: score(statDiff), statDiff,
    inventoryCredit: nb.credit, inventoryUsed: nb.used,
    apply: { kind: "tune", maxes: [{ stat: row.stat, amount: to }] },
    breakdown,
  });
}

// Apply a move to a slot state, returning a new state (immutable).
export function applyMove(state, move) {
  const ns = {
    ...state,
    base: state.base && { ...state.base },
    prefix: state.prefix && { ...state.prefix },
    suffix: state.suffix && { ...state.suffix },
    enhance: state.enhance && { ...state.enhance },
    tuning: { ...(state.tuning || {}) },
  };
  const a = move.apply;
  if (a.kind === "enchant") {
    ns[a.affix] = { scroll: a.scroll, restored: false };
  } else if (a.kind === "base") {
    ns.base = { name: a.item.name, stats: a.item.stats, level: a.item.level };
    if (ns.prefix) ns.prefix.restored = true;       // affixes were re-bought on the new base
    if (ns.suffix) ns.suffix.restored = true;
    ns.enhance = a.level != null ? { level: a.level, bracket: a.item.level } : null;
  } else if (a.kind === "enhance") {
    ns.enhance = { ...ns.enhance, level: a.level };
  } else if (a.kind === "tune") {
    for (const { stat, amount } of a.maxes) ns.tuning[stat] = amount;
  } else if (a.kind === "tier") {
    ns.base = { name: a.item.name, stats: a.item.stats, level: a.item.level };
    // within-system OR rune-preserved: enchants kept untouched, no per-affix re-enchant
    // prepaid → don't flag restored. Plain wipe: the step re-bought the same affixes, so
    // flag them `restored`, a later enchant replacing one credits that re-enchant back.
    if (a.wipe && !a.wipePreserved) {
      if (ns.prefix) ns.prefix.restored = true;
      if (ns.suffix) ns.suffix.restored = true;
    }
    // A system jump makes a fundamentally new item: base-stat tuning is WIPED to 0; only
    // Destruction (Dest I/II) carries over. Drop every non-Destruction tuning entry so a
    // later tuneStep on the new base re-climbs from 0 (SPEC §12). Intra-system advances keep
    // all tuning (ns.tuning was copied wholesale above).
    if (a.wipe) {
      const kept = {};
      for (const [label, amt] of Object.entries(ns.tuning))
        if (TUNING_STAT_TO_KEY[label] === "destruction") kept[label] = amt;
      ns.tuning = kept;
    }
  }
  return ns;
}

// Ranked action list (SPEC §7.1): every move from the initial loadout state,
// cheapest gold-per-point first. Drop-in replacement for moves.generateMoves:
// same shape, but base-swap costs now include re-enchant + re-enhance-to-current.
export function generateMoves(loadout, ctx) {
  const states = initStates(loadout, ctx);
  // Each ranked move is judged independently from the initial loadout, so the set-
  // bonus composition is fixed at the initial one (SPEC §13.2).
  const lctx = { ...ctx, composition: compositionOf(states), rings: ringsOf(states) };
  const all = [];
  for (const slot in states) all.push(...slotMoves(states[slot], lctx));
  return all.sort((a, b) => a.goldPerPoint - b.goldPerPoint);
}

// Threshold mode (SPEC §7.2): greedily assemble the cheapest bundle that closes a
// set of stat gaps, RE-BASELINING after each pick. Repeatedly take the move with
// the best gold per unit of NET still-needed stat, apply it to that slot's state,
// and regenerate moves from the new state, so the bundle can chain (swap a base,
// then enchant/enhance it) without the old "one move per slot" cap or double-pay.
// `needs` maps stat → amount still wanted; use Infinity for a "maximize this stat"
// goal (take every improving move).
//
// Three refinements over the naive greedy (SPEC §7.2):
//   • NET-useful metric, a move's value is its gain on open needs MINUS its harm
//     to OTHER open needs (a +Crit/−Bal move counts −Bal when Bal is also a goal),
//     so the bundle doesn't pick moves that fight each other. Ranking is POINT-weighted
//     (a multi-stat goal isn't dominated by Att-sized raw deltas) and PENALTY-AWARE:
//     harm to scored stats the goal never mentioned is debited at full weight too
//     (`collateralPenalty`), so the bundle prefers a clean move over a messy one when
//     they're close in gold. Inclusion is unchanged: a move must still help an open need.
//   • lossy gating, when `allowLossy` is off (default), NET-LOSS moves (pointGain<0,
//     e.g. a Fast scroll) are excluded in EVERY mode, maximize included; flip the
//     toggle to pull them in (a +AttSpd/−Bal scroll for "max att spd").
//   • budget cap, `budget` (gold) caps the bundle's TOTAL spend; moves that
//     wouldn't fit the remaining budget are skipped, and `budgetLimited` flags a
//     bundle that stopped short because the next useful move was unaffordable.
//
// After the greedy loop the bundle is CONSOLIDATED per slot (see consolidateBundle):
// picks are rebuilt in canonical order, base swap first, then enchant, then enhance
//, so an enchant/enhance bought BEFORE a same-slot base swap is no longer double-
// paid (the swap restores the ORIGINAL affix, the enchant lands on the new base with
// credit-back), and a marginal scroll later overwritten by a better one is dropped.
// This is what fixes "upgrade a scroll, then replace the item it's on."
//
// Returns the (consolidated) `chosen` bundle, the per-stat `remaining` deficit
// (≤0 ⇒ met; Infinity ⇒ a maximize goal, never "met"), the net `gained` per tracked
// stat (can be NEGATIVE for a tradeoff stat another pick lowered), and `budgetLimited`.
//
// `exclude` (Set of "<slot>:<type>" keys, internal) forbids matching moves, used by the
// leave-one-out improvement pass in solveThreshold() to reroute around a needlessly
// expensive base swap.
function greedySolve(needs, loadout, ctx, solverOpts = {}) {
  const { allowLossy = false, budget = Infinity, exclude = null, floors = null, current = null, floorFirst = false } = solverOpts;
  const initial = initStates(loadout, ctx);
  const states = { ...initial };       // applyMove is immutable → `initial` stays pristine
  const maximizing = Object.values(needs).some((v) => !Number.isFinite(v));
  const lossyOK = allowLossy; // gates every mode (incl. maximize). Toggle is honored on all screens
  const remaining = { ...needs };
  const chosen = [];
  const baseSwapped = new Set(); // ≤ 1 base swap per slot, re-buying a base discards
  //                                the prior one (pure waste); chain via enchant/enhance instead.
  // Per (slot|affix) set of scrolls the greedy has already placed on that affix (seeded with the one
  // it starts with). An enchant swap never re-lands a scroll the affix has held before. Enchant is
  // the ONLY re-pickable move type, base/enhance/tune/tier all advance a slot's state monotonically,
  // so they can't recur, but the live set-bonus composition (recomputed each round as other slots
  // tier-jump, §13.2) can flip which suffix/prefix scores best, ping-ponging an affix A→B→A→…. That
  // runs the greedy to CAP, and consolidateBundle then falls back to the raw picks → a bundle listing
  // the same scroll dozens of times (its gold counted each time). A finite scroll set with no revisits
  // ⇒ ≤ (#scrolls) swaps per affix ⇒ termination; the final per-slot state (hence the consolidated
  // one-enchant-per-affix result) is unchanged in the non-pathological case.
  const affixSeen = {};
  for (const slot in states) for (const affix of AFFIXES) {
    const sc = states[slot][affix]?.scroll;
    affixSeen[`${slot}|${affix}`] = new Set(sc ? [sc] : []);
  }
  // Running projected stat totals (current + Σ picked statDiffs), so a floor check can reject any
  // move that would drop a floored stat below its floor (SPEC §7.2). `floorStats` collects the
  // floors that blocked an otherwise-useful move → the "you could go higher if you sacrifice X" warn.
  const totals = { ...(current || {}) };
  const floorStats = new Set();
  let spent = 0, budgetLimited = false, lossyLimited = false, floorLimited = false;
  const open = () => Object.keys(remaining).filter((s) => remaining[s] > 0);
  const CAP = 500; // safety; finite candidates per slot ⇒ terminates well below this
  // Set-bonus composition shifts as the bundle jumps systems, the cache regenerates
  // only the slots a pick actually affects (§13.2 comp / §13.1 rings tracked inside).
  const mc = makeMoveCache(states, ctx);
  while (open().length && chosen.length < CAP) {
    const need = open();
    const needSet = new Set(need); // goal stats, excluded from the collateral penalty (netted below)
    let best = null, budgetBlocked = false, lossyBlocked = false;
    for (const slot in states) {
      for (const m of mc.movesFor(slot)) {
        if (m.type === "baseSwap" && baseSwapped.has(m.slot)) continue;
        // never re-place a scroll this affix already held → no A→B→A composition ping-pong (affixSeen)
        if (m.type === "enchantSwap" && affixSeen[`${m.slot}|${m.affix}`]?.has(m.to)) continue;
        // forbidden by an improvement pass, either ALL swaps on a slot (`slot:baseSwap`,
        // cost pass) or one SPECIFIC base target (`slot:baseSwap:<to>`, feasibility pass).
        if (exclude && (exclude.has(`${m.slot}:${m.type}`) ||
            (m.type === "baseSwap" && exclude.has(`${m.slot}:baseSwap:${m.to}`)))) continue;
        let value; // ranking value for this round; higher = better pick
        if (maximizing) {
          // "Maximize these stats": INCLUDE any move that pushes an open need (don't debit
          // collateral for inclusion, a +Crit base that dips a little Att should still
          // count), and RANK by point-WEIGHTED gain over the open stats so the ≤1-base-swap
          // cap lands the highest-VALUE base, not whichever has the biggest raw (Att-sized)
          // delta. Checking every stat thus maximizes total value instead of an Att blend.
          // A tierStep that ENABLES more tuning of an open need (higher Surplus cap) also
          // counts, so maximize climbs tiers to reach destruction the current base can't tune.
          const improves = need.some((s) => (m.statDiff?.[s] || 0) > 0);
          const enables = need.some((s) => (m.enables?.[s] || 0) > 0);
          if (!improves && !enables) continue;            // helps no open need, directly or via headroom
          // ...then DEBIT what the move costs you elsewhere (penalty-aware, weight 1): between two
          // bases that push the open need equally, the one that doesn't dump Bal/Crit now wins.
          // Maximize compares `value` directly (no division), so a net-negative value is meaningful
          // and left unclamped, it simply sorts below every cleaner candidate.
          value = scoreSubset(m.statDiff, need) + scoreSubset(m.enables, need)
                - collateralPenalty(m.statDiff, needSet, floors);
          // Floor-efficiency (issue 6/7): a move eating a scarce floor's budget is worth LESS. Demote
          // it (down to a last-resort epsilon when the budget it eats outweighs its gain) rather than
          // dropping it, a floor-efficient alternative then wins, but if this is the only move that
          // still FITS the floor it's kept (the hard floorViolation check below governs real breaches).
          if (floors) value = Math.max(value - floorBudgetPenalty(m, totals, floors, need), 1e-9);
        } else {
          // Finite need: NET value, credit gains on open needs, debit harm to others,
          // capped at what's still needed; cheapest gold per net unit wins. A tierStep's
          // unlocked tuning headroom counts too (so a destruction target unreachable on the
          // current base can climb tiers to a system whose Surplus cap covers it).
          // `useful`/`enabled` are RAW stat units and decide INCLUSION only (unchanged: a move must
          // still push an open need to be considered at all). `vp` is the same thing POINT-weighted,
          // and that is what RANKS, so a two-stat goal isn't decided by whichever stat happens to
          // come in Att-sized numbers.
          let useful = 0, enabled = 0, vp = 0;
          for (const s of need) {
            const d = m.statDiff?.[s] || 0;
            if (d > 0) useful += Math.min(d, remaining[s]);
            else if (d < 0) useful += d;
            vp += score({ [s]: d > 0 ? Math.min(d, remaining[s]) : d });
            const e = m.enables?.[s] || 0;
            if (e > 0) { enabled += Math.min(e, remaining[s]); vp += score({ [s]: Math.min(e, remaining[s]) }); }
          }
          if (useful + enabled <= 0) continue;
          // Penalty-aware (weight 1): debit the harm done to scored stats outside the goal, so the
          // cheapest-per-goal-unit pick is no longer free to trash everything else on the way.
          value = vp - collateralPenalty(m.statDiff, needSet, floors);
          // Floor-efficiency (issue 6/7): when floors are set, also subtract the scarcity-scaled floor
          // budget the move consumes (comparable units, both point-weighted), so a Bal-efficient move
          // beats a cheaper-but-Bal-hungry one as the floor tightens.
          if (floors) value -= floorBudgetPenalty(m, totals, floors, need);
          // `value` is the DIVISOR of the gold metric, so it must stay positive: a move whose
          // collateral/floor cost outweighs its goal progress is demoted to a last-resort epsilon,
          // kept rather than dropped (a boundary move that still FITS can be what closes the goal;
          // the hard floorViolation check below governs real breaches).
          value = Math.max(value, 1e-9);
        }
        if (!lossyOK && isLossy(m)) { lossyBlocked = true; continue; } // net-loss move, gated off
        if (m.goldCost > budget - spent) { budgetBlocked = true; continue; } // wouldn't fit budget
        // Reject a move that would push a floored stat below its floor, but remember which floor
        // did it (this move helps an open need, or we'd have `continue`d above), so the UI can offer
        // "lower that floor / allow tradeoffs to go higher" (issue 6/7).
        const fv = floorViolation(m, totals, floors);
        if (fv) { floorStats.add(fv); continue; }
        const metric = m.goldCost / value;
        // Floor-efficiency ranking (issue 6/7, floorFirst pass): the floor budget this move consumes
        // per unit of gain (point-weighted, headroom-normalized). Lower = more goal progress per unit
        // of the SCARCE floored resource, a move that eats no floor budget scores 0 (best). Used to
        // reach a goal a cheap-gold greedy would strand by burning the floor budget on cheap-but-hungry
        // moves; gold is only the tiebreak here (in Target mode gold is unbounded, so feasibility wins).
        let floorEff = 0;
        if (floorFirst && floors) {
          let use = 0;
          for (const s in floors) { const d = m.statDiff?.[s] || 0; if (d < 0) use += score({ [s]: -d }) / Math.max((totals[s] || 0) - floors[s], 1); }
          floorEff = use / value;
        }
        const better = !best || (maximizing
          ? (value > best.value ||
             (value === best.value && (m.pointGain || 0) > (best.m.pointGain || 0)))
          : floorFirst
          ? (floorEff < best.floorEff || (floorEff === best.floorEff && metric < best.metric))
          : metric < best.metric);
        if (better) best = { m, metric, value, floorEff };
      }
    }
    if (!best) { budgetLimited = budgetBlocked; lossyLimited = lossyBlocked; floorLimited = floorStats.size > 0; break; }
    chosen.push(best.m);
    spent += best.m.goldCost;
    if (best.m.type === "baseSwap") baseSwapped.add(best.m.slot);
    if (best.m.type === "enchantSwap") affixSeen[`${best.m.slot}|${best.m.affix}`].add(best.m.to);
    states[best.m.slot] = applyMove(states[best.m.slot], best.m);
    mc.picked(best.m.slot);
    for (const s in remaining) remaining[s] -= best.m.statDiff?.[s] || 0;
    for (const s in (best.m.statDiff || {})) totals[s] = (totals[s] || 0) + best.m.statDiff[s]; // keep the running totals current for the floor check
  }
  floorLimited = floorLimited || floorStats.size > 0; // a floor blocked a useful move at some point

  // Consolidate, then recompute net gained/remaining from the rebuilt bundle (its
  // per-slot final state is identical, so totals match, only the wasted intermediate
  // spend is gone). `remaining` from the greedy loop is the gap BEFORE consolidation;
  // consolidation never changes final stats, so we re-derive both from `finalChosen`.
  // NOTE: `budgetLimited` was judged against the PRE-consolidation spend, consolidation can
  // only shave waste, so the flag stays CONSERVATIVE (it may warn when the consolidated total
  // leaves a little room; knowing whether anything now fits would require re-solving).
  const finalChosen = consolidateBundle(chosen, initial, ctx);
  // `gained` = the bundle's FULL net stat change across EVERY stat any move touches, not just the
  // goal stats, so the sidebar's projected totals reflect a tradeoff move's LOSSES too (a +Att Spd
  // move that dips Crit/Bal shows the dip), which was invisible when gained only spanned `needs`
  // (issue 6). `remaining` still tracks only the goal deficits.
  const gained = {}, rem = { ...needs };
  for (const m of finalChosen) {
    for (const s in (m.statDiff || {})) gained[s] = (gained[s] || 0) + m.statDiff[s];
    for (const s in needs) rem[s] -= m.statDiff?.[s] || 0;
  }
  return { chosen: finalChosen, remaining: rem, gained, budgetLimited, lossyLimited, floorLimited, floorStats: [...floorStats] };
}

// Per-slot move cache for the greedy loops
// slotMoves(state, lctx) depends only on: that slot's STATE, the set-bonus
// COMPOSITION (tier slots' tierStep delta, §13.2), and the ring PAIR (ring slots'
// swap/acquire delta, §13.1). Everything else in ctx is static during one solve.
// So a greedy round only regenerates the slot whose state changed, plus tier/ring
// slots when the composition/rings actually shifted, instead of every slot every
// round (which redid the full costing work, the dominant solver cost).
const sameComp = (a, b) => {
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
};
const sameRings = (a, b) =>
  RING_SLOT_IDS.every((s) => (a[s]?.name === b[s]?.name) && (a[s]?.level === b[s]?.level));

function makeMoveCache(states, ctx) {
  let comp = compositionOf(states), rings = ringsOf(states);
  let lctx = { ...ctx, composition: comp, rings };
  const cache = new Map();
  return {
    movesFor(slot) {
      let ms = cache.get(slot);
      if (!ms) { ms = slotMoves(states[slot], lctx); cache.set(slot, ms); }
      return ms;
    },
    // Call after applying a pick to `states`: drops the picked slot's moves and, when
    // the set-bonus composition / ring pair moved, every slot whose deltas read them.
    picked(slot) {
      cache.delete(slot);
      const nc = compositionOf(states), nr = ringsOf(states);
      if (!sameComp(comp, nc)) for (const s of TIER_SLOT_IDS) cache.delete(s);
      if (!sameRings(rings, nr)) for (const s of RING_SLOT_IDS) cache.delete(s);
      comp = nc; rings = nr;
      lctx = { ...ctx, composition: comp, rings };
    },
  };
}

const bundleGold = (chosen) => chosen.reduce((g, m) => g + m.goldCost, 0);
// Every FINITE need is met (≤0 remaining). Maximize needs (Infinity) are never "met" and
// don't gate feasibility, they just take whatever improving moves remain.
const meetsNeeds = (needs, remaining) =>
  Object.keys(needs).every((s) => !Number.isFinite(needs[s]) || remaining[s] <= 0);

// True if alt's per-stat remaining deficit never WORSENS any finite need vs base.
// Used by the feasibility pass to accept a re-route to a stronger base only when it
// doesn't sacrifice another open goal (per-stat, since raw deficits aren't comparable
// across units, an Att gain must not mask a Crit regression).
const noNeedWorsened = (needs, alt, base) =>
  Object.keys(needs).every((s) => !Number.isFinite(needs[s]) ||
    Math.max(0, alt[s]) <= Math.max(0, base[s]));

// Stats with a finite goal still short of being met.
const unmetStats = (needs, remaining) =>
  Object.keys(needs).filter((s) => Number.isFinite(needs[s]) && remaining[s] > 0);

// Total still-short amount across finite needs (a coarse progress metric for the
// feasibility pass, only ever compared against itself to confirm forward progress).
const unmetDeficit = (needs, remaining) =>
  unmetStats(needs, remaining).reduce((t, s) => t + remaining[s], 0);

// Public entry: greedy solve + a LEAVE-ONE-OUT improvement pass (SPEC §7.2). Greedy is
// non-monotonic, it can route a need through a needlessly expensive base swap (e.g.
// re-baselining a high-+ ring instead of an interchangeable low-+ one), so a LOOSER
// request sometimes yields a strictly cheaper bundle. The pass repairs that: for each
// base swap in the current best (priciest first), re-solve with that slot's base swap
// forbidden; adopt any bundle that still meets every need and costs less. Provably
// non-worsening (only cheaper feasible bundles are adopted); bounded rounds. Skipped for
// maximize goals (they take every improving move, forbidding one can only lose value).
export function solveThreshold(needs, loadout, ctx, solverOpts = {}) {
  let best = greedySolve(needs, loadout, ctx, solverOpts);
  if (Object.values(needs).some((v) => !Number.isFinite(v))) return best; // maximize

  // FLOOR-EFFICIENCY retry (issue 6/7 monotonicity): the default greedy ranks by cheapest GOLD, so
  // when a floor is the binding constraint it can burn the whole floor budget on cheap-but-floor-hungry
  // moves (a Fast scroll) and strand short, even though the goal WAS reachable using floor-efficient
  // moves (so ADDING the cheap option made the result worse). If a finite need is short AND a floor
  // limited it, re-solve ranking by floor-EFFICIENCY (most goal-progress per unit of floor budget) and
  // adopt it when it reaches further. Feasibility beats gold here (Target-mode gold is unbounded); the
  // cost pass below then still shaves any gold it safely can without dropping below a met goal.
  if (solverOpts.floors && best.floorLimited && !meetsNeeds(needs, best.remaining)) {
    const alt = greedySolve(needs, loadout, ctx, { ...solverOpts, floorFirst: true });
    if (unmetDeficit(needs, alt.remaining) < unmetDeficit(needs, best.remaining)) best = alt;
  }

  // FEASIBILITY pass (runs only when a finite need is unmet): greedy ranks base swaps by
  // cheapest gold-per-needed-unit, so it spends a slot's ONE allowed base swap on the
  // cheapest base, which may be too WEAK to close the need (e.g. a Rusty compass +300 Dest
  // when +500 needs the Shiny +450). The ≤1-base-swap-per-slot cap then makes that
  // unrecoverable, AND forbidding the weak base one-at-a-time just walks greedy onto the
  // NEXT-cheapest (possibly even weaker) base, never up to the strong one. Repair: for each
  // slot whose chosen base swap leaves a need short, FORCE the slot's STRONGEST base for the
  // open needs (forbid every other base target there) and re-solve; adopt if the total unmet
  // deficit drops and no open need worsens. Bounded by rounds × base-swapped slots.
  const init = initStates(loadout, ctx);
  let specExclude = new Set();
  for (let round = 0; round < 6 && !meetsNeeds(needs, best.remaining); round++) {
    const open = unmetStats(needs, best.remaining);
    const swapSlots = [...new Set(best.chosen.filter((m) => m.type === "baseSwap").map((m) => m.slot))];
    let advanced = false;
    for (const slot of swapSlots) {
      // candidate base swaps on this slot (from its initial state) that help an open need
      const cands = (init[slot] ? slotMoves(init[slot], ctx) : [])
        .filter((m) => m.type === "baseSwap" && open.some((s) => (m.statDiff?.[s] || 0) > 0));
      if (cands.length < 2) continue; // nothing stronger to force toward
      const strongest = cands.reduce((a, b) =>
        scoreSubset(b.statDiff, open) > scoreSubset(a.statDiff, open) ? b : a);
      const trial = new Set(specExclude);
      for (const c of cands) if (c.to !== strongest.to) trial.add(`${slot}:baseSwap:${c.to}`);
      if (trial.size === specExclude.size) continue; // strongest already the only option
      const alt = greedySolve(needs, loadout, ctx, { ...solverOpts, exclude: trial });
      if (noNeedWorsened(needs, alt.remaining, best.remaining) &&
          unmetDeficit(needs, alt.remaining) < unmetDeficit(needs, best.remaining)) {
        best = alt; specExclude = trial; advanced = true; break;
      }
    }
    if (!advanced) break;
  }

  // COST-improvement (leave-one-out) pass, seeded with the feasibility excludes so the
  // forced-stronger bases stick. Adopts a cheaper bundle only if it still meets every need.
  const exclude = new Set(specExclude);
  for (let round = 0; round < 4; round++) {
    const baseSwaps = best.chosen.filter((m) => m.type === "baseSwap")
      .sort((a, b) => b.goldCost - a.goldCost);
    let improved = false;
    for (const m of baseSwaps) {
      const key = `${m.slot}:baseSwap`;
      if (exclude.has(key)) continue;
      const trial = new Set([...exclude, key]);
      const alt = greedySolve(needs, loadout, ctx, { ...solverOpts, exclude: trial });
      if (meetsNeeds(needs, alt.remaining) && bundleGold(alt.chosen) < bundleGold(best.chosen)) {
        best = alt; exclude.add(key); improved = true; break;
      }
    }
    if (!improved) break;
  }
  return best;
}

// Budget knapsack (SPEC §7.1): maximize total ranking POINTS under a gold budget, with
// NO stat goal. Repeatedly take the available move with the best gold-per-point that still
// fits the remaining budget, RE-BASELINE its slot, and repeat, so a slot can chain (swap a
// base, then enchant/enhance it). Only genuine point gains are eligible (a net-loss move can
// never help maximize points, so the lossy toggle is a no-op here, exactly like the points
// Upgrades view). Caps ≤1 base swap per slot (re-buying a base is pure waste). The bundle is
// consolidated like the threshold solver. Returns { chosen, gained, spent, budgetLimited }.
export function solveBudget(budget, loadout, ctx) {
  const initial = initStates(loadout, ctx);
  const states = { ...initial };
  const chosen = [];
  const baseSwapped = new Set();
  let spent = 0, budgetLimited = false;
  const CAP = 500;
  const mc = makeMoveCache(states, ctx); // live set-bonus comp/rings tracked inside (§13.2)
  while (chosen.length < CAP) {
    let best = null, blocked = false;
    for (const slot in states) {
      for (const m of mc.movesFor(slot)) {
        if (m.pointGain <= 0) continue;                                   // points goal → gains only
        if (m.type === "baseSwap" && baseSwapped.has(m.slot)) continue;   // ≤1 base swap per slot
        if (m.goldCost > budget - spent) { blocked = true; continue; }    // wouldn't fit budget
        if (!best || m.goldPerPoint < best.goldPerPoint) best = m;
      }
    }
    if (!best) { budgetLimited = blocked; break; }
    chosen.push(best);
    spent += best.goldCost;
    if (best.type === "baseSwap") baseSwapped.add(best.slot);
    states[best.slot] = applyMove(states[best.slot], best);
    mc.picked(best.slot);
  }
  const finalChosen = consolidateBundle(chosen, initial, ctx);
  const gained = {};
  for (const m of finalChosen) for (const s in (m.statDiff || {})) gained[s] = (gained[s] || 0) + m.statDiff[s];
  return { chosen: finalChosen, gained, spent: bundleGold(finalChosen), budgetLimited };
}

// Rebuild each slot's chosen picks in canonical order (base swap → enchant → enhance)
// so the bundle reflects the CHEAPEST path to that slot's final config, not the order
// greedy happened to pick. Eliminates two wastes greedy can introduce:
//   • enchant/enhance bought, THEN the item base-swapped, the swap restored the
//     upgraded affix and re-paid it (double-pay); canonical restores the ORIGINAL
//     affix on the swap and applies the upgrade afterward with credit-back.
//   • a marginal scroll later overwritten by a better one on the same affix, only
//     the final scroll survives, so the intermediate purchase is dropped.
// Each slot is replayed from its pristine initial state, regenerating every move from
// the evolving state (so credit-back applies). Falls back to the original picks for a
// slot if the canonical rebuild can't reproduce the target config (shouldn't happen).
function consolidateBundle(chosen, initial, ctx) {
  const bySlot = {}, order = [];
  for (const m of chosen) {
    if (!(m.slot in bySlot)) { bySlot[m.slot] = []; order.push(m.slot); }
    bySlot[m.slot].push(m);
  }
  // Running set-bonus composition: seed from the initial loadout and advance it as each
  // slot reaches its final base, so a slot's tierStep set-bonus delta (recomputed here)
  // sees the systems of already-rebuilt slots and telescopes to the bundle's true total
  // (SPEC §13.2). Slots are processed base-first per slot, one tier jump each.
  const runningComp = compositionOf(initial);
  const runningRings = ringsOf(initial); // ring pair advances as ring slots are rebuilt (§13.1)
  const out = [];
  for (const slot of order) {
    let fin = initial[slot];
    for (const m of bySlot[slot]) fin = applyMove(fin, m); // the slot's final config
    const lctx = { ...ctx, composition: { ...runningComp }, rings: { ...runningRings } };
    out.push(...(canonicalSlotMoves(initial[slot], fin, lctx) ?? bySlot[slot]));
    const finSys = fin.base ? itemSystem(fin.base.name) : null;
    if (TIER_SLOT_IDS.includes(slot) && finSys) runningComp[slot] = finSys;
    if (RING_SLOT_IDS.includes(slot)) runningRings[slot] = fin.base ? { name: fin.base.name, level: fin.base.level } : undefined;
  }
  return out;
}

// Minimal canonical move sequence to take ONE slot from `init` to `fin`: reach the
// target base first (one accessory base swap, OR a tier climb for weapon/armor), then
// an enchant per affix that still differs, then enhance steps up to the target level.
// Doing the BASE change first is what avoids double-pay: a wipe tier jump (or a base
// swap) restores the ORIGINAL affixes cheaply, and the affix UPGRADES land afterward on
// the final base with credit-back. Returns null if a needed move isn't generatable from
// the evolving state (caller falls back to the raw picks).
function canonicalSlotMoves(init, fin, ctx) {
  let state = init;
  const out = [];
  const pick = (pred) => slotMoves(state, ctx).find(pred);
  // 1. reach fin.base. The final base can differ from init by an accessory/special base swap or
  //    a cumulative tier climb (which now spans the Orna +N levels too, since each is an ordinary
  //    link in the chain). Advance one move at a time until the base matches: prefer a direct
  //    one-move jump straight to fin.base, else advance one tier toward it. Bailing to raw picks
  //    (return null) if we can't reach it keeps the intermediate-enchant waste this rebuild exists
  //    to eliminate (SPEC §17 raid-import ordering fix).
  if (fin.base && fin.base.name !== init.base?.name) {
    let guard = 0;
    while (state.base?.name !== fin.base.name && guard++ < 30) {
      const m = pick((x) => (x.type === "baseSwap" || x.type === "tierStep") && x.to === fin.base.name)
        || pick((x) => x.type === "tierStep");
      if (!m) return null;
      out.push(m); state = applyMove(state, m);
    }
    if (state.base?.name !== fin.base.name) return null;
  }
  // 2. enchant each affix whose target scroll differs from the current state (after a
  //    swap, the restored ORIGINAL is current → upgrading it here is credited back)
  for (const affix of AFFIXES) {
    const want = fin[affix]?.scroll;
    if (want && state[affix]?.scroll !== want) {
      const m = pick((x) => x.type === "enchantSwap" && x.affix === affix && x.to === want);
      if (!m) return null;
      out.push(m); state = applyMove(state, m);
    }
  }
  // 3. enhance steps from the current level up to the target
  let guard = 0;
  while (fin.enhance && state.enhance && state.enhance.level < fin.enhance.level && guard++ < 25) {
    const m = pick((x) => x.type === "enhanceStep");
    if (!m) break;
    out.push(m); state = applyMove(state, m);
  }
  // 4. tuning: drive each stat fin has tuned above the current state up to its cap, in
  //    unlock order (the available moves are unlock-gated, so base stats resolve first
  //    and a Surplus capstone only after its prerequisites are maxed). Only pick a move
  //    whose every maxed stat is one fin wants at that cap, so we never over-tune.
  if (fin.tuning) {
    const wants = (st) => (fin.tuning[st] || 0) > (state.tuning?.[st] || 0);
    let tg = 0;
    while (Object.keys(fin.tuning).some(wants) && tg++ < 20) {
      // Among eligible tune moves (every maxed stat is one fin wants at that cap), prefer
      // a Destruction CAPSTONE. Lowest tier first. So the base-stat prerequisites fold
      // into the Dest I row, but Dest I and Dest II stay as SEPARATE lines (each its own
      // expensive decision). After Dest I is applied, the regenerated Dest II capstone
      // covers only Surplus II. A pure base tune is chosen only when no capstone is wanted.
      const cands = slotMoves(state, ctx).filter((x) => x.type === "tuneStep" &&
        x.apply.maxes.some((mx) => wants(mx.stat)) &&
        x.apply.maxes.every((mx) => (fin.tuning[mx.stat] || 0) >= mx.amount));
      if (!cands.length) break;
      const caps = cands.filter((c) => c.capstone >= 1);
      const m = caps.length
        ? caps.reduce((a, b) => (b.capstone < a.capstone ? b : a))                  // Dest I before Dest II
        : cands.reduce((a, b) => (b.apply.maxes.length > a.apply.maxes.length ? b : a)); // base-only
      out.push(m); state = applyMove(state, m);
    }
  }

  // Re-attribute credit-backs so each row reads truthfully. A wipe tier jump / base
  // swap PRE-PAYS re-enchanting ALL current affixes (it can't know which the bundle
  // will replace); an affix later replaced here is credited that re-enchant back ON
  // its own enchant row, which then shows a NEGATIVE "profit" cost (confusing). Move
  // the credit back onto the base/tier row: the enchant row pays the scroll's true
  // price, and the base/tier row charges only the re-enchant of the affixes it KEEPS.
  // Total is unchanged (a pure transfer between two rows on the same slot).
  const baseMove = out.find((m) => m.type === "baseSwap" || m.type === "tierStep");
  if (baseMove) {
    let credit = 0;
    for (const m of out) {
      if (m.type === "enchantSwap" && m.credited > 0) {
        m.goldCost += m.credited; credit += m.credited; m.credited = 0;
        m.goldPerPoint = m.pointGain > 0 ? m.goldCost / m.pointGain : Infinity;
      }
    }
    if (credit > 0) {
      baseMove.goldCost -= credit;
      baseMove.goldPerPoint = baseMove.pointGain > 0 ? baseMove.goldCost / baseMove.pointGain : Infinity;
    }
  }
  return out;
}

// A positive-gain move that DESTROYS the slot's current enchants, so enchanting/
// enhancing the slot now risks being wasted (the §7.3 rebase warning). Two cases:
//   • baseSwap (accessory/special): a fresh base is always bare (no extraction rune).
//   • tierStep across a system jump (wipe) WHERE the affixes aren't carried by an
//     extraction rune (wipePreserved). An in-line tier climb keeps enchants → silent,
//     and a rune-preserved jump means enchanting now isn't wasted → also silent.
function wipesEnchants(m) {
  return m.pointGain > 0 &&
    (m.type === "baseSwap" || (m.type === "tierStep" && m.wipe && !m.wipePreserved));
}

// Slots that have a positive-gain move which would wipe their enchants, the UI flags
// enchant/enhance moves on these ("a better base exists, upgrading this item may be
// wasted if you swap it later", SPEC §7.3 rebase warning).
export function slotsWithBaseSwap(loadout, ctx) {
  const initial = initStates(loadout, ctx);
  const lctx = { ...ctx, composition: compositionOf(initial), rings: ringsOf(initial) };
  const set = new Set();
  for (const slot in initial)
    if (slotMoves(initial[slot], lctx).some(wipesEnchants))
      set.add(slot);
  return set;
}

// Per slot, the wiping upgrade to NAME in the rebase/better hint (or absent). For an
// accessory/special slot that's the strictly-better base with the HIGHEST point gain.
// For a tier slot it's the FIRST tier across the wipe (fewest steps). The actionable
// "you're about to jump systems" target, not the distant chain end. Powers the UI
// "better: <name>" hint on a base-swap row that isn't the strongest option (SPEC §7.3).
export function bestBaseSwapBySlot(loadout, ctx) {
  const initial = initStates(loadout, ctx);
  const lctx = { ...ctx, composition: compositionOf(initial), rings: ringsOf(initial) };
  const out = {};
  for (const slot in initial) {
    let bestBase = null, firstWipeTier = null;
    for (const m of slotMoves(initial[slot], lctx)) {
      if (m.type === "baseSwap" && m.pointGain > 0 && (!bestBase || m.pointGain > bestBase.pointGain))
        bestBase = m;
      else if (m.type === "tierStep" && m.wipe && !m.wipePreserved && m.pointGain > 0 &&
               (!firstWipeTier || m.steps < firstWipeTier.steps))
        firstWipeTier = m;
    }
    const pick = bestBase || firstWipeTier;
    if (pick) out[slot] = { to: pick.to, pointGain: pick.pointGain };
  }
  return out;
}

// Per (slot, affix, tag, family), the highest-point enchant scroll available from the
// slot's INITIAL state, i.e. the TERMINAL of each upgrade chain. Keyed
// `"<slot>|<affix>|<tag>|<family>"`. Powers the UI "better: <scroll>" hint, which is
// chain-scoped (SPEC §7.3/§12): a scroll is only "outclassed" by the strongest member
// of its OWN family, so a scroll at its chain end shows no hint, and a different-effect
// scroll is never called "better". Standalone scrolls (no family) are never bucketed:
// they have no chain, so they never carry a "better" hint.
export function bestEnchantBySlotAffix(loadout, ctx) {
  const initial = initStates(loadout, ctx);
  const out = {};
  for (const slot in initial)
    for (const m of slotMoves(initial[slot], ctx))
      if (m.type === "enchantSwap" && m.pointGain > 0 && m.family) {
        const k = `${slot}|${m.affix}|${m.tag}|${m.family}`;
        if (!out[k] || m.pointGain > out[k].pointGain) out[k] = { to: m.to, pointGain: m.pointGain };
      }
  return out;
}
