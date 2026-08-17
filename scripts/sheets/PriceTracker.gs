// ============================================================
//  PRICE HISTORY TRACKER v8 — Google Apps Script
//  Sheets:
//    PriceDump  → staging, Item | Min (auto-cleared after each run)
//    PriceLog   → append-only ledger, Date | Item | Min (never touch manually)
//    PriceInfo  → summary dashboard (auto-updated)
//    Config     → user-editable settings
//
//  Dates: one per row, the Eastern calendar day the screenshots were dumped.
//  There is no separate observation date — see _todayET / _dateKey.
//
//  Edited locally in the repo (scripts/sheets/) and deployed
//  with `npm run sheets:push` (clasp). Do not paste by hand.
//  Companion files: Sidebar.html (UI), PushTrigger.gs (GitHub push).
// ============================================================

const DUMP_SHEET   = "PriceDump";
const LOG_SHEET    = "PriceLog";
const INFO_SHEET   = "PriceInfo";
const CONFIG_SHEET = "Config";

// Every date in this project is an Eastern-time calendar day. Never build one
// from toISOString() or a bare Date object handed to a cell: the first is UTC,
// the second renders in the *spreadsheet's* timezone, which need not match the
// script's. Always go through _todayET() / _dateKey().
const TZ = "America/New_York";

// PriceDump column positions (1-based): Item | Min
// There is no date column — a screenshot is dated by the day it's uploaded.
const COL_ITEM = 1;
const COL_MIN  = 2;
const DUMP_COLS = 2;

// PriceDump idles at exactly this many rows (1 header + blanks). Pasting a dump
// taller than the grid makes Sheets add the rows it needs; every successful run
// snaps the grid back down. The size is the invariant that makes stray content
// impossible rather than merely detectable: there is no row 600 to survive in.
// Raise it if a paste is ever truncated instead of expanding the sheet — the
// "N rows logged" count in the summary is the tell.
const DUMP_IDLE_ROWS = 10;

// PriceLog column positions (0-based): Date | Item | Min
const LOG_DATE = 0;
const LOG_ITEM = 1;
const LOG_MIN  = 2;
const LOG_COLS = 3;

const INFO_COLS          = 8;
const INFO_TIMESTAMP_COL = 10; // column J


// ============================================================
//  CONFIG HELPERS
// ============================================================
function _getConfig() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const config = ss.getSheetByName(CONFIG_SHEET);
  const defaults = { stale: 14, neutralZone: 1, tierThreshold: 15, window: 5 };
  if (!config) return defaults;

  const data = config.getDataRange().getValues();
  const map  = {};
  for (let r = 1; r < data.length; r++) {
    map[String(data[r][0]).trim()] = data[r][1];
  }

  return {
    stale:         parseInt(map["Stale Threshold (days)"])  || defaults.stale,
    neutralZone:   parseFloat(map["Trend Neutral Zone (%)"])   || defaults.neutralZone,
    tierThreshold: parseFloat(map["Trend Tier Threshold (%)"]) || defaults.tierThreshold,
    window:        Math.max(1, parseInt(map["Price Window (snapshots)"]) || defaults.window),
  };
}


