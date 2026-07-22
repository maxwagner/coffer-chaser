// Shared Google-Sheet CSV plumbing used by every data loader (prices, enchants,
// and later items/recipes/tier tables). The whole document is published to web,
// so each tab is just a gid on the same base URL.

// ── CSV parsing ──────────────────────────────────────────────────────────────
// Minimal RFC-4180 parser: quoted fields, embedded commas, escaped quotes (""),
// CRLF/LF. The sheet quotes its numbers ("555,800"), so split-on-comma corrupts.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c === "\r") { /* swallow */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// "555,800" → 555800 ; "-8" → -8 ; "" / "—" → null
// Strips grouping separators but preserves a leading minus sign — several stat
// columns (Bal, Att Spd, the comparison "Change" block) are legitimately
// negative, and dropping the sign silently flips them positive.
export function toInt(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const neg = /^-/.test(s);
  const digits = s.replace(/[^\d]/g, "");
  if (!digits.length) return null;
  return (neg ? -1 : 1) * parseInt(digits, 10);
}

// "6/13/2026" → "2026-06-13" (leaves already-ISO or unknown formats untouched)
export function toIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

// Map a header-name → column-index lookup over the first `width` columns only.
// Some tabs (Enchants) repeat header names in later analysis blocks; capping the
// width to the app-relevant columns keeps those duplicates from interfering.
export function headerIndex(headerRow, names, width = headerRow.length) {
  const hdr = headerRow.slice(0, width).map((h) => h.trim());
  const idx = {};
  const missing = [];
  for (const [key, col] of Object.entries(names)) {
    const i = hdr.indexOf(col);
    if (i === -1) missing.push(`${key} ("${col}")`);
    idx[key] = i;
  }
  if (missing.length) throw new Error(`Sheet missing column(s): ${missing.join(", ")}`);
  return idx;
}

// How long to wait on a live Sheet fetch before giving up and using the snapshot.
// The published-CSV endpoint can STALL (not error) — slow/rate-limited/hung — and a
// bare `await fetch` would then never resolve, hanging the whole boot (loaders run in
// one Promise.all, so one stuck tab blocks the app forever). Abort past this and fall
// back to the committed data/*.csv snapshot instead.
const LIVE_FETCH_TIMEOUT_MS = 8000;

// Fetch a tab's CSV rows, falling back to a committed snapshot when the live
// fetch fails, times out, or is offline. Returns { rows, source, liveError }.
export async function fetchSheetRows(liveUrl, fallbackPath) {
  try {
    if (!liveUrl) throw new Error("no live URL (snapshot-only tab)");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIVE_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(liveUrl, { cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { rows: parseCsv(await res.text()), source: "live" };
  } catch (liveError) {
    const reason = liveError?.name === "AbortError" ? `timed out after ${LIVE_FETCH_TIMEOUT_MS}ms` : String(liveError);
    const res = await fetch(fallbackPath);
    if (!res.ok) throw new Error(`Live: ${reason}. Fallback: HTTP ${res.status}.`);
    return { rows: parseCsv(await res.text()), source: "fallback", liveError: reason };
  }
}
