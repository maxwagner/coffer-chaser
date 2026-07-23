// Weekly free choice boxes (SPEC §18). Each week, every character that can run the
// qualifying raid claims ONE box from a fixed menu (essence boxes + an elixir box).
// Contents BIND to the character. They can't be sold, only used. So a box is worth
// the gold it SAVES: the purchase a planned upgrade would otherwise make. Units beyond
// what the plan needs are worth 0. Claimed boxes never expire (they accumulate
// unopened), so the advice is always "claim every week, open on demand": this module
// computes WHICH boxes to open now (from the on-hand stock) and what future weekly
// income covers, never a use-it-or-lose-it weekly gamble.
//
// The tab reuses the Seal Shop `Contains` grammar (sealshop.js): the Destiny box is a
// "A | B | C" CHOICE cell, the elixir box a single item with an xN quantity suffix.
// Both are "a choice of bound rewards", the shared concept behind the seal shop,
// weekly boxes, and (future) event shops.

import { WEEKLY_BOX_CSV_URL, WEEKLY_BOX_CSV_FALLBACK, WEEKLY_BOX_COLUMNS, WEEKLY_BOX_RESET, PRICE_BASIS } from "./config.js";
import { fetchSheetRows, headerIndex } from "./sheet.js";
import { resolveChoice } from "./sealshop.js";

// rows (incl. header) → [{ box, contains }] in sheet order. Rows missing either cell
// are skipped (a box with no contents can't be valued; never guess).
export function rowsToWeeklyBoxes(rows) {
  if (!rows.length) return [];
  const idx = headerIndex(rows[0], WEEKLY_BOX_COLUMNS);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const box = (rows[r][idx.box] || "").trim();
    const contains = (rows[r][idx.contains] || "").trim();
    if (!box || !contains) continue;
    out.push({ box, contains });
  }
  return out;
}

// Flatten the box menu into concrete OPENABLE OUTCOMES: one entry per alternative of a
// choice cell (the weekly decision is really "which of the ~8 outcomes"), each with its
// unit price. `priceOf` follows the seal-shop convention (name → unit gold; the app
// passes the coster's cost so contents value at min(market, craft)). Unpriceable
// outcomes keep price:null, listed but never planned (never guessed).
export function weeklyBoxOptions(boxes, prices = {}, basis = PRICE_BASIS, priceOf = null) {
  const out = [];
  for (const b of boxes) {
    const { picks } = resolveChoice(b.contains, prices, basis, priceOf);
    for (const p of picks) out.push({ box: b.box, item: p.item, qty: p.qty, price: p.price });
  }
  return out;
}

// Next weekly reset STRICTLY after `now` (Tuesday 07:00 UTC by default). Anchors the
// "week N" → calendar-date math in the Planner's schedule display.
export function nextReset(now = new Date(), { day = WEEKLY_BOX_RESET.day, hourUTC = WEEKLY_BOX_RESET.hourUTC } = {}) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0, 0));
  let delta = (day - t.getUTCDay() + 7) % 7;
  if (delta === 0 && t <= now) delta = 7;
  t.setUTCDate(t.getUTCDate() + delta);
  return t;
}

// How much of each box-coverable item the plan still NEEDS, from a materials pile
// (aggregateMaterials' shallow first-level pile). Mirrors drawMaterial's semantics:
// owned stock is credited first (deep, an owned crafted intermediate needs none of
// its ingredients), then a crafted item's remaining shortfall recurses into its recipe
// so essences buried inside a tier recipe's intermediates still count. `targets` =
// the item names the boxes can yield. Returns { item: unitsShort } (positive only).
export function weeklyDemand(materials, targets, ctx) {
  const need = {};
  const stock = { ...(ctx.inventory || {}) };
  const walk = (n, q, depth) => {
    q = Math.ceil(q);
    const have = stock[n] || 0, take = Math.min(have, q);
    if (take > 0) stock[n] = have - take;
    const short = q - take;
    if (short <= 0) return;
    if (targets.has(n)) { need[n] = (need[n] || 0) + short; return; }
    const r = ctx.recipes?.[n];
    if (!r || depth > 40) return;
    for (const { material, qty } of r.materials) walk(material, qty * short, depth + 1);
  };
  for (const [n, q] of Object.entries(materials || {})) walk(n, q, 0);
  return need;
}

