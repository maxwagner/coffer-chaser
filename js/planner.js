// Planner (SPEC §17): pure logic for user-built upgrade paths, step schema,
// serialize/import, reconciliation against a live loadout, materials aggregation,
// and the affordability projection. No DOM; index.html owns all rendering.
//
// A PATH is `{ v: 1, steps: [Step] }`. A STEP is the fixed IDENTITY of one action
// (what to do); its cost/materials are never stored, `reconcilePath` recomputes them
// live from current prices and the state simulated after the prior steps, so a path
// exported months ago (or built for a different character) stays priceable.
//
// Step shapes (every step: { id, kind }):
//   kind:"note"  { text }, free-text ("farm X until drop")
//   kind:"goal"  { goalId }, a PREP_GOALS checklist goal
//   kind:"move"  { slot, type, ...identity, onItem? }, one ATOMIC move:
//     enchantSwap  { affix, scroll }, put `scroll` on `slot`'s affix
//     baseSwap     { item, toLevel? }, equip `item` (re-enhance to toLevel)
//     tierStep     { item }, advance ONE hop to tier output `item`
//     gearEnhance  { item, toLevel }. Orna +N variant `item` (one level)
//     enhanceStep  { toLevel }, accessory enhance to +toLevel (one level)
//     tuneStep     { stat, capstone, maxes:[{stat,amount}], partial? }, partial:true =
//                  a tick-limited tune to `maxes[0].amount` (below the cap), priced by
//                  tunePartialMove instead of the to-cap live move (SPEC §17.7)
//   `onItem` (optional, enchant/enhance/tune): the base the step was authored against:
//   used by gapProposal to say "this step expects <onItem>" when the importer's gear differs.
//   `comment` (optional, ANY kind): a free-text annotation the user attaches to the step
//   ("wait for a sale", "farm the mats first"); display-only, rides in the path + export (§17.8).

import { initStates, slotMoves, applyMove, compositionOf, ringsOf, tunePartialMove } from "./solver.js";
import { score } from "./score.js";
import { tuneStatCanon, ENHANCEABLE_SLOT_IDS, TIER_SLOT_IDS, ENHANCE_TARGET_LEVEL } from "./config.js";
import { tuningKey, itemSystem } from "./utils.js";

export const PATH_VERSION = 1;
export const EXPORT_APP = "coffer-chaser";
export const EXPORT_KIND = "planner-path";

// Relocated pure helpers (formerly inline in index.html)
// All take the moveCtx-style `ctx` first: { recipes, cost, craftCost, priceOf, enchants, tierChain }.

// The ordered list of tier outputs from `from` up to `to` (e.g. Beginner Uaithne →
// [Fine Uaithne, …, Superior Eriu]) by walking the tier chain. [] if it doesn't connect.
export const tierPath = (tierChain, from, to) => {
  const out = []; let node = from, guard = 0;
  while (node !== to && guard++ < 40) {
    const up = tierChain.get(node);
    if (!up) return [];           // chain broke before reaching the target
    out.push(up.name); node = up.name;
  }
  return node === to ? out : [];
};

// Is `name` something you'd CRAFT rather than buy (recipe exists, not free, craft ≤ market)?
// The single shared test, expandBOM's recursion, the Planner panel's expandability, the
// affordability walk, and consume-on-complete all agree on when a shortfall means crafting.
export const isCraftedMat = (ctx, n) => ctx.cost(n) !== 0 && !!ctx.recipes[n]
  && ctx.craftCost(n) != null && ctx.craftCost(n) <= (ctx.priceOf(n) ?? Infinity);

// Fully-expanded "shopping list" for crafting `toName` while OWNING `fromName`: recurse
// each crafted sub-item down to the leaves you actually buy/farm, summing quantities,
// and stop at `fromName` (owned → free, not bought). Mirrors the coster's craft-vs-buy
// choice (an item is expanded only when crafting it is the cheaper path and it isn't free).
// Grand total = craftCost(to) − ownCredit = the materials portion of the move's gold.
export const expandBOM = (ctx, toName, fromName) => {
  const { recipes } = ctx;
  const buys = {}; let fee = 0;
  const isCrafted = (n) => isCraftedMat(ctx, n);
  const visit = (name, mult, depth) => {
    if (name === fromName || depth > 40) return;          // owned base (or runaway) → stop
    if (name !== toName && !isCrafted(name)) { buys[name] = (buys[name] || 0) + mult; return; }
    const r = recipes[name];
    if (!r) { buys[name] = (buys[name] || 0) + mult; return; }
    fee += (r.fee || 0) * mult;
    for (const { material, qty } of r.materials) visit(material, mult * qty, depth + 1);
  };
  visit(toName, 1, 0);
  return { buys, fee };
};

// Fold one material into a buys map, expanding a crafted mat to the leaves you buy.
export const addLeafBuys = (ctx, buys, material, qty) => {
  if (ctx.recipes[material])
    for (const [n, q] of Object.entries(expandBOM(ctx, material, null).buys)) buys[n] = (buys[n] || 0) + q * qty;
  else buys[material] = (buys[material] || 0) + qty;
};

// Decompose a move's gold into the leaf items you actually buy (drives the trend feed
// and the Planner's per-step materials). null when nothing bought drives the cost
// (accessory enhanceStep. See stepMaterials. Or an unpriced move).
export const moveBuys = (ctx, m) => {
  if (m.type === "tierStep" || m.type === "baseSwap") {
    if (!m.to) return null;
    const buys = { ...expandBOM(ctx, m.to, m.from).buys };
    // A jump tierStep's gold also spans the enhancement EV (per-attempt qty × expected
    // tries) and the tuning prerequisite, weigh their materials too; on an Orna jump
    // they often dominate the move's gold, so a craft-only trend would mislead.
    for (const s of m.enhanceSteps || [])
      for (const [n, q] of Object.entries(s.materials)) addLeafBuys(ctx, buys, n, q * s.tries);
    for (const b of m.tunePrereqBreakdown || [])
      for (const { material, qty } of b.materials) addLeafBuys(ctx, buys, material, qty);
    return buys;
  }
  if (m.type === "enchantSwap") {
    const scroll = ctx.enchants[m.to]?.scroll;
    return scroll ? { [scroll]: 1 } : null;
  }
  if (m.type === "tuneStep" && m.breakdown) {
    const buys = {};
    for (const b of m.breakdown) for (const { material, qty } of b.materials)
      addLeafBuys(ctx, buys, material, qty); // crafted tuning mat → the leaves you buy
    return buys;
  }
  if (m.type === "gearEnhance" && m.enhanceSteps) {
    const buys = {};
    for (const s of m.enhanceSteps) for (const [n, q] of Object.entries(s.materials))
      addLeafBuys(ctx, buys, n, q * s.tries); // expected enhancement materials
    return buys;
  }
  return null;
};