// ============================================================
//  MAIN
// ============================================================
function updateHistory() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const dump = ss.getSheetByName(DUMP_SHEET);
  const log  = ss.getSheetByName(LOG_SHEET);
  const info = ss.getSheetByName(INFO_SHEET);

  if (!dump || !log || !info) {
    SpreadsheetApp.getUi().alert(
      "Missing sheet(s): expected " + DUMP_SHEET + ", " + LOG_SHEET + ", and " + INFO_SHEET + "."
    );
    return;
  }

  const ui = SpreadsheetApp.getUi();

  if (dump.getLastRow() < 2) {
    _clearDump(dump); // nothing to log, but normalize the header and grid size
    ui.alert("Nothing in " + DUMP_SHEET + " to process.");
    return;
  }

  const dumpData = dump.getDataRange().getValues();

  // Audit the layout before touching anything. A dump is only ever supposed to
  // be a header plus one contiguous Item | Min block; anything else (a stray
  // row 600 down, a third column, a price with no name) gets named out loud
  // instead of being silently logged or silently swept away.
  const audit = _auditDump(dump, dumpData);
  const notes = audit.warnings.slice();

  // Row 1 is only worth mentioning when skipping it LOSES something. A blank row 1
  // is the normal state after a clear that didn't restore the header, or a paste at
  // A2 into a fresh sheet: nothing is dropped, and the run rewrites the header on
  // its way out. Only a row 1 carrying a real name — a paste that landed on A1 —
  // means a row is about to vanish, and that's worth stopping for.
  const headerCell = String(dumpData[0][0]).trim();
  if (headerCell && headerCell.toLowerCase() !== "item") {
    notes.push('Row 1 held "' + headerCell + '" instead of the "Item" header, so it was ' +
               "skipped. Re-paste that row if it was real data.");
  }

  if (audit.named.length === 0) {
    ui.alert("No item names found in " + DUMP_SHEET + ". Nothing logged, nothing cleared." +
             (notes.length ? "\n\n" + notes.join("\n\n") : ""));
    return;
  }

  // Any note at all means a row is about to be dropped or a stray one picked up.
  // Confirm rather than guess — this is the step that used to happen silently.
  if (notes.length > 0) {
    const go = ui.alert(
      DUMP_SHEET + " looks off",
      notes.join("\n\n") + "\n\nLog " + audit.named.length + " row(s) anyway?",
      ui.ButtonSet.YES_NO
    );
    if (go !== ui.Button.YES) {
      ui.alert("Cancelled. " + DUMP_SHEET + " left untouched.");
      return;
    }
  }

  // Build dupe fingerprint from existing PriceLog
  const logData    = log.getDataRange().getValues();
  const loggedKeys = new Set();
  for (let r = 1; r < logData.length; r++) {
    const row = logData[r];
    loggedKeys.add(_dupeKey(row[LOG_DATE], row[LOG_ITEM], row[LOG_MIN]));
  }

  // Process PriceDump rows. Every row in this batch is stamped with today's
  // Eastern date: the screenshots are assumed to be from the day they're dumped.
  const newRows = [];
  const today   = _todayET();
  let dupeCount = 0;

  for (let r = 1; r < dumpData.length; r++) {
    const row  = dumpData[r];
    const name = String(row[COL_ITEM - 1]).trim();
    const min  = parseFloat(row[COL_MIN - 1]) || 0;
    if (!name) continue;

    const key = _dupeKey(today, name, min);
    if (loggedKeys.has(key)) { dupeCount++; continue; }

    loggedKeys.add(key);
    newRows.push([today, name, min]);
  }

  // ── Append to PriceLog ────────────────────────────────────
  // PriceLog IS the app's price feed, so an append has to reach the repo. A script
  // write doesn't fire the onChange trigger, so queue the debounced push by hand
  // (PushTrigger.gs) — otherwise these rows never leave the sheet.
  if (newRows.length > 0) {
    log.getRange(log.getLastRow() + 1, 1, newRows.length, LOG_COLS).setValues(newRows);
    queuePushAfterScriptWrite();
  }

  // ── Clear PriceDump ───────────────────────────────────────
  // Unconditional, and verified: every row that made it past the audit is now
  // in PriceLog, so the dump must come back empty. Anything left is reported.
  const cleared = _clearDump(dump);

  // Detect existing items before rebuild
  const existingItems = _getExistingItems(ss);

  // Rebuild PriceInfo
  const cfg = _getConfig();
  const { items, outputRows, newItemRows, staleRows } =
    _buildOutputRows(log, existingItems, cfg);

  _writeInfoHeaders(info);
  if (outputRows.length > 0) {
    info.getRange(2, 1, outputRows.length, INFO_COLS).setValues(outputRows);
  }
  _applyInfoFormatting(info, outputRows.length, newItemRows, staleRows, cfg);
  _writeTimestamp(info);

  // Summary
  let msg = (cleared.ok ? "✓ Done!\n" : "⚠️ Logged, but " + DUMP_SHEET + " did not clear.\n") +
    newRows.length + " rows logged  |  " + items.length + " items in PriceInfo";
  if (dupeCount > 0)       msg += "\n⚠️ " + dupeCount + " duplicate row(s) skipped.";
  if (!cleared.ok)         msg += "\n\n❌ " + cleared.msg;
  if (cleared.note)        msg += "\n\n⚠️ " + cleared.note;
  if (notes.length > 0)    msg += "\n\n" + notes.join("\n");
  if (newItemRows.length > 0) msg += "\n\n🆕 " + newItemRows.length + " new item(s) highlighted in yellow.";
  if (staleRows.length > 0)   msg += "\n🕒 " + staleRows.length + " item(s) stale (>" + cfg.stale + " days).";

  ui.alert(msg);
}