// The open/claim schedule. Supply = `onHand` unopened boxes available NOW (week 0),
// then `alts` more per week (one per farming character) from the next reset. Each
// supply slot greedily opens the outcome with the highest MARGINAL gold saved against
// still-uncovered demand (min(box qty, remaining need) × unit price); leftover units
// beyond need are bound and worth 0, so a partially-used box only counts its used
// units. Stops when no outcome saves anything (demand covered or only unpriced/
// undemanded outcomes remain) or at `maxWeeks` (exhausted:true, demand outlives the
// horizon). Greedy is exact here: outcomes are single-item and supply slots are
// interchangeable, so highest-marginal-value-first is optimal.
export function weeklyBoxPlan(options, demand, { onHand = 0, alts = 1, maxWeeks = 52 } = {}) {
  const remaining = {};
  for (const [n, q] of Object.entries(demand || {})) if (q > 0) remaining[n] = q;
  const picks = [];
  const perWeek = Math.max(0, Math.floor(alts));
  let week = 0, slots = Math.max(0, Math.floor(onHand));
  let exhausted = false;
  for (;;) {
    if (slots <= 0) {
      if (perWeek <= 0) break;
      week += 1;
      if (week > maxWeeks) { exhausted = Object.keys(remaining).length > 0; break; }
      slots = perWeek;
    }
    let best = null;
    for (const o of options) {
      if (o.price == null || o.price <= 0) continue;
      const used = Math.min(o.qty, remaining[o.item] || 0);
      if (used <= 0) continue;
      const saved = used * o.price;
      if (!best || saved > best.saved) best = { week, box: o.box, item: o.item, qty: o.qty, used, saved };
    }
    if (!best) break;
    remaining[best.item] -= best.used;
    if (remaining[best.item] <= 0) delete remaining[best.item];
    picks.push(best);
    slots -= 1;
  }
  const perItem = {};
  for (const [n, q] of Object.entries(demand || {})) {
    if (q <= 0) continue;
    const mine = picks.filter((p) => p.item === n);
    perItem[n] = {
      need: q,
      covered: mine.reduce((s, p) => s + p.used, 0),
      coveredNow: mine.reduce((s, p) => s + (p.week === 0 ? p.used : 0), 0),
      lastWeek: mine.length ? Math.max(...mine.map((p) => p.week)) : null,
    };
  }
  return {
    picks,
    perItem,
    totalSaved: picks.reduce((s, p) => s + p.saved, 0),
    savedNow: picks.reduce((s, p) => s + (p.week === 0 ? p.saved : 0), 0),
    weeks: picks.reduce((m, p) => Math.max(m, p.week), 0),
    exhausted,
  };
}