// FIRST-LEVEL pile for the Planner materials panel: the same move shapes as moveBuys but
// WITHOUT recursing into crafted materials, an Advancement Stone stays "1 × Advancement
// Stone" (the panel expands its recipe inline on demand, like the Upgrades move detail),
// instead of being pre-flattened to its base leaves. The trend feed keeps leaf moveBuys.
export const moveBuysShallow = (ctx, m) => {
  const add = (buys, n, q) => { buys[n] = (buys[n] || 0) + q; };
  if (m.type === "tierStep" || m.type === "baseSwap") {
    if (!m.to) return null;
    const buys = {};
    const r = ctx.recipes[m.to];
    if (!r) add(buys, m.to, 1); // no recipe → you buy the item itself
    else for (const { material, qty } of r.materials)
      if (material !== m.from) add(buys, material, qty); // owned base → not gathered
    for (const s of m.enhanceSteps || [])
      for (const [n, q] of Object.entries(s.materials)) add(buys, n, q * s.tries);
    for (const b of m.tunePrereqBreakdown || [])
      for (const { material, qty } of b.materials) add(buys, material, qty);
    return buys;
  }
  if (m.type === "enchantSwap") {
    const scroll = ctx.enchants[m.to]?.scroll;
    return scroll ? { [scroll]: 1 } : null;
  }
  if (m.type === "tuneStep" && m.breakdown) {
    const buys = {};
    for (const b of m.breakdown) for (const { material, qty } of b.materials) add(buys, material, qty);
    return buys;
  }
  if (m.type === "gearEnhance" && m.enhanceSteps) {
    const buys = {};
    for (const s of m.enhanceSteps) for (const [n, q] of Object.entries(s.materials)) add(buys, n, q * s.tries);
    return buys;
  }
  return null;
};

// Draw `qty` of `name` from `stock` (MUTATED), returning the gold that covers the
// shortfall. A crafted shortfall recurses into its recipe, owned sub-materials get
// consumed instead of bought, so the shallow piles still credit leaf stock the way
// the old fully-flattened piles did (netCost semantics, SPEC §5.2). Quantities can be
// fractional (EV piles); callers round where the UI needs whole items.
export function drawMaterial(ctx, stock, name, qty, depth = 0) {
  const have = stock[name] || 0, take = Math.min(have, qty);
  if (take > 0) stock[name] = have - take;
  const short = qty - take;
  if (short <= 0) return 0;
  if (depth > 40 || !isCraftedMat(ctx, name)) return (ctx.cost(name) ?? 0) * short;
  const r = ctx.recipes[name];
  let gold = (r.fee || 0) * short;
  for (const { material, qty: q } of r.materials) gold += drawMaterial(ctx, stock, material, q * short, depth + 1);
  return gold;
}

// Step constructors / identity
let _idSeq = 0;
export const newStepId = () =>
  `s_${Date.now().toString(36)}_${(_idSeq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export const emptyPath = () => ({ v: PATH_VERSION, steps: [] });
export const newNoteStep = (text) => ({ id: newStepId(), kind: "note", text: String(text ?? "") });
export const newGoalStep = (goalId) => ({ id: newStepId(), kind: "goal", goalId });
// A +N infusion on `slot` (SPEC §14/§17): a REAL zero-gold move step (the free stone folds a
// stat line like the Checklist's +1), distinct from the old note-only infusion suggestion.
export const newInfuseStep = (slot, stat, amount) => ({ id: newStepId(), kind: "move", slot, type: "infuse", stat, amount });
// Display labels for the infusion stats a step may carry (kept local so planner.js need not
// import the Checklist's infusion module). Falls back to the raw key for anything unlisted.
export const INFUSE_STAT_LABEL = { bal: "Bal", crit: "Crit", critRes: "Crit Res", attSpd: "Att Spd", def: "Def" };

// Stable de-dupe identity (mirrors utils.moveKey for move steps). The random `id` is
// for DOM/drag bookkeeping only; two steps naming the same action share a stepKey.
export function stepKey(step) {
  if (step.kind === "note") return `note:${step.id}`;
  if (step.kind === "goal") return `goal:${step.goalId}`;
  const target = step.type === "enchantSwap" ? step.scroll
    // Tune keys include the target amounts so PARTIAL chunks of the same stat coexist as
    // separate steps ("10 ticks now, 10 more later", SPEC §17.7). Two identical to-cap
    // adds still collide (same amounts), which is the de-dupe's actual job.
    : step.type === "tuneStep" ? `${step.stat}@${(step.maxes || []).map((m) => m.amount).join(",")}`
    : step.type === "enhanceStep" ? step.toLevel
    : step.type === "infuse" ? `${step.stat}${step.amount}`
    : step.item;
  return `${step.type}:${step.slot}:${step.affix || "base"}:${target ?? ""}`;
}

// List transforms (all return a NEW path; steps are shared, order arrays fresh)
export const insertSteps = (path, index, steps) => {
  const i = Math.max(0, Math.min(index, path.steps.length));
  return { ...path, steps: [...path.steps.slice(0, i), ...steps, ...path.steps.slice(i)] };
};
export const removeStep = (path, id) =>
  ({ ...path, steps: path.steps.filter((s) => s.id !== id) });
export const moveStep = (path, id, toIndex) => {
  const from = path.steps.findIndex((s) => s.id === id);
  if (from < 0) return path;
  const steps = path.steps.slice();
  const [s] = steps.splice(from, 1);
  steps.splice(Math.max(0, Math.min(toIndex, steps.length)), 0, s);
  return { ...path, steps };
};

// Serialize / import
// Field whitelist per step kind, parse strips anything else so a hand-edited or
// future-versioned file can't smuggle junk into the store.
const MOVE_FIELDS = {
  enchantSwap: ["affix", "scroll", "onItem"],
  baseSwap: ["item", "toLevel"],
  tierStep: ["item"],
  gearEnhance: ["item", "toLevel"],
  enhanceStep: ["toLevel", "onItem"],
  tuneStep: ["stat", "capstone", "maxes", "partial", "onItem"],
  infuse: ["stat", "amount", "onItem"],
};

export const serializePath = (path) =>
  JSON.stringify({ app: EXPORT_APP, kind: EXPORT_KIND, v: PATH_VERSION, steps: path.steps }, null, 2);

// parsePath(text) → { path, error }, never throws. Accepts the export envelope or a
// bare `{v, steps}` store shape; validates kinds + required fields, strips unknown
// fields, and re-ids every step (import must never collide with existing ids).
export function parsePath(text) {
  let raw;
  try { raw = typeof text === "string" ? JSON.parse(text) : text; }
  catch { return { path: null, error: "Not valid JSON." }; }
  if (!raw || typeof raw !== "object") return { path: null, error: "Not a planner path." };
  if (raw.kind != null && raw.kind !== EXPORT_KIND) return { path: null, error: "Not a planner path export." };
  if ((raw.v ?? 1) > PATH_VERSION) return { path: null, error: `Made by a newer version (v${raw.v}). Update the app.` };
  if (!Array.isArray(raw.steps)) return { path: null, error: "No steps found." };
  const steps = [];
  for (const [i, s] of raw.steps.entries()) {
    const bad = (why) => ({ path: null, error: `Step ${i + 1}: ${why}` });
    if (!s || typeof s !== "object") return bad("not an object.");
    // An optional free-text `comment` can ride on ANY step (SPEC §17.8). Carried through
    // import/export verbatim (serializePath dumps the step as-is; here we preserve it).
    // `comment` (any kind, SPEC §17.8) and `free` (any kind, SPEC §17.9, the user got this
    // upgrade for nothing, so its gold + materials read as 0) ride through import verbatim.
    const withComment = (step) => {
      if (typeof s.comment === "string" && s.comment.trim()) step.comment = s.comment;
      if (s.free === true) step.free = true;
      return step;
    };
    if (s.kind === "note") {
      if (typeof s.text !== "string") return bad("note without text.");
      steps.push(withComment({ id: newStepId(), kind: "note", text: s.text }));
    } else if (s.kind === "goal") {
      if (typeof s.goalId !== "string" || !s.goalId) return bad("goal without a goal id.");
      steps.push(withComment({ id: newStepId(), kind: "goal", goalId: s.goalId }));
    } else if (s.kind === "move") {
      const fields = MOVE_FIELDS[s.type];
      if (!fields) return bad(`unknown move type "${s.type}".`);
      if (typeof s.slot !== "string" || !s.slot) return bad("move without a slot.");
      const step = { id: newStepId(), kind: "move", slot: s.slot, type: s.type };
      for (const f of fields) if (s[f] !== undefined) step[f] = s[f];
      if (s.type === "enchantSwap" && (!step.scroll || !step.affix)) return bad("enchant without scroll/affix.");
      if ((s.type === "baseSwap" || s.type === "tierStep" || s.type === "gearEnhance") && !step.item) return bad(`${s.type} without an item.`);
      if (s.type === "enhanceStep" && typeof step.toLevel !== "number") return bad("enhance without a level.");
      if (s.type === "gearEnhance" && typeof step.toLevel !== "number") return bad("gearEnhance without a level.");
      if (s.type === "tuneStep" && !Array.isArray(step.maxes)) return bad("tune without maxes.");
      if (s.type === "infuse" && (!step.stat || typeof step.amount !== "number")) return bad("infuse without a stat/amount.");
      steps.push(withComment(step));
    } else return bad(`unknown kind "${s.kind}".`);
  }
  return { path: { v: PATH_VERSION, steps }, error: null };
}

// Plain-language step labels (shared by the TSV export and the step cards)
// `slotLabel` maps a slot id to its display name ("ring1" → "Ring 1"); defaults to the id.
export function stepLabel(step, slotLabel = (s) => s) {
  if (step.kind === "note") return step.text;
  if (step.kind === "goal") return `Complete the goal: ${step.goalId}`;
  const at = slotLabel(step.slot);
  switch (step.type) {
    case "enchantSwap": return `Add a ${step.scroll} to your ${at}'s ${step.affix === "prefix" ? "Prefix" : "Suffix"} slot`;
    case "baseSwap": return `Equip a ${step.item} in your ${at} slot${step.toLevel ? ` and enhance it to +${step.toLevel}` : ""}`;
    case "tierStep": return `Advance your ${at} to ${step.item}`;
    case "gearEnhance": return `Enhance your ${at} to ${step.item}`;
    case "enhanceStep": return `Enhance your ${at} to +${step.toLevel}`;
    case "tuneStep": return step.partial && step.maxes?.length === 1
      ? `Tune your ${at}'s ${step.stat} to ${step.maxes[0].amount}`
      : `Tune your ${at}'s ${step.stat} to its cap`;
    case "infuse": return `Infuse your ${at} with +${step.amount} ${INFUSE_STAT_LABEL[step.stat] || step.stat}`;
    default: return `${step.type} (${at})`;
  }
}

