// Seal Shop loader + valuation (SPEC §16.10). Some drops are untradeable "currencies"
// (Uaithne Seal, Seal of Bravery, event tokens): they have no market listing of their
// own but REDEEM for tradeable items at a fixed shop. This module turns the Seal Shop
// tab into a per-currency implied value = the BEST redemption available, priced live
// off the feed. That value is injected into `prices` at load so the drop tracker +
// catalog treat a seal like any other priced drop.

import { SEAL_SHOP_CSV_URL, SEAL_SHOP_CSV_FALLBACK, SEAL_SHOP_COLUMNS, PRICE_BASIS } from "./config.js";
import { fetchSheetRows, headerIndex, toInt } from "./sheet.js";

// rows (incl. header) → { currencyName: [{ name, contains, cost, count, stock }, …] },
// preserving sheet order. `name` = the display/in-game reward name (the `Item` column, e.g.
// "Uaithne Crystal Box"); `contains` = the price-feed key(s) it resolves to (the optional
// `Contains` column, e.g. "Uaithne Crystal", or a "A | B" / "A & B" / "A + B" expression;
// see resolveItem). A blank/absent Contains falls back to `name`, so rows whose reward name
// already IS the feed key need no Contains. `cost` = currency units per pack; `count` = items
// per pack (blank → 1); `stock` = purchase cap (null = unlimited). Rows missing a currency or
// name are skipped. A blank/zero cost is kept as-is (null). The valuator guards on cost > 0.
export function rowsToSealShop(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], SEAL_SHOP_COLUMNS);
  // "Contains" is OPTIONAL (added after the other columns). Soft lookup so a sheet/snapshot
  // that predates it still loads; a blank/absent cell falls back to the display name below.
  const ci = rows[0].map((h) => h.trim()).indexOf("Contains");
  const out = {};
  for (let r = 1; r < rows.length; r++) {
    const currency = (rows[r][idx.currency] || "").trim();
    const name = (rows[r][idx.item] || "").trim();
    if (!currency || !name) continue;
    const contains = (ci >= 0 ? rows[r][ci] || "" : "").trim();
    (out[currency] ||= []).push({
      name,
      contains: contains || name, // price-feed key(s); default to the display name
      cost: toInt(rows[r][idx.cost]),
      count: toInt(rows[r][idx.count]) ?? 1,
      stock: toInt(rows[r][idx.stock]), // null = unlimited
    });
  }
  return out;
}

// Strip a trailing QUANTITY suffix from one item token and price it. "Item xN" = a fixed
// count N; "Item xA-B" = a RANDOM count, uniform over [A,B], valued at the midpoint EV
// ((A+B)/2). "×" is accepted for "x". No suffix → qty 1. Returns { item, qty, lo, hi, random,
// price, value } where `price` is the unit price (null if unpriceable) and `value` = the
// effective contribution qty·price (null when unpriced). The uniform assumption for a range
// is a DELIBERATE approximation for boxes that publish a spread but not per-count odds (an
// "unstable" cube giving 2-4 of a material); if real per-count odds exist, model it as a
// gamble (" & ") instead. This is a modeling choice, flagged, not invented game data.
//
// `priceOf` (optional) resolves an item's effective UNIT gold. When omitted it's the raw
// market feed (prices[item][basis]); the app passes the coster's `cost` so contents value at
// min(market, craft). A redemption is worth the cheapest way to otherwise obtain it, matching
// the project-wide cost rule (SPEC §5), so a craftable-but-unlisted item still prices.
function pricePick(token, prices, basis, priceOf) {
  const s = String(token);
  const m = s.match(/\s+[x×](\d+)(?:\s*-\s*(\d+))?$/i);
  const item = m ? s.slice(0, m.index).trim() : s.trim();
  const lo = m ? Number(m[1]) : 1;
  const hi = m && m[2] != null ? Number(m[2]) : lo;
  const qty = (lo + hi) / 2;
  const price = (priceOf ? priceOf(item) : prices[item]?.[basis]) ?? null;
  return { item, qty, lo, hi, random: hi !== lo, price, value: price == null ? null : qty * price };
}