// ============================================================
//  SIDEBAR
// ============================================================
function openSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("🪙 Coffer Chaser Tools");
  SpreadsheetApp.getUi().showSidebar(html);
}

function getItemNames() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const info = ss.getSheetByName(INFO_SHEET);
  if (!info || info.getLastRow() < 2) return [];
  return info.getRange(2, 1, info.getLastRow() - 1, 1)
             .getValues()
             .map(([n]) => String(n).trim())
             .filter(Boolean)
             .sort();
}

function removeItemByName(name) {
  name = name.trim();
  if (!name) return { ok: false, msg: "No item name provided." };

  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(LOG_SHEET);
  if (!log) return { ok: false, msg: "PriceLog sheet not found." };

  // Snapshot existing items before removal so yellow highlighting is preserved
  const existingItems = _getExistingItems(ss);
  existingItems.delete(name); // removed item shouldn't be in the set

  // Filter in memory and rewrite in one batch: deleteRow-per-match is one API
  // call per entry, which crawls once an item has real history.
  const logData = log.getDataRange().getValues();
  const header  = logData[0];
  const kept    = logData.slice(1).filter((row) => String(row[LOG_ITEM]).trim() !== name);
  const removed = logData.length - 1 - kept.length;

  if (removed === 0) return { ok: false, msg: "No entries found for \"" + name + "\"." };

  log.clearContents(); // keeps formatting + frozen rows
  log.getRange(1, 1, 1, header.length).setValues([header]);
  if (kept.length > 0) {
    log.getRange(2, 1, kept.length, header.length).setValues(kept);
  }

  updateHistory_silent(existingItems);
  queuePushAfterScriptWrite(); // script write: onChange won't see it (PushTrigger.gs)
  return { ok: true, msg: "Removed " + removed + " log entries for \"" + name + "\" and refreshed PriceInfo." };
}

function mergeItems(sourceName, targetName) {
  sourceName = sourceName.trim();
  targetName = targetName.trim();

  if (!sourceName || !targetName)
    return { ok: false, msg: "Both item names are required." };
  if (sourceName === targetName)
    return { ok: false, msg: "Source and target must be different items." };

  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(LOG_SHEET);
  if (!log) return { ok: false, msg: "PriceLog sheet not found." };

  // Snapshot existing items BEFORE the merge so yellow highlighting is preserved.
  // Source drops out of the snapshot: it's going away, target is the survivor.
  const existingItems = _getExistingItems(ss);
  existingItems.delete(sourceName);

  // Rename in memory, then write the whole Item column back in one call
  // (setValue per matched row is one API call per entry).
  const logData = log.getDataRange().getValues();
  let merged = 0;
  for (let r = 1; r < logData.length; r++) {
    if (String(logData[r][LOG_ITEM]).trim() === sourceName) {
      logData[r][LOG_ITEM] = targetName;
      merged++;
    }
  }

  if (merged === 0)
    return { ok: false, msg: "No entries found for \"" + sourceName + "\" in PriceLog." };

  log.getRange(2, LOG_ITEM + 1, logData.length - 1, 1)
     .setValues(logData.slice(1).map((row) => [row[LOG_ITEM]]));

  updateHistory_silent(existingItems);
  queuePushAfterScriptWrite(); // script write: onChange won't see it (PushTrigger.gs)
  return {
    ok: true,
    msg: "Merged " + merged + " entries from \"" + sourceName + "\" into \"" + targetName + "\" and refreshed PriceInfo."
  };
}