// Read-only shareable text of a reconciled path (one row per step).
export function pathToTSV(entries, slotLabel = (s) => s) {
  const rows = [["#", "Step", "Status", "Gold", "Materials"].join("\t")];
  entries.forEach((e, i) => {
    const mats = e.materials
      ? Object.entries(e.materials).map(([n, q]) => `${n} ×${Math.ceil(q)}`).join(", ")
      : "";
    rows.push([i + 1, stepLabel(e.step, slotLabel), e.status,
      e.gold != null ? Math.round(e.gold) : "", mats].join("\t"));
  });
  return rows.join("\n");
}

// Move → steps decomposition (the single entry-point normalizer)
// Every "Add to plan" source funnels through this: a display-merged row explodes to its
// underlying steps, a CUMULATIVE tierStep explodes to one step per hop, and a tierStep
// that bundles an Orna +N→+15 enhance prerequisite emits those levels as their own
// gearEnhance steps first (decision: every prereq is its own visible step). `baseName`
// (optional) stamps `onItem` on enchant/enhance/tune steps so an importer with different
// gear gets a useful gap prompt.
const plusLevel = (name) => { const m = /^\+?(\d+)/.exec(name || ""); return m ? +m[1] : null; };
const bumpPlus = (name, lvl) => name.replace(/^\+?\d+/, `+${lvl}`);

export function moveToSteps(move, ctx, baseName = null) {
  if (move.merged && Array.isArray(move.steps))
    return move.steps.flatMap((m) => moveToSteps(m, ctx, baseName));
  const mkStep = (type, props) => ({ id: newStepId(), kind: "move", slot: move.slot, type, ...props });
  const onItem = baseName ? { onItem: baseName } : {};
  switch (move.type) {
    case "tierStep": {
      const out = [];
      // Orna enhance prerequisite bundled into the jump → per-level gearEnhance steps.
      if (move.enhanceSteps?.length && move.enhanceFrom != null && plusLevel(move.from) != null) {
        for (const s of move.enhanceSteps)
          out.push(mkStep("gearEnhance", { item: bumpPlus(move.from, s.to), toLevel: s.to }));
      }
      const hops = tierPath(ctx.tierChain, move.from, move.to);
      if (hops.length) for (const h of hops) out.push(mkStep("tierStep", { item: h }));
      else out.push(mkStep("tierStep", { item: move.to })); // chain unresolvable → keep the intent
      return out;
    }
    case "gearEnhance":
      return [mkStep("gearEnhance", { item: move.to, toLevel: move.toLevel })];
    case "enhanceStep":
      return [mkStep("enhanceStep", { toLevel: move.apply.level, ...onItem })];
    case "enchantSwap":
      return [mkStep("enchantSwap", { affix: move.affix, scroll: move.to, ...onItem })];
    case "baseSwap":
      return [mkStep("baseSwap", { item: move.to, ...(move.toLevel != null ? { toLevel: move.toLevel } : {}) })];
    case "tuneStep":
      return [mkStep("tuneStep", { stat: move.stat, capstone: move.capstone || 0, maxes: move.apply.maxes, ...onItem })];
    default:
      return [];
  }
}