// A CHOICE box: one purchase, but you pick which item you walk away with (e.g. "Keen Eriu
// Crystal | Lightweight Eriu Crystal"). List the full price-feed names separated by " | ";
// the row values at the BEST pick (max effective value), because a rational player takes the
// most valuable option. Each alternative may carry a quantity suffix (see pricePick). A cell
// with no "|" is a plain single item. `picks` lists every alternative for display; `chosen`
// is the winning item name.
export function resolveChoice(itemCell, prices = {}, basis = PRICE_BASIS, priceOf = null) {
  const picks = String(itemCell).split("|").map((s) => s.trim()).filter(Boolean).map((t) => pricePick(t, prices, basis, priceOf));
  const alts = picks.map((p) => p.item);
  let chosen = null, price = null;
  for (const p of picks) {
    if (p.value != null && (price == null || p.value > price)) { price = p.value; chosen = p.item; }
  }
  return { alts, picks, chosen, price };
}

// Split a gamble cell ("50% A & 30% B", or bare "A & B") into outcome tokens with rates. An
// optional leading "NN%" sets a rate; tokens without one share equally. If SOME tokens are
// weighted and others aren't, the bare ones would be ambiguous, so we fall back to equal
// rates for ALL (predictable over clever). Returns { token, rate } with rates summing to 1.
function parseOutcomes(cell) {
  const parsed = String(cell).split("&").map((s) => s.trim()).filter(Boolean).map((t) => {
    const m = t.match(/^(\d+(?:\.\d+)?)%\s+(.+)$/);
    return m ? { token: m[2].trim(), weight: Number(m[1]) } : { token: t, weight: null };
  });
  const allWeighted = parsed.length > 0 && parsed.every((p) => p.weight != null);
  const weights = parsed.map((p) => (allWeighted ? p.weight : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  return parsed.map((p, i) => ({ token: p.token, rate: total > 0 ? weights[i] / total : 0 }));
}

// A GAMBLE box: one purchase, a RANDOM outcome (e.g. "Enhance Rune & Enchant Rune", a 50/50;
// or "70% A & 30% B" for uneven rates). Value = the EXPECTED VALUE = Σ (rate · value), where
// each outcome's value honors its own quantity suffix. Unlike a choice box we can't skip an
// unpriced outcome. A missing price makes the EV unknowable. So if ANY outcome is unpriced
// the box is null (never guessed). `chosen` is null; `picks` carries each outcome's rate for
// display.
export function resolveGamble(itemCell, prices = {}, basis = PRICE_BASIS, priceOf = null) {
  const picks = parseOutcomes(itemCell).map((o) => ({ ...pricePick(o.token, prices, basis, priceOf), rate: o.rate }));
  const alts = picks.map((p) => p.item);
  let price = 0;
  for (const p of picks) {
    if (p.value == null) { price = null; break; }
    price += p.rate * p.value;
  }
  return { alts, picks, chosen: null, price };
}

// A BUNDLE box: one purchase, you get EVERY listed item (e.g. the Brynn Elixir Box, or the
// Redeemers Seal Box = "Redeemers Seal x2 + a license"). List the full price-feed names
// separated by " + "; value = the SUM of all contents (each honoring its quantity suffix).
// Like a gamble we can't skip an unpriced part, a missing price makes the total unknowable, 
// so if ANY part is unpriced the box is null (never guessed). `chosen` is null (you get all);
// `picks` carries each part's qty + price for display.
export function resolveBundle(itemCell, prices = {}, basis = PRICE_BASIS, priceOf = null) {
  const picks = String(itemCell).split("+").map((s) => s.trim()).filter(Boolean).map((t) => pricePick(t, prices, basis, priceOf));
  const alts = picks.map((p) => p.item);
  let price = 0;
  for (const p of picks) {
    if (p.value == null) { price = null; break; }
    price += p.value;
  }
  return { alts, picks, chosen: null, price };
}

// Resolve a redemption cell to its effective value, inferring the box kind from its
// separator: "A | B" = CHOICE (pick the best), "A & B" = GAMBLE (random item → EV), "A + B" =
// BUNDLE (get all → sum), plain "A" = single item. A single item may still carry a quantity
// suffix ("A x3" fixed, "A x2-4" random range → EV); a range makes its kind "range" (a random
// COUNT of one item, vs "gamble" which is a random CHOICE of item). Real data never mixes the
// | & + separators.
export function resolveItem(itemCell, prices = {}, basis = PRICE_BASIS, priceOf = null) {
  const cell = String(itemCell);
  if (cell.includes("|")) return { kind: "choice", ...resolveChoice(cell, prices, basis, priceOf) };
  if (cell.includes("&")) return { kind: "gamble", ...resolveGamble(cell, prices, basis, priceOf) };
  if (cell.includes("+")) return { kind: "bundle", ...resolveBundle(cell, prices, basis, priceOf) };
  const r = resolveBundle(cell, prices, basis, priceOf); // single item (one part). Honors xN / xA-B
  return { kind: r.picks[0]?.random ? "range" : "single", ...r };
}

// Per-currency implied value from the shop table + live prices. For each redemption
// option: perUnit = price(contains)·count / cost (null when the contents can't be priced, or
// cost is missing/0). Choice boxes (A | B) price at the best pick; gamble boxes (A & B) at the
// EV; bundle boxes (A + B) at the sum (see resolveItem). A currency's value = the MAX perUnit
// across its options (the best use of one seal); null when NOTHING it redeems for is priceable
// (never guessed). Returns { currency: { unit, best, options:[{name, contains, cost, count,
// stock, kind, alts, picks, chosen, price, perUnit}] } }, options sorted best-first.
//
// `priceOf` (optional, name → unit gold) overrides the raw market lookup, the app passes the
// coster's `cost` so contents value at min(market, craft), letting a craftable redemption price
// off its recipe when it has no market listing (SPEC §5, §16.10). `totals` (optional, currency
// → coupon budget from the sheet) adds a best-value `basket` per currency (see sealShopBasket).
export function sealShopValues(shop, prices = {}, basis = PRICE_BASIS, priceOf = null, totals = null) {
  const out = {};
  for (const [currency, opts] of Object.entries(shop)) {
    const options = opts.map((o) => {
      const { kind, alts, picks, chosen, price } = resolveItem(o.contains, prices, basis, priceOf);
      const perUnit = price != null && o.cost > 0 ? (price * o.count) / o.cost : null;
      return { ...o, kind, alts, picks, chosen, price, perUnit };
    });
    options.sort((a, b) => (b.perUnit ?? -Infinity) - (a.perUnit ?? -Infinity));
    const best = options.find((o) => o.perUnit != null) || null;
    const total = totals?.[currency] ?? null;
    const basket = total != null ? sealShopBasket(options, total) : null;
    out[currency] = { unit: best?.perUnit ?? null, best, options, total, basket };
  }
  return out;
}

// Best-value spend of a fixed coupon budget across one currency's redemptions (SPEC §16.10).
// Greedy bounded knapsack: buy the highest gold-per-coupon option first (perUnit order), up to
// its purchase limit (`stock`; null = unlimited) and what the budget affords, then the next.
// Optimal under divisibility and an excellent heuristic for the small integer coupon costs here.
// Unpriced options (perUnit null) are skipped, we can't value them. gold/buy = perUnit·cost.
// Returns { picks:[{ option, buys, coupons, gold }], gold, spent, left }.
export function sealShopBasket(options, total) {
  const budget = Number(total) || 0;
  let left = budget, gold = 0;
  const picks = [];
  const ranked = options.filter((o) => o.perUnit != null && o.cost > 0).slice().sort((a, b) => b.perUnit - a.perUnit);
  for (const o of ranked) {
    const affordable = Math.floor(left / o.cost);
    const buys = o.stock == null ? affordable : Math.min(affordable, o.stock);
    if (buys <= 0) continue;
    const coupons = buys * o.cost;
    const g = buys * o.perUnit * o.cost;
    picks.push({ option: o, buys, coupons, gold: g });
    left -= coupons;
    gold += g;
  }
  return { picks, gold, spent: budget - left, left };
}

// Optional per-currency coupon budget from the sheet's "Total Coupons" column (the total a
// player can earn/hold for that event currency). Soft-looked-up like "Contains"; the first
// non-blank cell per currency wins. Returns { currency: number }. Drives sealShopBasket.
export function sealShopTotals(rows) {
  if (!rows.length) return {};
  const hdr = rows[0].map((h) => h.trim());
  const ci = hdr.indexOf("Seal or Ticket");
  const ti = hdr.indexOf("Total Coupons");
  if (ci < 0 || ti < 0) return {};
  const out = {};
  for (let r = 1; r < rows.length; r++) {
    const currency = (rows[r][ci] || "").trim();
    if (!currency || currency in out) continue;
    const t = toInt(rows[r][ti]);
    if (t != null) out[currency] = t;
  }
  return out;
}

// Returns { sealShop, totals, source, liveError? }. Live-first (published gid), CSV snapshot
// fallback. Valuation is applied by the caller once prices have also loaded.
export async function loadSealShop() {
  const { rows, source, liveError } = await fetchSheetRows(SEAL_SHOP_CSV_URL, SEAL_SHOP_CSV_FALLBACK);
  return { sealShop: rowsToSealShop(rows), totals: sealShopTotals(rows), source, liveError };
}