// ============================================================
//  SILENT REBUILD
// ============================================================
function updateHistory_silent(existingItems) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const log  = ss.getSheetByName(LOG_SHEET);
  const info = ss.getSheetByName(INFO_SHEET);
  if (!log || !info) return;

  const cfg = _getConfig();
  const { outputRows, newItemRows, staleRows } =
    _buildOutputRows(log, existingItems || new Set(), cfg);
  _writeInfoHeaders(info);
  if (outputRows.length > 0) {
    info.getRange(2, 1, outputRows.length, INFO_COLS).setValues(outputRows);
  }
  _applyInfoFormatting(info, outputRows.length, newItemRows, staleRows, cfg);
  _writeTimestamp(info);
}


// ============================================================
//  SHARED BUILD LOGIC
// ============================================================
function _buildOutputRows(log, existingItems, cfg) {
  const logData = log.getDataRange().getValues();
  const itemMap = {};

  for (let r = 1; r < logData.length; r++) {
    const row  = logData[r];
    const date = _dateKey(row[LOG_DATE]);
    const name = String(row[LOG_ITEM]).trim();
    const min  = parseFloat(row[LOG_MIN]);
    if (!name || !isFinite(min) || min <= 0) continue; // garbage/zero cell: skip, never average in
    if (!itemMap[name]) itemMap[name] = [];
    itemMap[name].push({ date, min });
  }

  for (const name in itemMap) {
    itemMap[name].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  const now         = new Date();
  const staleMs     = cfg.stale * 24 * 60 * 60 * 1000;
  const items       = Object.keys(itemMap).sort();
  const outputRows  = [];
  const newItemRows = [];
  const staleRows   = [];

  for (let i = 0; i < items.length; i++) {
    const name    = items[i];
    const entries = itemMap[name];
    const n       = entries.length;
    const latest  = entries[n - 1];
    // Windowed median, mirroring the app (js/prices.js): the cost basis is the
    // median of the last `window` snapshots (robust to lowballs, converges a few
    // uploads after a real regime change), and trend compares the latest min
    // against the median of the up-to-`window` snapshots BEFORE it.
    const rollMin = _median(entries.slice(-cfg.window).map(e => e.min));
    const prior   = entries.slice(-(cfg.window + 1), -1);
    const base    = prior.length ? _median(prior.map(e => e.min)) : 0;

    outputRows.push([
      name, n, latest.date,
      latest.min,
      rollMin,
      _trendLabel(latest.min, base),
      Math.max(...entries.map(e => e.min)),
      Math.min(...entries.map(e => e.min)),
    ]);

    if (existingItems.size > 0 && !existingItems.has(name)) newItemRows.push(i + 2);

    const latestDate = new Date(latest.date);
    if (!isNaN(latestDate) && (now - latestDate) > staleMs) staleRows.push(i + 2);
  }

  return { items, outputRows, newItemRows, staleRows };
}


// ============================================================
//  PRICEDUMP: HEADER, AUDIT, CLEAR
// ============================================================
// The header is written, not merely preserved. The old code kept row 1 by never
// touching it, which meant that once a paste landed on A1 the dump carried a
// data row as its "header" forever: skipped by the reader, skipped by the clear,
// invisible in every summary.
function _writeDumpHeader(dump) {
  dump.getRange(1, 1, 1, DUMP_COLS).setValues([["Item", "Min"]]);
  _styleHeader(dump, DUMP_COLS);
  if (dump.getFrozenRows() < 1) dump.setFrozenRows(1);
}

// Report anything about the dump's shape that a human would want to know before
// 600 rows of it get logged. Returns { warnings, named }, where `named` is the
// 1-based row numbers carrying an item name.
function _auditDump(dump, dumpData) {
  const warnings = [];

  const lastCol = dump.getLastColumn();
  if (lastCol > DUMP_COLS) {
    warnings.push("Content past column " + _colLetter(DUMP_COLS) + " — the sheet extends to " +
                  _colLetter(lastCol) + ". Only Item | Min is read; the rest is discarded.");
  }

  const named  = []; // rows with an item name
  const orphan = []; // rows holding something, but no name — never logged
  for (let r = 1; r < dumpData.length; r++) {
    const row = dumpData[r];
    if (String(row[COL_ITEM - 1]).trim()) { named.push(r + 1); continue; }
    if (row.some((c) => String(c).trim() !== "")) orphan.push(r + 1);
  }

  // A gap is the tell for content stranded far below the block you pasted.
  for (let i = 1; i < named.length; i++) {
    if (named[i] !== named[i - 1] + 1) {
      warnings.push("Gap: rows " + named[0] + "-" + named[i - 1] + " are contiguous, then " +
                    "content resumes at row " + named[i] + " (dump ends at row " +
                    named[named.length - 1] + ").");
      break;
    }
  }

  if (orphan.length > 0) {
    warnings.push(orphan.length + " row(s) hold a value but no item name, so nothing will be " +
                  "logged for them: " + _rowList(orphan) + ".");
  }

  return { warnings, named };
}

// Clear every row below the header across the FULL grid width, then verify.
// clearContent (not deleteRows) keeps the grid the size it is: deleting rows
// shrank PriceDump a little on every run, and once it was down to one row the
// old clear threw out of bounds — into a catch that only wrote to the log.
function _clearDump(dump) {
  try {
    const maxRows = dump.getMaxRows();
    const maxCols = dump.getMaxColumns();
    if (maxRows > 1) dump.getRange(2, 1, maxRows - 1, maxCols).clearContent();
    _writeDumpHeader(dump);
    SpreadsheetApp.flush();
  } catch (e) {
    return { ok: false, msg: "Clear threw: " + (e.message || e) };
  }

  const left = dump.getLastRow();
  if (left > 1) {
    // Deliberately no trim here: something unlogged is still down there and
    // resizing the grid would delete it before it could be looked at.
    return { ok: false, msg: DUMP_SHEET + " still has content down at row " + left +
                            " after clearing. Check that row." };
  }

  // Verified empty — safe to snap the grid back to its idle size.
  try {
    _resizeDump(dump);
  } catch (e) {
    return { ok: true, msg: "", note: "Cleared, but resizing to " + DUMP_IDLE_ROWS +
                                      " rows failed: " + (e.message || e) };
  }
  return { ok: true, msg: "" };
}

// Pin the grid to DUMP_IDLE_ROWS. Grows as well as shrinks, so a sheet the old
// deleteRows-based clear had whittled down to one row heals on the next run.
function _resizeDump(dump) {
  const rows = dump.getMaxRows();
  if (rows > DUMP_IDLE_ROWS) dump.deleteRows(DUMP_IDLE_ROWS + 1, rows - DUMP_IDLE_ROWS);
  else if (rows < DUMP_IDLE_ROWS) dump.insertRowsAfter(rows, DUMP_IDLE_ROWS - rows);
}

function _rowList(rows) {
  const shown = rows.slice(0, 8).join(", ");
  return rows.length > 8 ? shown + ", … (+" + (rows.length - 8) + " more)" : shown;
}

function _colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}