// In-Planner upgrade builder (SPEC §17.7)
// Candidate upgrade moves for ONE slot, generated live from the loadout (composition/
// rings aware, exactly like the app-wide move list) and bucketed by "part" so the
// Planner's Add-upgrade chooser can cascade slot → part → change. `base` covers tier/
// base swaps AND enhancement (gear Orna +N, accessory +N); `prefix`/`suffix` are the two
// enchant affixes; `tuning` is the base-stat/capstone tune moves. Infusion is NOT a
// costed move (SPEC §14), so the UI offers it as a note, it never appears here. Returns
// { base:[move…], prefix:[…], suffix:[…], tuning:[…], applicable:{base,prefix,suffix,tuning} }
// (empty arrays for parts with no available change), or null for an unknown/absent slot.
// `applicable` marks which parts the slot STRUCTURALLY supports even when no upgrade exists
// right now (e.g. a maxed-out suffix). The UI lists every applicable part and says "no
// available upgrades" for an empty one, rather than hiding the part. Each move is
// `moveToSteps`-ready.
// `statesOverride` (optional): pre-simulated slot states, pass reconcilePath's `states` so
// the builder offers upgrades FROM THE PLAN'S TAIL (after you plan "+13" it offers "+14"),
// not from the live loadout, which would keep re-offering already-planned steps.
export function slotUpgradeOptions(loadout, slot, ctx, statesOverride = null) {
  const states = statesOverride || initStates(loadout, ctx);
  const state = states[slot];
  if (!state) return null; // unknown/absent slot
  // An EMPTY slot (no base, e.g. an artifact you haven't acquired yet) still has upgrades:
  // slotMoves offers ACQUIRE baseSwaps (SPEC §6) so the planner can build the acquire, and its
  // enchant/tune parts light up on the plan tail once the acquire is queued (statesOverride).
  const lctx = { ...ctx, composition: compositionOf(states), rings: ringsOf(states) };
  const groups = { base: [], prefix: [], suffix: [], tuning: [] };
  for (const m of slotMoves(state, lctx)) {
    const part = m.type === "enchantSwap" ? m.affix
      : m.type === "tuneStep" ? "tuning"
      : "base"; // tierStep / baseSwap / gearEnhance / enhanceStep (incl. empty-slot acquire)
    if (groups[part]) groups[part].push(m);
  }
  const affixApplies = (affix) => Object.values(ctx.enchants || {})
    .some((e) => e.affix === affix && e.appliesTo?.includes(slot));
  groups.applicable = {
    base: true, // every slot has a base to acquire / advance / swap / enhance
    prefix: affixApplies("prefix"),
    suffix: affixApplies("suffix"),
    // Tuning needs a concrete equipped base to key its table; an empty slot has none yet.
    tuning: !!(state.base && ctx.tuning && ctx.tuning[tuningKey(state.base.name)]?.length),
  };
  return groups;
}

// Multi-level enhance targets (SPEC §17.7)
// An enhanceable accessory (ring/belt/earrings) enhances ONE level at a time, so slotMoves
// only ever offers "+N → +N+1", reaching +20 by hand means authoring eight steps. This
// returns a `{ label, steps }` option per reachable target level ABOVE the current one; each
// expands to the FULL run of enhanceStep steps (current+1 … target) in one insert, so the
// planner can add "enhance to +20" as a single action. reconcilePath prices every intermediate
// level live (forward simulation). Empty for a non-enhanceable, maxed (+20), or empty slot.
// `statesOverride`: same plan-tail states as slotUpgradeOptions.
export function enhanceTargetOptions(loadout, slot, ctx, statesOverride = null) {
  if (!ENHANCEABLE_SLOT_IDS.includes(slot)) return [];
  const state = (statesOverride || initStates(loadout, ctx))[slot];
  if (!state?.base || !state.enhance || state.enhance.level == null) return [];
  const level = state.enhance.level;
  if (level >= 20) return [];
  const base = state.base.name;
  const opts = [];
  for (let target = level + 1; target <= 20; target++) {
    const steps = [];
    for (let l = level + 1; l <= target; l++)
      steps.push({ id: newStepId(), kind: "move", slot, type: "enhanceStep", toLevel: l, onItem: base });
    opts.push({ label: `to +${target}${target - level > 1 ? ` (${target - level} levels)` : ""}`, steps });
  }
  return opts;
}

// Multi-level GEAR enhance targets (SPEC §17.7)
// The Orna analogue of enhanceTargetOptions: slotMoves only ever offers the single next
// "+N → +N+1" gearEnhance, so a +12 piece heading for +15 needed three separate adds (and
// the builder, working off the live loadout, never even showed +14/+15). One option per
// reachable target level; each expands to the per-level gearEnhance run. The +level variant
// item must exist in bySlot for every intermediate level (the walk stops at the first gap:
// levels beyond it can't be priced or applied). Empty for non-Orna, non-tier, or maxed gear.
export function gearEnhanceTargetOptions(loadout, slot, ctx, statesOverride = null) {
  if (!TIER_SLOT_IDS.includes(slot)) return [];
  const state = (statesOverride || initStates(loadout, ctx))[slot];
  if (!state?.base || itemSystem(state.base.name) !== "Orna") return [];
  const lvl = plusLevel(state.base.name);
  if (lvl == null || lvl >= ENHANCE_TARGET_LEVEL) return [];
  const opts = [];
  const steps = [];
  for (let target = lvl + 1; target <= ENHANCE_TARGET_LEVEL; target++) {
    const name = bumpPlus(state.base.name, target);
    if (!(ctx.bySlot[slot] || []).some((it) => it.name === name)) break; // variant gap → stop
    steps.push({ id: newStepId(), kind: "move", slot, type: "gearEnhance", item: name, toLevel: target });
    opts.push({
      label: `to +${target}${target - lvl > 1 ? ` (${target - lvl} levels)` : ""}`,
      // Each option owns its steps (fresh ids). Sharing step objects across options would
      // collide ids when two options are ever inserted.
      steps: steps.map((s) => ({ ...s, id: newStepId() })),
    });
  }
  return opts;
}

// Satisfied-or-better (the derived "done" test, SPEC §17)
// A step is done when the slot's state already IS the target, or something strictly
// better: a base further UP the tier chain, a higher enhance level, a higher-scoring
// same-family enchant, tuning at/above the step's amounts, or (accessories, off-chain)
// a base whose scored stats match or beat the target's.
export function satisfiedOrBetter(state, step, ctx) {
  if (step.kind !== "move") return false;
  switch (step.type) {
    case "enchantSwap": {
      const cur = state[step.affix]?.scroll;
      if (!cur) return false;
      if (cur === step.scroll) return true;
      const a = ctx.enchants[cur], b = ctx.enchants[step.scroll];
      return !!(a && b && a.family && a.family === b.family && score(a.stats) >= score(b.stats));
    }
    case "gearEnhance": {
      const cur = state.base?.name;
      if (!cur) return false;
      if (cur === step.item) return true;
      // Same piece at a higher +level satisfies; anything upstream on the chain does too.
      const curLvl = plusLevel(cur), tgtLvl = plusLevel(step.item);
      if (curLvl != null && tgtLvl != null && bumpPlus(cur, 0) === bumpPlus(step.item, 0))
        return curLvl >= tgtLvl;
      return tierPath(ctx.tierChain, step.item, cur).length > 0;
    }
    case "tierStep": case "baseSwap": {
      const cur = state.base?.name;
      if (!cur) return false;
      if (cur === step.item) return true;
      if (tierPath(ctx.tierChain, step.item, cur).length > 0) return true; // current is upstream
      if (step.type === "baseSwap") {
        // Off-chain (accessories): a base scoring ≥ the target counts as "or better".
        const tgt = (ctx.bySlot[step.slot] || []).find((it) => it.name === step.item);
        return !!(tgt && state.base.stats && score(state.base.stats) >= score(tgt.stats));
      }
      return false;
    }
    case "enhanceStep":
      return (state.enhance?.level ?? -1) >= step.toLevel;
    case "tuneStep": {
      const cur = {};
      for (const [k, v] of Object.entries(state.tuning || {})) cur[tuneStatCanon(k)] = v;
      return (step.maxes || []).every(({ stat, amount }) => (cur[tuneStatCanon(stat)] || 0) >= amount);
    }
    default: return false;
  }
}

