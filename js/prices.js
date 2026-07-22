// Price feed loader: published Google Sheet CSV → price map keyed by exact item
// name (SPEC §5.1):  prices[name] = { date, avg, min }.
// The cost model uses `.min`; `.avg` and `.date` are informational.

import { PRICE_CSV_URL, PRICE_CSV_FALLBACK, PRICE_COLUMNS } from "./config.js";
import { fetchSheetRows, headerIndex, toInt, toIsoDate } from "./sheet.js";

export function rowsToPrices(rows) {
  if (!rows.length) return {};
  const idx = headerIndex(rows[0], PRICE_COLUMNS);
  const prices = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[idx.name] || "").trim();
    if (!name) continue;
    const min = toInt(row[idx.min]);
    if (min == null) continue; // no usable price → not a real listing
    const trendRaw = (row[idx.trend] || "").trim();      // e.g. "10.9%" / "-8.7%"
    const trend = trendRaw ? parseFloat(trendRaw) : null; // percent, signed
    prices[name] = {
      min,
      avg: toInt(row[idx.avg]) ?? min,
      date: toIsoDate(row[idx.date]),
      trend: Number.isNaN(trend) ? null : trend,
      ath: toInt(row[idx.ath]),
      atl: toInt(row[idx.atl]),
      snapshots: toInt(row[idx.snapshots]),
    };
  }
  return prices;
}

// Returns { prices, source, liveError? }.
export async function loadPrices() {
  const { rows, source, liveError } = await fetchSheetRows(PRICE_CSV_URL, PRICE_CSV_FALLBACK);
  return { prices: rowsToPrices(rows), source, liveError };
}
