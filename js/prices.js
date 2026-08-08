// Price feed loader (SPEC §5.1): raw PriceLog snapshot (Date | Item | Min, one row
// per observed marketplace snapshot) → price map keyed by exact item name:
//   prices[name] = { min, avg, date, trend, ath, atl, snapshots }
// Stats are computed HERE, not in the Sheet. `avg` (the cost basis) is the median
// of the last PRICE_WINDOW snapshots: robust to lowball listings, and it re-converges
// a few uploads after a game update genuinely moves a price. `trend` compares the
// latest min against the median of the up-to-PRICE_WINDOW snapshots BEFORE it, so it
// reads as short-horizon movement, not distance from an all-time mean.

import { PRICE_CSV_URL, PRICE_CSV_FALLBACK, PRICE_COLUMNS, PRICE_WINDOW } from "./config.js";
import { fetchSheetRows, headerIndex, toInt, toIsoDate } from "./sheet.js";

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function logToPrices(rows, window = PRICE_WINDOW) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], PRICE_COLUMNS);
  const byItem = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    const min = toInt(row[idx.min]);
    if (min == null || min <= 0) continue; // garbage/zero cell: skip, never average in
    const date = toIsoDate(row[idx.date]);
    let entries = byItem.get(name);
    if (!entries) byItem.set(name, (entries = []));
    entries.push({ date, min });
  }

  const prices = {};
  for (const [name, entries] of byItem) {
    // Stable sort: same-date rows keep log (upload) order, so "latest" is well defined
    // even though dates are stamped by upload day.
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const latest = entries[entries.length - 1];
    const win = entries.slice(-window).map((e) => e.min);
    const prior = entries.slice(-(window + 1), -1).map((e) => e.min);
    let ath = entries[0].min, atl = entries[0].min;
    for (const e of entries) {
      if (e.min > ath) ath = e.min;
      if (e.min < atl) atl = e.min;
    }
    const base = prior.length ? median(prior) : null;
    prices[name] = {
      min: latest.min,
      avg: Math.round(median(win)),
      date: latest.date,
      trend: base ? Math.round(((latest.min - base) / base) * 1000) / 10 : null,
      ath,
      atl,
      snapshots: entries.length,
    };
  }
  return prices;
}

// Returns { prices, source, liveError? }.
export async function loadPrices() {
  const { rows, source, liveError } = await fetchSheetRows(PRICE_CSV_URL, PRICE_CSV_FALLBACK);
  return { prices: logToPrices(rows), source, liveError };
}