// Live move lookup, regenerate the slot's candidates and match by identity
export function findLiveMove(state, step, lctx) {
  // Partial tune (SPEC §17.7): a below-cap target has no matching slotMoves row (tuneMoves
  // only ever offers to-cap), so it's priced directly. null (row gone / gate closed) falls
  // through to the loop, which won't match either → the step reads blocked, correctly.
  if (step.type === "tuneStep" && step.partial && step.maxes?.length === 1) {
    const pm = tunePartialMove(state, lctx, step.maxes[0].stat, step.maxes[0].amount);
    if (pm) return pm;
  }
  for (const m of slotMoves(state, lctx)) {
    if (m.type !== step.type || m.slot !== step.slot) continue;
    switch (step.type) {
      case "enchantSwap": if (m.affix === step.affix && m.to === step.scroll) return m; break;
      case "tierStep": case "baseSwap": if (m.to === step.item) return m; break;
      case "gearEnhance": if (m.to === step.item) return m; break;
      case "enhanceStep": if (m.apply.level === step.toLevel) return m; break;
      case "tuneStep": if (m.stat === step.stat) return m; break;
    }
  }
  return null;
}

// Per-step materials (the "what to gather for THIS step" pile)
// FIRST-LEVEL buys via moveBuysShallow (a crafted intermediate stays one row, the panel
// expands it on demand), except: accessory enhanceStep uses its own EV pile (per-attempt
// qty × expected tries, moveBuys deliberately skips it for the trend feed), and a
// non-scroll enchant method (scraps/spam/exquisite) is gold-only (you buy scraps/failures
// at market, not a fixed shopping list). Quantities can be fractional (EV); UI rounds.
export function stepMaterials(ctx, move) {
  if (move.type === "enhanceStep") {
    const materials = {};
    for (const [n, q] of Object.entries(move.materials || {})) materials[n] = q * (move.attempts || 1);
    return { gold: move.goldCost, materials };
  }
  if (move.type === "enchantSwap" && move.method && move.method !== "scroll")
    return { gold: move.goldCost, materials: {} };
  return { gold: move.goldCost, materials: moveBuysShallow(ctx, move) || {} };
}

// Gap proposals for blocked steps
// A blocked step gets a proposed list of INSERT steps that would make it possible from
// the current state, or null when we can't compute one (→ impossible; skip-only).
// `expected` = the base the step needs (from the path's own earlier steps, or onItem).
export function gapProposal(state, step, ctx, expected = null) {
  const mkStep = (type, props) => ({ id: newStepId(), kind: "move", slot: step.slot, type, ...props });
  // Empty slot (no base equipped, an artifact/accessory not yet acquired). A DEPENDENT move
  // (enchant/enhance/tune) needs a base first, so if we can name the intended one, the base the
  // path itself established (`expected`) or the step's authored-against `onItem`, propose
  // ACQUIRING it; the dependent step then reconciles once the acquire is in (forward simulation).
  // A base/tier step IS the acquire (and already failed to price via findLiveMove), so don't
  // re-propose it. Without a known base we can't name one → skip-only.
  if (!state.base) {
    if (step.type === "baseSwap" || step.type === "tierStep") return null;
    const want = expected ?? step.onItem ?? null;
    if (!want) return null;
    return { steps: [mkStep("baseSwap", { item: want })],
      reason: `your ${step.slot} is empty, acquire a ${want} first` };
  }
  if (step.type === "enhanceStep") {
    const cur = state.enhance?.level;
    if (cur == null || cur >= step.toLevel - 1) return null;
    const steps = [];
    for (let l = cur + 1; l < step.toLevel; l++) steps.push(mkStep("enhanceStep", { toLevel: l }));
    return { steps, reason: `your ${step.slot} is +${cur}, the levels in between are missing` };
  }
  if (step.type === "gearEnhance") {
    const curLvl = plusLevel(state.base?.name), tgtLvl = step.toLevel;
    if (curLvl == null || tgtLvl == null || curLvl >= tgtLvl - 1) return null;
    if (bumpPlus(state.base.name, 0) !== bumpPlus(step.item, 0)) return null;
    const steps = [];
    for (let l = curLvl + 1; l < tgtLvl; l++)
      steps.push(mkStep("gearEnhance", { item: bumpPlus(step.item, l), toLevel: l }));
    return { steps, reason: `your ${step.slot} is +${curLvl}, the levels in between are missing` };
  }
  // enchant/tune (and a disconnected tier/base): the step expects a different base.
  const want = expected ?? step.onItem ?? (step.type === "tierStep" || step.type === "baseSwap" ? step.item : null);
  const cur = state.base?.name;
  if (!want || !cur || want === cur) return null;
  const hops = tierPath(ctx.tierChain, cur, want);
  const steps = hops.length ? hops.map((h) => mkStep("tierStep", { item: h }))
    : [mkStep("baseSwap", { item: want })];
  return { steps, reason: `this step expects a ${want} (you have a ${cur})` };
}