// Attribute the pile-level box plan's covered units to individual STEPS, in path order:
// "which planned upgrades are waiting on a future weekly box, and until when?". Walks the
// ready move entries sequentially with the SAME stock-crediting as weeklyDemand (shared
// scratch stock, so the per-step demands sum to the pile's), then feeds each step's
// box-coverable demand from the plan's picks item-by-item in ascending week order. A step
// whose assigned units include a FUTURE week (> 0) maps to that last week number; steps
// fully served by on-hand boxes (week 0) or not box-covered at all are absent. Returns
// { stepId: lastWeek } (lastWeek ≥ 1 only).
export function stepBoxWaits(entries, picks, targets, ctx) {
  // Per-item unit queues from the picks, cheapest-schedule-first (ascending week).
  const queues = {};
  for (const p of [...(picks || [])].sort((a, b) => a.week - b.week))
    (queues[p.item] ||= []).push({ week: p.week, units: p.used });
  const stock = { ...(ctx.inventory || {}) };
  const out = {};
  for (const e of entries || []) {
    if (e.status !== "ready" || e.step.kind !== "move") continue;
    // This step's box-coverable shortfall (deep, stock-credited, mirrors weeklyDemand).
    const need = {};
    const walk = (n, q, depth) => {
      q = Math.ceil(q);
      const have = stock[n] || 0, take = Math.min(have, q);
      if (take > 0) stock[n] = have - take;
      const short = q - take;
      if (short <= 0) return;
      if (targets.has(n)) { need[n] = (need[n] || 0) + short; return; }
      const r = ctx.recipes?.[n];
      if (!r || depth > 40) return;
      for (const { material, qty } of r.materials) walk(material, qty * short, depth + 1);
    };
    for (const [n, q] of Object.entries(e.materials || {})) walk(n, q, 0);
    // Draw the demand from the queues; the latest week drawn is the step's wait.
    let lastWeek = 0;
    for (const [n, q] of Object.entries(need)) {
      let left = q;
      const queue = queues[n] || [];
      while (left > 0 && queue.length) {
        const head = queue[0];
        const take = Math.min(head.units, left);
        head.units -= take; left -= take;
        if (head.week > lastWeek) lastWeek = head.week;
        if (head.units <= 0) queue.shift();
      }
    }
    if (lastWeek > 0) out[e.step.id] = lastWeek;
  }
  return out;
}

// Per-step GOLD saved by the weekly-box plan (SPEC §17.15). The box-adjustment the Planner's
// "smart" reorder subtracts from each step's cost. Same sequential stock-credited walk as
// stepBoxWaits, but accumulates used-units × unit-price instead of the wait week. Unit prices
// come from the picks themselves (saved ÷ used). Returns { stepId: goldSaved } (positive only).
export function stepBoxSavings(entries, picks, targets, ctx) {
  const queues = {}, unit = {};
  for (const p of [...(picks || [])].sort((a, b) => a.week - b.week)) {
    (queues[p.item] ||= []).push({ units: p.used });
    if (unit[p.item] == null && p.used > 0) unit[p.item] = p.saved / p.used;
  }
  const stock = { ...(ctx.inventory || {}) };
  const out = {};
  for (const e of entries || []) {
    if (e.status !== "ready" || e.step.kind !== "move") continue;
    const need = {};
    const walk = (n, q, depth) => {
      q = Math.ceil(q);
      const have = stock[n] || 0, take = Math.min(have, q);
      if (take > 0) stock[n] = have - take;
      const short = q - take;
      if (short <= 0) return;
      if (targets.has(n)) { need[n] = (need[n] || 0) + short; return; }
      const r = ctx.recipes?.[n];
      if (!r || depth > 40) return;
      for (const { material, qty } of r.materials) walk(material, qty * short, depth + 1);
    };
    for (const [n, q] of Object.entries(e.materials || {})) walk(n, q, 0);
    let saved = 0;
    for (const [n, q] of Object.entries(need)) {
      let left = q;
      const queue = queues[n] || [];
      while (left > 0 && queue.length) {
        const head = queue[0];
        const take = Math.min(head.units, left);
        head.units -= take; left -= take;
        saved += take * (unit[n] || 0);
        if (head.units <= 0) queue.shift();
      }
    }
    if (saved > 0) out[e.step.id] = saved;
  }
  return out;
}

// Returns { weeklyBoxes, source, liveError? }. Live-first (published gid), CSV
// snapshot fallback, like every other loader.
export async function loadWeeklyBoxes() {
  const { rows, source, liveError } = await fetchSheetRows(WEEKLY_BOX_CSV_URL, WEEKLY_BOX_CSV_FALLBACK);
  return { weeklyBoxes: rowsToWeeklyBoxes(rows), source, liveError };
}