// ============================================================
//  HELPERS
// ============================================================
// Current PriceInfo item names, used to flag NEW items (yellow rows) after a rebuild.
function _getExistingItems(ss) {
  const info  = ss.getSheetByName(INFO_SHEET);
  const items = new Set();
  if (info && info.getLastRow() > 1) {
    info.getRange(2, 1, info.getLastRow() - 1, 1).getValues()
        .forEach(([n]) => { if (n) items.add(String(n).trim()); });
  }
  return items;
}

// Today's Eastern calendar day as "yyyy-MM-dd". This is the only date the log
// carries: PriceLog rows are stamped with the day their screenshots were dumped.
function _todayET() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

let _ssTz = null;
function _sheetTZ() {
  if (!_ssTz) _ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return _ssTz;
}

// Normalize whatever a date cell holds to a "yyyy-MM-dd" key.
//
// Rows written by _todayET() are already ET "yyyy-MM-dd" text and fall through
// the string branch untouched. The Date branch is for cells edited by hand:
// type a date into one and Sheets stores a real Date. Those are formatted in the
// SPREADSHEET's timezone, not ET — a date cell is a wall-clock day in the
// spreadsheet's zone, so that's the only zone that reproduces the day shown in
// the cell. Formatting one in ET, or worse UTC via toISOString, can shift it a
// day when the two zones disagree.
function _dateKey(date) {
  if (date instanceof Date) return Utilities.formatDate(date, _sheetTZ(), "yyyy-MM-dd");
  return String(date).trim().slice(0, 10);
}