// Reconcile: the workhorse, walk the path against the live loadout
// Returns { entries, states } where each entry = { step, status, move?, gold?, goldFull?,
// materials?, warnings, gap?, reason? } and `states` = the slot states AFTER the whole
// path's ready steps (the plan's tail, feed it to slotUpgradeOptions & co. so the add
// chooser builds on what's already planned). Statuses:
//   done, the loadout already satisfies the step (or better)
//   ready, doable right now from the simulated state; carries live move + cost
//   blocked, prerequisite mismatch; carries a `gap` proposal (insert steps / skip)
//   impossible, can't be priced or regenerated for this gear; skip-only
//   info, a note step
// State simulates FORWARD: each ready step's move is applied before judging the next,
// so step N is priced from the world after steps 1…N−1. A blocked step does NOT advance
// its slot (downstream same-slot steps cascade to blocked, intended).
export function reconcilePath(path, loadout, checklistDone, ctx) {
  const states = initStates(loadout, ctx);
  const entries = [];
  const expectedBase = {}; // slot → the base the path itself established (last tier/base/gearEnhance step)
  for (const step of path.steps) {
    if (step.kind === "note") { entries.push({ step, status: "info", warnings: [] }); continue; }
    if (step.kind === "goal") {
      entries.push({ step, status: checklistDone?.has?.(step.goalId) ? "done" : "ready", warnings: [] });
      continue;
    }
    const state = states[step.slot];
    if (!state) { entries.push({ step, status: "impossible", reason: `unknown slot "${step.slot}"`, warnings: [] }); continue; }
    // Infusion (SPEC §14/§17): NOT a solver move, reconcile prices it here. It's free (a +1
    // stone) and folds a single stat line, replacing whatever the slot held. done when the slot
    // already carries ≥ this step's amount of the same stat; otherwise ready with the replace-delta.
    // `state.infusion` (seeded from the loadout by initStates) IS forward-simulated here, an
    // earlier infuse step on this slot updates it, so a later one (or the add chooser reading
    // the plan-tail `states`) sees what the plan itself already queued, not just the live gear.
    if (step.type === "infuse") {
      const prev = state.infusion || null;
      if (prev && prev.stat === step.stat && (prev.amount || 0) >= step.amount) {
        entries.push({ step, status: "done", warnings: [] }); continue;
      }
      const statDiff = {};
      if (prev?.stat && prev.amount) statDiff[prev.stat] = (statDiff[prev.stat] || 0) - prev.amount;
      statDiff[step.stat] = (statDiff[step.stat] || 0) + step.amount;
      for (const k of Object.keys(statDiff)) if (!statDiff[k]) delete statDiff[k];
      const move = { type: "infuse", slot: step.slot, statDiff, pointGain: score(statDiff),
        goldCost: 0, apply: { kind: "infuse", stat: step.stat, amount: step.amount } };
      entries.push({ step, status: "ready", move, free: true, gold: 0, goldFull: 0, materials: {}, warnings: [] });
      states[step.slot] = { ...state, infusion: { stat: step.stat, amount: step.amount } };
      continue;
    }
    const tracksBase = step.type === "tierStep" || step.type === "baseSwap" || step.type === "gearEnhance";
    if (satisfiedOrBetter(state, step, ctx)) {
      if (tracksBase) delete expectedBase[step.slot]; // the real gear is at/past this point
      entries.push({ step, status: "done", warnings: [] });
      continue;
    }
    const lctx = { ...ctx, composition: compositionOf(states), rings: ringsOf(states) };
    const move = findLiveMove(state, step, lctx);
    if (move) {
      const { gold, materials } = stepMaterials(ctx, move);
      // A user-flagged FREE step (SPEC §17.9) costs no gold and needs no materials, you're
      // getting the upgrade for nothing (event box, hand-me-down, already-owned). Its stat gain
      // still counts (statDiff rides on `move`); only the price + shopping pile zero out.
      const free = !!step.free;
      entries.push({
        step, status: "ready", move, free,
        gold: free ? 0 : gold,
        goldFull: free ? 0 : gold + (move.inventoryCredit || 0), // un-netted, for the affordability walk
        materials: free ? {} : materials, warnings: [],
      });
      states[step.slot] = applyMove(state, move);
      if (tracksBase) expectedBase[step.slot] = step.item;
    } else {
      const gap = gapProposal(state, step, ctx, expectedBase[step.slot] ?? null);
      const emptyReason = !state.base
        ? `your ${step.slot} is empty, acquire a base for it first, then this step can apply`
        : "can't be priced or isn't an upgrade from your current gear";
      entries.push({
        step, status: gap ? "blocked" : "impossible", gap: gap || undefined,
        reason: gap ? gap.reason : emptyReason,
        warnings: [],
      });
      if (tracksBase) expectedBase[step.slot] = step.item; // downstream steps still expect it
    }
  }
  // Conflict warnings: work on a slot that a LATER step wipes or replaces may be redone.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.status !== "ready" || e.step.kind !== "move") continue;
    const t = e.step.type;
    if (t !== "enchantSwap" && t !== "tuneStep" && t !== "enhanceStep") continue;
    for (let j = i + 1; j < entries.length; j++) {
      const l = entries[j];
      if (l.step.kind !== "move" || l.step.slot !== e.step.slot || l.status === "done") continue;
      const replaces = l.step.type === "baseSwap"
        || (l.step.type === "tierStep" && (l.move ? l.move.wipe : true));
      if (!replaces) continue;
      // Enchants survive a rune-preserved jump and a baseSwap keeps them costed; tuning
      // (non-Destruction) is lost on any wipe; enhance levels are lost on a base swap.
      const redone = t === "tuneStep" ? true
        : t === "enhanceStep" ? l.step.type === "baseSwap"
        : true; // enchantSwap: re-buy/rune cost either way, worth flagging
      if (redone) {
        e.warnings.push(`step ${j + 1} replaces this ${e.step.slot}, this work may be redone`);
        break;
      }
    }
  }
  return { entries, states };
}

// Smart reorder (SPEC §17.15)
// Dependency-aware reordering of the working path. ONE topological merge underneath every
// mode. Only the tiebreak key changes. So no mode can ever emit a step before the base it
// depends on. The single hard constraint: within a slot, steps form an ordered CHAIN
// (acquire → tier → enhance → enchant/tune/infuse); across slots there's no dependency, so
// value modes freely interleave slots. The leading done-run is pinned (history is never
// reordered); interior done steps stay fixed too (their gear is already live, so a later
// same-slot step is never blocked by list order).
//
// Modes:
//   "deps", key = original position. Minimal reshuffle: only lifts a base/tier above the
//                enchant/enhance/tune that needs it (fixes red "blocked" cards after a drag).
//   "cheapest", ready move steps sorted by reconciled gold ascending.
//   "value", ready move steps sorted by gold ÷ pointGain ascending (best bang first).
//   "smart". Value, but on BOX-ADJUSTED gold (subtract `opts.boxSavings[id]`. The gold a
//                weekly box will cover), so box-cheapened upgrades float up. SPEC §18.
// Value keys use the CURRENT-order reconciled costs (order-dependent netting makes true
// order-optimal a solver problem, out of scope). A good-enough ranking. The UI runs a
// "deps" pass + re-reconcile before a value pass so a currently-blocked step is priced first.
export const REORDER_MODES = ["deps", "cheapest", "value", "smart"];

// Canonical intra-slot precedence: base-establishing steps before the dependents that need
// them, level-ordered where it applies. Ties fall back to original position (stable).
const slotRank = (step) => {
  switch (step.type) {
    case "baseSwap": return 0;      // acquire the item
    case "tierStep": return 1;      // advance tiers
    case "gearEnhance": return 2;   // Orna +N (level-ordered below)
    case "enhanceStep": return 3;   // accessory +N (level-ordered below)
    default: return 5;              // enchantSwap / tuneStep / infuse, need the base
  }
};
const canonChain = (arr, origIndex) => arr.slice().sort((a, b) =>
  slotRank(a) - slotRank(b)
  || ((a.toLevel || 0) - (b.toLevel || 0))
  || (origIndex.get(a.id) - origIndex.get(b.id)));

