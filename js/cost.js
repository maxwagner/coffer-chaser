// Cost primitives (SPEC §5). The only stochastic piece is enchanting; everything
// else (crafting, tier steps) is deterministic and added later.

import {
  ENCHANT_SUCCESS_BASE, ENCHANT_GUARANTEED_RANK, SCRAP_GUARANTEE_COUNT,
  EXQUISITE_RUNE_NAME, PROTECT_RUNE_COST, PRICE_BASIS, SCRAP_SALE_FEE,
} from "./config.js";

// Acquisition cost (SPEC §5.2)
// cost(item)   = min( marketplace price, craft cost )
// craftCost(r) = flatFee + Σ qty · cost(material)   (recurses; crafting is 100%)
//
// Both recurse through `recipes` and use the live `prices` feed for leaves. A
// memo cache speeds repeated lookups; a `building` set guards against recipe
// cycles. Returns null when an item can be neither bought nor fully crafted
// (some leaf material is unpriced). Callers surface that as a TODO, not a guess.

// `freeItems` (optional) is a LIVE Set of item names whose acquisition cost is
// forced to 0, used for the "free Enhancement Rune" toggle (the player has a
// stockpile). It is read on every `cost()` call and shared with the caller, so
// mutating the set + calling the returned `invalidate()` (to clear memos) re-prices
// the whole graph without rebuilding the coster. Anything that consumes a free item
// as a material picks up the 0 automatically through the recursion.
export function makeCoster(prices, recipes, { basis = PRICE_BASIS, freeItems = null } = {}) {
  const costMemo = new Map();
  const craftMemo = new Map();
  const building = new Set();
  const closureMemo = new Map(); // name → Set of every material in its recipe expansion (incl. itself)
  const marketOf = (name) => prices[name]?.[basis] ?? null;

  // Transitive material closure of `name`'s recipe tree (name itself included):
  // the set of items whose owned stock could possibly change netCost(name). Cycle-safe
  // (a revisited node contributes what's been collected so far). Memoized; static per
  // coster since `recipes` never changes (freeItems/prices don't affect the SHAPE).
  function closureOf(name) {
    if (closureMemo.has(name)) return closureMemo.get(name);
    const set = new Set([name]);
    closureMemo.set(name, set); // pre-set so cycles terminate
    const r = recipes[name];
    if (r) for (const { material } of r.materials) for (const n of closureOf(material)) set.add(n);
    return set;
  }

  // True when `owned` stocks nothing that could alter netCost(name). The common case,
  // where netCost degenerates to need·cost(name) without walking the recipe tree.
  function ownsNoneOf(name, owned) {
    const cl = closureOf(name);
    for (const k in owned) if (owned[k] > 0 && cl.has(k)) return false;
    return true;
  }

  function craftCost(name) {
    if (craftMemo.has(name)) return craftMemo.get(name);
    const recipe = recipes[name];
    if (!recipe) return null;
    if (building.has(name)) return null; // cycle → bail
    building.add(name);
    let total = recipe.fee || 0;
    let ok = true;
    for (const { material, qty } of recipe.materials) {
      const c = cost(material);
      if (c == null) { ok = false; break; }
      total += qty * c;
    }
    building.delete(name);
    const result = ok ? total : null;
    craftMemo.set(name, result);
    return result;
  }

  function cost(name) {
    if (costMemo.has(name)) return costMemo.get(name);
    let result;
    if (freeItems && freeItems.has(name)) {
      result = 0; // stockpiled / free, overrides both market and craft
    } else {
      const market = marketOf(name);
      const craft = craftCost(name);
      const candidates = [market, craft].filter((v) => v != null);
      result = candidates.length ? Math.min(...candidates) : null;
    }
    costMemo.set(name, result);
    return result;
  }

  // Inventory-aware acquisition (SPEC §5.2 inventory)
  // Gold to acquire `qty` units of `name` while drawing down `owned` (a {name:count}
  // map, MUTATED in place) at ANY node: owned units of the item are consumed FIRST
  // (an owned crafted intermediate is NOT expanded; owned leaves subtract), and only
  // the shortfall is bought/crafted, choosing buy-vs-craft exactly like cost(), so an
  // EMPTY `owned` reproduces qty·cost(name) unchanged. Each consumed unit is tallied
  // into `used` (when provided). Returns null when a needed leaf is unpriceable (same
  // as cost()). Callers clone the live inventory PER MOVE, naive per-move netting: a
  // move may credit the full stock; nothing is globally allocated across the ranked list.
  function netCost(name, qty, owned, used) {
    if (qty <= 0) return 0;
    const have = owned[name] || 0;
    const take = Math.min(have, qty);
    if (take > 0) { owned[name] = have - take; if (used) used[name] = (used[name] || 0) + take; }
    const need = qty - take;
    if (need <= 0) return 0;
    if (freeItems && freeItems.has(name)) return 0;
    // Fast path: nothing owned anywhere in this item's recipe closure → no stock can
    // credit the shortfall, so the inventory-aware price IS the plain memoized cost()
    // (which already folds in buy-vs-craft and freeItems). Skips the per-node recipe
    // walk + owned-map clones that dominate solver time when the inventory is small
    // relative to the recipe universe.
    if (ownsNoneOf(name, owned)) {
      const c = cost(name);
      return c == null ? null : need * c;
    }
    const market = marketOf(name);
    const buy = market != null ? market * need : null;
    // Craft path: draw the recipe's materials down against the CURRENT inventory on a
    // scratch clone, so we can compare its true (inventory-aware) cost against buying
    // WITHOUT committing. This is what lets owned ingredients flip a rune from "buy" to
    // "craft" even when its market price is below its nominal (all-bought) craft cost.
    // The old shortcut compared market vs the market-priced craft and skipped the recipe
    // entirely when buying looked cheaper, hiding the ingredients the player already owns.
    // `building` guards recipe cycles (a cyclic recipe can't be priced → craft stays null).
    let craft = null, craftOwned = null, craftUsed = null;
    if (recipes[name] && !building.has(name)) {
      building.add(name);
      const r = recipes[name];
      craftOwned = { ...owned };
      craftUsed = used ? { ...used } : null;
      let total = (r.fee || 0) * need, ok = true;
      for (const { material, qty: q } of r.materials) {
        const c = netCost(material, q * need, craftOwned, craftUsed);
        if (c == null) { ok = false; break; }
        total += c;
      }
      building.delete(name);
      if (ok) craft = total;
    }
    // Take the cheaper priceable path and commit its inventory draw-down.
    if (craft != null && (buy == null || craft <= buy)) {
      for (const k in owned) delete owned[k];
      Object.assign(owned, craftOwned);
      if (used && craftUsed) { for (const k in used) delete used[k]; Object.assign(used, craftUsed); }
      return craft;
    }
    return buy;
  }

  // Drop all cached costs, call after mutating `freeItems` (or `prices`) so the
  // next lookups recompute. The `cost`/`craftCost` function identities are stable
  // across this, so existing closures (moveCtx, view builders) keep working.
  function invalidate() { costMemo.clear(); craftMemo.clear(); building.clear(); }

  return { cost, craftCost, netCost, invalidate };
}