function _dupeKey(date, name, min) {
  return _dateKey(date) + "|" + String(name).trim() + "|" + min;
}

function _median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function _trendLabel(current, rollingAvg) {
  if (rollingAvg === 0) return "";
  return Math.round(((current - rollingAvg) / rollingAvg) * 1000) / 10;
}

/** Returns a background colour for a trend cell based on % change and config thresholds.
 *  Down = good (cheap). Up = bad (expensive).
 *  Tiers (using cfg.neutralZone N and cfg.tierThreshold T):
 *    pct < -T  → blue       (very cheap)
 *    -T to -N  → light green (cheap)
 *    -N to +N  → white      (neutral)
 *    +N to +T  → light red  (expensive)
 *    pct > +T  → dark red   (very expensive)
 */
function _trendColor(pct, cfg) {
  if (pct === "" || pct === null) return "#FFFFFF";
  const N = cfg.neutralZone;
  const T = cfg.tierThreshold;
  if (pct < -T)  return "#1B5E20"; // dark green — very cheap
  if (pct < -N)  return "#C8E6C9"; // light green — cheap
  if (pct <= N)  return "#FFFFFF"; // white — neutral
  if (pct <= T)  return "#FFCDD2"; // light red — expensive
  return "#B71C1C";                // dark red — very expensive
}

function _trendFontColor(pct, cfg) {
  if (pct === "" || pct === null) return "#000000";
  return (pct < -cfg.tierThreshold || pct > cfg.tierThreshold) ? "#FFFFFF" : "#000000";
}

function _styleHeader(sheet, numCols) {
  const r = sheet.getRange(1, 1, 1, numCols);
  r.setFontWeight("bold");
  r.setBackground("#263238");
  r.setFontColor("#FFFFFF");
}

function _writeInfoHeaders(sheet) {
  sheet.clearContents();
  sheet.clearFormats();
  const headers = [
    "Item", "# Snapshots", "Latest Date",
    "Latest Min",
    "Rolling Avg (Min)",
    "Min Trend",
    "ATH Min", "ATL Min",
  ];
  const r = sheet.getRange(1, 1, 1, headers.length);
  r.setValues([headers]);
  _styleHeader(sheet, headers.length);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
}