// Priority merge of pre-canon-ordered chains: repeatedly emit the chain head with the
// smallest key (ties → smallest original index), advancing that chain. Preserves every
// chain's internal order → dependency-safe by construction.
const mergeChains = (chains, keyOf, origIndex) => {
  const ptr = chains.map(() => 0);
  const total = chains.reduce((s, c) => s + c.length, 0);
  const out = [];
  for (let n = 0; n < total; n++) {
    let bi = -1, bk = null, bo = null;
    for (let i = 0; i < chains.length; i++) {
      if (ptr[i] >= chains[i].length) continue;
      const s = chains[i][ptr[i]];
      const k = keyOf(s), o = origIndex.get(s.id);
      if (bi < 0 || k < bk || (k === bk && o < bo)) { bi = i; bk = k; bo = o; }
    }
    out.push(chains[bi][ptr[bi]]); ptr[bi] += 1;
  }
  return out;
};

export function reorderPath(path, entries, mode = "deps", opts = {}) {
  const steps = path.steps;
  const byId = new Map(entries.map((e) => [e.step.id, e]));
  // Completed steps float to the TOP, they're history, and reconcile never applies a done
  // step's move, so moving one can't change any pricing. GUARD: only float a done step whose
  // slot had NO earlier pending (not-done) move. Otherwise the step might read "done" only
  // because an earlier PLANNED step produced it, lifting it above that step would flip it
  // back to not-done. The leading done-run always qualifies (nothing pending before it).
  const floatIds = new Set();
  const pendingSlot = new Set();
  for (const e of entries) {
    if (e.step.kind === "move") {
      if (e.status === "done") { if (!pendingSlot.has(e.step.slot)) floatIds.add(e.step.id); }
      else pendingSlot.add(e.step.slot);
    } else if (e.step.kind === "goal" && e.status === "done") floatIds.add(e.step.id);
  }
  const head = steps.filter((s) => floatIds.has(s.id));      // completed, original order
  const tail = steps.filter((s) => !floatIds.has(s.id));     // the live plan, to be sorted
  const origIndex = new Map(tail.map((s, i) => [s.id, i]));

  let newTail = tail;
  if (tail.length >= 2 && mode === "deps") {
    // Full merge over the tail (notes/goals/blocked steps each their own chain so they hold
    // position), keyed by original index → nearest valid order.
    const chains = new Map();
    for (const s of tail) {
      const key = s.kind === "move" ? `slot:${s.slot}` : `id:${s.id}`;
      (chains.get(key) || chains.set(key, []).get(key)).push(s);
    }
    newTail = mergeChains([...chains.values()].map((c) => canonChain(c, origIndex)),
      (s) => origIndex.get(s.id), origIndex);
  } else if (tail.length >= 2) {
    // Value modes: permute only the READY move steps among their own positions (notes and
    // goals stay put), sorted by the mode's value metric.
    const boxSavings = opts.boxSavings || {};
    const keyOf = (s) => {
      const e = byId.get(s.id);
      const pts = e?.move?.pointGain || 0;
      const gold = mode === "smart" ? Math.max(0, (e?.gold || 0) - (boxSavings[s.id] || 0)) : (e?.gold || 0);
      if (mode === "cheapest") return gold;
      return pts > 0 ? gold / pts : Infinity; // value/smart: gold per point; no gain → last
    };
    const positions = [];
    const chains = new Map();
    tail.forEach((s, i) => {
      const e = byId.get(s.id);
      if (s.kind !== "move" || e?.status !== "ready") return;
      positions.push(i);
      (chains.get(s.slot) || chains.set(s.slot, []).get(s.slot)).push(s);
    });
    if (positions.length >= 2) {
      const merged = mergeChains([...chains.values()].map((c) => canonChain(c, origIndex)), keyOf, origIndex);
      newTail = tail.slice();
      positions.forEach((p, k) => { newTail[p] = merged[k]; });
    }
  }
  const next = [...head, ...newTail];
  // Keep the same path reference when nothing actually moved (no float, no reorder).
  return next.length === steps.length && next.every((s, i) => s.id === steps[i].id)
    ? path : { ...path, steps: next };
}

// Quick-add search (SPEC §17.7)
// Rank `cands` (built by the UI from every slot's upgrade options + the checklist goals)
// against a free-text query. Each candidate carries a `search` haystack (label + slot +
// part + target names). Matching: every whitespace-separated token must appear as a
// substring (case-insensitive); a token landing on a word start scores higher. Ties (and
// the empty query) fall back to the candidate's `value` (points per gold, best first).
// Returns at most `limit` candidates, best first. Pure, the UI owns rendering/insertion.
export function quickAddFilter(cands, query, limit = 12) {
  const toks = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of cands) {
    const hay = String(c.search || c.label || "").toLowerCase();
    let score = 0, ok = true;
    for (const t of toks) {
      const i = hay.indexOf(t);
      if (i < 0) { ok = false; break; }
      score += i === 0 || /[^a-z0-9]/.test(hay[i - 1]) ? 2 : 1; // word-start bonus
    }
    if (ok) scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0]
    || ((b[1].value ?? -Infinity) - (a[1].value ?? -Infinity)));
  return scored.slice(0, limit).map((x) => x[1]);
}

// Phase-5 sugar helpers (SPEC §17.14)

// Independent snapshot of a path for the one-level undo toast: fresh path + step objects
// (comment edits mutate steps in place, so a shared reference would corrupt the snapshot).
// Nested arrays (tuneStep maxes) are only ever REPLACED, never mutated, safe to share.
export const clonePath = (path) => ({ v: path.v ?? PATH_VERSION, steps: path.steps.map((s) => ({ ...s })) });

// Count of consecutive LEADING done entries, the collapsible "✓ N completed" run at the
// top of the list. Stops at the first non-done entry (an interior done card never collapses;
// it's context for the steps around it).
export const leadingDoneRun = (entries) => {
  let n = 0;
  for (const e of entries) { if (e.status === "done") n++; else break; }
  return n;
};