// Per-enchant success probability from its rank (SPEC §5.3 / user spec):
//   numeric rank ≥ 8 → 1.0 ; letter ranks (A/B/C…) → 1.0 ; ranks 1–7 → 0.40.
export function successRate(rank) {
  if (rank == null) return ENCHANT_SUCCESS_BASE;
  if (typeof rank === "string") return 1.0; // letter tier
  return rank >= ENCHANT_GUARANTEED_RANK ? 1.0 : ENCHANT_SUCCESS_BASE;
}

// Expected cost of the "spam scrolls until it lands" path (SPEC §5.3).
//
//   spamCost = (1/p)·scroll + (q/p)·(protectRune − scrapResale)
//
//  - (1/p) = expected scrolls bought before one sticks; (q/p) = expected
//    failures, each consuming a protect rune and yielding ONE scrap.
//  - Scraps are sold as you go (scrapResale = scrapPrice × (1 − sale fee)), so
//    no 4-fail guarantee floor is modeled here, the separate "buy 4 scraps"
//    method already provides the cost ceiling via the outer min().
//  - With no scrap, scrapResale is null → plain geometric, no recovery.
//  - The result can be NEGATIVE when scrap resale exceeds scroll outlay (real
//    arbitrage); the caller floors it to 0 for ranking and flags it.
function spamCost(p, scroll, protectRune, scrapResale) {
  const q = 1 - p;
  return scroll / p + (protectRune - (scrapResale ?? 0)) * (q / p);
}

// All priceable acquisition methods for one enchant, each as { method, gold },
// cheapest first. Empty if nothing can be priced from the current feed.
export function enchantMethods(
  enchant, prices, { protectRuneCost = PROTECT_RUNE_COST, basis = PRICE_BASIS } = {}
) {
  const priceOf = (name) => (name ? prices[name]?.[basis] ?? null : null);
  const scroll = priceOf(enchant.scroll);
  const scrap = priceOf(enchant.scrap);
  const exquisite = priceOf(EXQUISITE_RUNE_NAME);
  const p = successRate(enchant.rank);

  const scrapResale = scrap != null ? scrap * (1 - SCRAP_SALE_FEE) : null;

  const methods = [];
  if (p >= 1) {
    if (scroll != null) methods.push({ method: "scroll", gold: scroll });
  } else {
    if (scrap != null) methods.push({ method: "scraps", gold: SCRAP_GUARANTEE_COUNT * scrap });
    if (scroll != null && exquisite != null) methods.push({ method: "exquisite", gold: scroll + exquisite });
    if (scroll != null) {
      const raw = spamCost(p, scroll, protectRuneCost, scrapResale);
      // Floor at the SCROLL price (SPEC §5.3): the cheapest real outcome is one
      // scroll landing first try, so scrap resale can never make an enchant read
      // free/profitable. `raw` (may dip below scroll, even negative) + `floored`
      // are kept for the detail. Each expected failure also burns one enchant rune
      // (`runesUsed`, valued 0 but surfaced). Guaranteed ranks never fail, so
      // they never touch a rune.
      methods.push({
        method: "spam", gold: Math.max(scroll, raw), raw,
        floored: raw < scroll, runesUsed: (1 - p) / p,
      });
    }
  }
  return methods.sort((a, b) => a.gold - b.gold);
}