function _writeTimestamp(sheet) {
  const labelCell = sheet.getRange(1, INFO_TIMESTAMP_COL);
  const valueCell = sheet.getRange(2, INFO_TIMESTAMP_COL);
  labelCell.setValue("Last Updated");
  labelCell.setFontWeight("bold");
  labelCell.setBackground("#263238");
  labelCell.setFontColor("#FFFFFF");
  // Written as text, not a Date: a Date cell renders in the spreadsheet's
  // timezone, which is not necessarily Eastern.
  valueCell.setNumberFormat("@");
  valueCell.setValue(Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") + " ET");
}

function _applyInfoFormatting(sheet, numRows, newItemRows, staleRows, cfg) {
  if (numRows === 0) return;

  // ── Number formats ────────────────────────────────────────
  // Price cols: Latest Min (4), Rolling Avg Min (5), ATH Min (7), ATL Min (8)
  for (const c of [4, 5, 7, 8]) {
    sheet.getRange(2, c, numRows, 1).setNumberFormat('#,##0');
  }
  // Trend col: Min Trend (6)
  sheet.getRange(2, 6, numRows, 1).setNumberFormat('0.0"%"');

  // ── Build full background + font colour arrays in one pass ──
  const bgs   = Array.from({ length: numRows }, () => Array(INFO_COLS).fill("#FFFFFF"));
  const fonts = Array.from({ length: numRows }, () => Array(INFO_COLS).fill("#000000"));

  // Read trend values once — Min Trend is col 6 (0-indexed: 5)
  const minTrends = sheet.getRange(2, 6, numRows, 1).getValues();

  const newItemSet = new Set(newItemRows);
  const staleSet   = new Set(staleRows);

  for (let i = 0; i < numRows; i++) {
    const rowIdx = i + 2;

    // Min Trend colour (col 6, 0-indexed as 5)
    const minPct = minTrends[i][0];
    bgs[i][5]   = _trendColor(minPct, cfg);
    fonts[i][5] = _trendFontColor(minPct, cfg);

    // New item — yellow full row
    if (newItemSet.has(rowIdx)) {
      for (let c = 0; c < INFO_COLS; c++) bgs[i][c] = "#FFF9C4";
    }

    // Stale — grey full row (overrides everything)
    if (staleSet.has(rowIdx)) {
      for (let c = 0; c < INFO_COLS; c++) {
        bgs[i][c]   = "#E0E0E0";
        fonts[i][c] = "#9E9E9E";
      }
    }
  }

  // ── Two API calls for the entire sheet ───────────────────
  sheet.getRange(2, 1, numRows, INFO_COLS).setBackgrounds(bgs);
  sheet.getRange(2, 1, numRows, INFO_COLS).setFontColors(fonts);
}


// ============================================================
//  REBUILD PRICEINFO — rebuilds from PriceLog without touching PriceDump
// ============================================================
function rebuildPriceInfo() {
  updateHistory_silent();
  SpreadsheetApp.getUi().alert("✓ PriceInfo rebuilt from PriceLog.");
}


// ============================================================
//  CLEAR PRICEDUMP — manual fallback; discards rows without logging them
// ============================================================
function clearPriceDump() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const ui   = SpreadsheetApp.getUi();
  const dump = ss.getSheetByName(DUMP_SHEET);
  if (!dump) { ui.alert(DUMP_SHEET + " sheet not found."); return; }

  const lastRow = dump.getLastRow();
  if (lastRow <= 1) {
    _writeDumpHeader(dump);
    ui.alert(DUMP_SHEET + " is already empty.");
    return;
  }

  // This throws data away without logging it, so say how much and how far down.
  const go = ui.alert(
    "Clear " + DUMP_SHEET + "?",
    "Rows 2-" + lastRow + " will be discarded without being logged to " + LOG_SHEET + ".",
    ui.ButtonSet.YES_NO
  );
  if (go !== ui.Button.YES) return;

  const cleared = _clearDump(dump);
  ui.alert(cleared.ok ? "✓ " + DUMP_SHEET + " cleared." : "Clear failed: " + cleared.msg);
}


// ============================================================
//  CUSTOM MENU
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🪙 Coffer Chaser")
    .addItem("Update History", "updateHistory")
    .addItem("Rebuild PriceInfo", "rebuildPriceInfo")
    .addItem("Sidebar Tools", "openSidebar")
    .addSeparator()
    .addItem("Push to Site", "pushToSiteMenu")
    .addItem("Clear PriceDump", "clearPriceDump")
    .addToUi();
}