// Mats-only shopping list TSV of an aggregated pile (SPEC §17.14): one row per item:
// need (ceiled EV), have (via `ownedOf`), shortfall, and the est. gold to buy the shortfall
// at `costOf` unit prices (0 for free/covered items). Rows sort by name like the panel.
export function shoppingListTSV(materials, ownedOf, costOf) {
  const rows = [["Item", "Need", "Have", "Short", "Est. gold"].join("\t")];
  for (const [n, q] of Object.entries(materials || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    const need = Math.ceil(q), have = ownedOf(n) || 0, short = Math.max(0, need - have);
    rows.push([n, need, have, short, Math.round((costOf(n) ?? 0) * short)].join("\t"));
  }
  return rows.join("\n");
}

// Materials aggregation over a selection
// Sums the READY entries only (done needs nothing; blocked/impossible can't be priced).
// `ids` = Set of step ids to include; null/empty → the whole path.
export function aggregateMaterials(entries, ids = null) {
  const materials = {}; let gold = 0, steps = 0;
  for (const e of entries) {
    if (e.status !== "ready" || e.step.kind !== "move") continue;
    if (ids && ids.size && !ids.has(e.step.id)) continue;
    gold += e.gold || 0; steps++;
    for (const [n, q] of Object.entries(e.materials || {})) materials[n] = (materials[n] || 0) + q;
  }
  return { gold, materials, steps };
}

// Projected-stat aggregation over a selection (SPEC §17, phase 3)
// Sums the READY move entries' forward-simulated `statDiff`s (done/blocked/impossible
// contribute nothing, done is already in currentStats, and the rest aren't priced).
// Also tallies `pointGain` for a total ranking-points line. `ids` = Set of step ids to
// include; null/empty → the whole path. Mirrors aggregateMaterials; pure (the UI adds
// currentStats to get current → projected).
export function aggregateStatDiffs(entries, ids = null) {
  const stats = {}; let points = 0, steps = 0;
  for (const e of entries) {
    if (e.status !== "ready" || e.step.kind !== "move") continue;
    if (ids && ids.size && !ids.has(e.step.id)) continue;
    const sd = e.move?.statDiff;
    if (!sd) continue;
    steps++;
    points += e.move.pointGain || 0;
    for (const [k, v] of Object.entries(sd)) if (v) stats[k] = (stats[k] || 0) + v;
  }
  return { stats, points, steps };
}

// Raid-unlock milestones (SPEC §17.13, redesign phase 4)
// Cumulative projected stats AFTER each entry: start from `currentStats` and fold in each
// READY move entry's forward-simulated statDiff (set-bonus/ring-pair deltas are already
// inside it, never re-add). done contributes nothing (it's already in currentStats);
// blocked/impossible/note/goal entries carry the previous snapshot forward. Returns one
// stat map per entry (aligned by index; consecutive no-change entries share the object).
export function projectedStatsAt(entries, currentStats) {
  const out = [];
  let stats = { ...currentStats };
  for (const e of entries) {
    const sd = e.status === "ready" && e.step.kind === "move" ? e.move?.statDiff : null;
    if (sd) {
      stats = { ...stats };
      for (const [k, v] of Object.entries(sd)) if (v) stats[k] = (stats[k] || 0) + v;
    }
    out.push(stats);
  }
  return out;
}

// The stat targets a raid asks of you, per aim: "qb" = the Quick-Battle ENTRY floors
// (entry is gated by QB only; cf. nextRaid in raids.js), "cap" = those floors with the
// capped stats (bal/crit/critRes) raised to the raid's caps (`raid.targets`, built at
// load, the Target tab's QB entry / Caps toggle, mirrored here for the Planner card).
export const raidAimTargets = (raid, aim = "qb") =>
  (aim === "cap" ? raid.targets : raid.qb) || {};

// How far `stats` falls short of a raid's targets for the given aim. Target keys are the
// SAME canonical scored-stat keys as currentStats/statDiff (RAID_QB_COLUMNS maps headers to
// them at load), so no key translation happens here. {} = every target met.
export function raidShortfall(raid, stats, aim = "qb") {
  const short = {};
  for (const [k, v] of Object.entries(raidAimTargets(raid, aim))) {
    const gap = v - (stats[k] ?? 0);
    if (gap > 0) short[k] = gap;
  }
  return short;
}

// The easiest raid whose `aim` targets `stats` does NOT fully meet, the Planner card's
// auto pick ("next raid"). Unlike raids.js nextRaid (which falls back to the hardest raid
// when everything is met), this returns null so the card can say "all met" instead.
export function nextUnmetRaid(raids, stats, aim = "qb") {
  for (const r of raids || [])
    if (Object.keys(raidShortfall(r, stats, aim)).length) return r;
  return null;
}

// For each raid whose `aim` targets (QB entry floors by default) the PATH-START stats
// don't all meet, the index of the first
// entry after which the cumulative projected stats meet them all. Returns [{ raid, index }]
// in crossing order (raids crossing at the same step keep the input, ascending-difficulty, 
// order). Raids already enterable at the start are excluded (nothing to unlock); raids the
// path never reaches are absent.
export function raidMilestones(entries, currentStats, raids, aim = "qb") {
  let pending = (raids || []).filter((r) => Object.keys(raidShortfall(r, currentStats, aim)).length > 0);
  if (!pending.length) return [];
  const out = [];
  const perStep = projectedStatsAt(entries, currentStats);
  for (let i = 0; i < perStep.length && pending.length; i++) {
    const still = [];
    for (const r of pending) {
      if (Object.keys(raidShortfall(r, perStep[i], aim)).length) still.push(r);
      else out.push({ raid: r.raid, index: i });
    }
    pending = still;
  }
  return out;
}

// Affordability projection
// "How far down the path do current materials + gold carry you?" Walks the entries in
// order consuming a SCRATCH copy of the inventory and gold: each ready step draws its
// materials from stock (shortfall bought with gold at ctx.cost unit prices, on top of
// the step's non-material gold). `prefixN` = count of leading steps coverable in
// sequence (done steps pass through free; the walk stops at the first unaffordable,
// blocked, or impossible step). `coverable` = ids of EVERY ready step individually
// affordable from the FULL starting stock (the "affordable now" per-card flags). Not
// just post-break ones, so identical steps flag consistently regardless of the break.
// gold == null → unlimited (the user isn't tracking gold).
export function projectAffordability(entries, inventory, gold, ctx) {
  const unitGold = (move, materials) => {
    // Non-material gold: fees/etc. = full un-netted cost minus the buy value of the pile.
    let matGold = 0;
    for (const [n, q] of Object.entries(materials || {})) matGold += (ctx.cost(n) ?? 0) * q;
    return Math.max(0, ((move && (move.goldCost + (move.inventoryCredit || 0))) ?? 0) - matGold);
  };
  const tryStep = (e, stock, goldLeft) => {
    // A FREE step (SPEC §17.9) costs nothing and draws no stock, always coverable.
    if (e.free) return 0;
    // Returns the gold spent, or null if unaffordable. Draws stock in place, recursively:
    // a crafted material's shortfall consumes owned sub-materials before buying (drawMaterial),
    // so leaf stock still counts even though the pile stays at the first level.
    let spend = unitGold(e.move, e.materials);
    for (const [n, q] of Object.entries(e.materials || {})) spend += drawMaterial(ctx, stock, n, q);
    return spend <= goldLeft ? spend : null;
  };
  const budget = gold == null ? Infinity : gold;
  let prefixN = 0, goldLeft = budget, broke = false;
  const stock = { ...(inventory || {}) };
  const coverable = new Set();
  for (const e of entries) {
    if (e.step.kind !== "move" || e.status === "done") { if (!broke) prefixN++; continue; }
    if (e.status !== "ready") { broke = true; continue; }
    // Per-card "affordable now" flag: test EVERY ready step individually against the FULL
    // starting stock/gold, independent of where the sequential prefix walk breaks, so two
    // identical steps don't get marked differently just because a blocked step sits between
    // them (a step inside the affordable prefix is affordable too; flag it the same).
    const solo = { ...(inventory || {}) };
    if (tryStep(e, solo, budget) != null) coverable.add(e.step.id);
    if (!broke) {
      const snapshot = { ...stock };
      const spent = tryStep(e, stock, goldLeft);
      if (spent != null) { goldLeft -= spent; prefixN++; continue; }
      Object.assign(stock, snapshot); // restore the failed draw
      broke = true;
    }
  }
  return { prefixN, coverable, goldLeft };
}