// Cheapest way to land one specific enchant, as { gold, method }, or null.
export function enchantCost(enchant, prices, opts) {
  const methods = enchantMethods(enchant, prices, opts);
  return methods.length ? methods[0] : null;
}

// Accessory enhancement EV (SPEC §6 enhanceStep)
// Failure keeps the level (no downgrade), so reaching a level is a finite series:
// each attempt has the same material/gold cost, and the success rate climbs with
// consecutive failures via the pity bonuses until a guaranteed attempt. Expected
// attempts E[A] = Σ_k P(reach attempt k) = Σ_k Π_{j<k}(1 − p_j), where
//   p_1 = base, p_k = min(1, base + pityBonus[k-1]/100)  (bonus in % points).
// A 100 bonus → base+1.0 → caps to 1.0, which also terminates the sum.
export function expectedEnhanceTries(baseRate, pityBonuses = []) {
  const p0 = baseRate / 100;
  let expected = 0, survive = 1;
  const maxK = pityBonuses.length + 1; // base attempt + one per pity column
  for (let k = 1; k <= maxK; k++) {
    const pk = k === 1 ? p0 : Math.min(1, p0 + (pityBonuses[k - 2] ?? 0) / 100);
    expected += survive;       // contributes if we reach the k-th attempt
    survive *= 1 - pk;         // prob of still failing into the next attempt
    if (pk >= 1) break;        // guaranteed → no further attempts possible
  }
  return expected;
}

// Expected gold to advance ONE enhancement level, given that level's stat/cost row
// (`entry`, with .gold + .materials) and the pity bonuses for that level. Returns
// { gold, attempts, perAttempt } or null if any material is unpriced.
export function enhanceStepCost(entry, pityBonuses, prices, basis = PRICE_BASIS, freeItems = null) {
  let matCost = 0;
  const materials = {};
  for (const [name, qty] of Object.entries(entry.materials)) {
    // A user-flagged free item (SPEC §17.9) prices at 0, mirroring the coster's freeItems set,
    // so marking an enhance material free actually zeroes the step, not just the coster-priced paths.
    const unit = freeItems && freeItems.has(name) ? 0 : (prices[name]?.[basis] ?? null);
    if (unit == null) return null; // can't fully price this step → not actionable
    matCost += qty * unit;
    materials[name] = qty; // per-attempt qty (× attempts = expected total)
  }
  const perAttempt = (entry.gold || 0) + matCost;
  const attempts = expectedEnhanceTries(entry.successRate || 0, pityBonuses);
  return { gold: attempts * perAttempt, attempts, perAttempt, fee: entry.gold || 0, materials };
}

// Weapon/armor +level enhancement has NO cost model here: the Orna +12→+15 climb is
// ordinary Crafting-tab data, with its expected number of attempts already baked into
// each step's gold + material quantities, so craftCost prices it like any other tier.
// See docs/orna-enhancement.md for the rates and the maths behind those numbers.
// (`expectedEnhanceTries` below is the ACCESSORY table, a different mechanic: additive
// pity bonuses rather than absolute per-attempt rates.)

// Expected gold to enhance an accessory from `fromLevel` up to `toLevel` on a given
// item-level bracket, the sum of each level's EV step. Used to (a) restore a
// freshly-swapped base to the slot's current enhance level (a new base is +0, SPEC
// §6/§7.2) and (b) push it higher during re-baselining. Returns gold, 0 when there
// is nothing to do, or null if any step is unpriceable (→ caller drops the move).
export function reEnhanceCost(accessories, bracket, fromLevel, toLevel, prices, basis = PRICE_BASIS, freeItems = null) {
  if (!toLevel || toLevel <= fromLevel) return 0;
  const table = accessories?.brackets?.[bracket];
  if (!table) return null;
  let total = 0;
  for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
    const entry = table.find((e) => e.level === lvl);
    if (!entry) return null;
    const step = enhanceStepCost(entry, accessories.pity?.[lvl] || [], prices, basis, freeItems);
    if (!step) return null;
    total += step.gold;
  }
  return total;
}
