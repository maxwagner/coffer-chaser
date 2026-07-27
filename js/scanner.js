// In-browser OCR auction scanner. PURE parsing layer (SPEC §16). Reads auction-house
// screenshots' OCR output, extracts (item name, min price) rows, and accumulates them into a
// summary the user copies as TSV to paste into the PriceInfo Sheet tab.
//
// The OCR ENGINE is PP-OCRv4 (PaddleOCR on onnxruntime-web/WebAssembly), orchestrated in
// js/ppocr.js (DOM + the self-hosted vendored bundle). This file is the pure
// post-processing: parsePriceGroups/toPrice/cleanName/editDistance/
// makeCanonicalizer/repairName/ppDetectionsToWords/parseDetections + the price store. Keeping it
// engine-agnostic (it consumes generic word boxes) is why swapping Tesseract → PP-OCR touched
// only js/ppocr.js and the adapter here, not the row/name logic.

// price token parsing

// Price-context letter→digit corrections. A price-column token is *known* numeric,
// so any letter is an OCR misread and is mapped aggressively (applied only to tokens
// already classified as prices).
const PRICE_DIGIT_MAP = {
  o: "0", O: "0", D: "0", Q: "0", U: "0",
  l: "1", I: "1", i: "1", "!": "1", "|": "1", "[": "1", "]": "1", L: "1",
  z: "2", Z: "2",
  E: "3",
  A: "4",
  s: "5", S: "5",
  b: "6", G: "6",
  T: "7", "?": "7",
  B: "8",
  g: "9", q: "9",
};
const translatePrice = (s) => s.replace(/[\s\S]/g, (c) => PRICE_DIGIT_MAP[c] ?? c);

const SEP_RE = /[,.\s]+/;

// The auction house caps a listing at 999,999,999. Anything larger is an OCR artifact,
// usually two vertically-adjacent thin repeated-digit prices ("77,777,777" over "11,111,111")
// read as one over-long token ("7,177,717,717"). Reject it so we never record the garbage
// magnitude; strict callers re-OCR, lenient callers drop the price (the row then surfaces).
const MAX_PRICE = 999_999_999;

// Parse a price string into { value, well }. Auction prices always group as
// N,NNN,NNN, first group 1–3 digits, every following group exactly 3. `well`
// reports whether the read matches that structure; a malformed read (a letter in a
// group, or a wrong-length group) means a digit was dropped/garbled and the value is
// unreliable. { value: null } when there are no usable digit groups.
export function parsePriceGroups(t) {
  const groups = t.split(SEP_RE).filter(Boolean);
  if (!groups.length || !groups.every((g) => /^\d+$/.test(g))) return { value: null, well: false };
  const value = parseInt(groups.join(""), 10);
  if (groups.length === 1) return { value, well: true }; // no separators → no grouping evidence
  const well = groups[0].length >= 1 && groups[0].length <= 3 && groups.slice(1).every((g) => g.length === 3);
  return { value, well };
}

// Convert an OCR price token to an int, or null. With strict=true, structurally
// malformed reads AND values < 1000 are rejected so the caller can re-OCR instead of
// recording a wrong magnitude (a thin repeated-digit price whose leading group is
// dropped reads as a small well-formed number). The lenient pass keeps any value ≥ 1.
export function toPrice(token, strict = false) {
  const t = translatePrice(token.trim().replace(/^[$'"]+/, ""));
  const { value, well } = parsePriceGroups(t);
  if (value == null || value < 1) return null;
  if (value > MAX_PRICE) return null; // over-long read (merged/garbled). Never a real price
  if (strict && (!well || value < 1000)) return null;
  return value;
}

// name cleaning

// Junk tokens: roman numerals / stack counts, short bare numbers (level/qty),
// tier/level column tokens (T0, I5, l5…), stars + their OCR misreads (kk wk wae…),
// stray punctuation, lone lowercase letters.
const JUNK = /^(?:[IVX]{1,4}|[ivxl]{1,4}|\d{1,3}|[A-Za-z]\d{1,3}[A-Za-z]*|\d{1,3}[A-Za-z]+|[★✦✧✪*•·|⭐¥\-–—~,\\/'`;.:]+|[★☆✦✧⭐]+|[+*wxikKW¥]{0,2}[kK]|[+*×xX]{1,4}|(?:w[ae]{1,3}|n?[kK][ae]{1,3}|r[oe]+)|[a-z])$/;

// Level/quality column token: a short integer or roman numeral. Its presence marks a
// row as a real item line (vs a wrapped name continuation, which has neither level nor price).
const LEVEL_RE = /^(?:\d{1,3}|[IVXivxl]{1,4})$/;
const LEAD_NOISE = /^[^A-Za-z0-9]+/;
// The "(Permanent)" variant tag, stripped so a permanent listing conflates onto its base scroll
// (the min of base vs pricier-permanent is the correct base price. SPEC §16.5). OCR mangles the
// tag on these dim second-line rows ("(Pe manent)", "(Pemanent)", a dropped paren), so match it
// fuzzily: an optional paren, "Pe", any run of spaces/"r", then the stable "manent" tail. No real
// item name contains "…manent", so this can't over-strip.
const PERM_TAG = /\s*\(?\s*pe[\sr]*manent\)?\s*/gi;
// Non-global detector for the (fuzzy) "(Permanent)" tag, flags a row as a permanent variant
// BEFORE PERM_TAG strips it, so the caller can drop an unidentifiable permanent duplicate (its
// base row is always captured separately and is cheaper, so it wins the min anyway).
const PERM_DETECT = /\(?\s*pe[\sr]*manent/i;
const GRADE_WORDS = new Set(["grade", "level", "tier", "rank"]);
// Small real words that legitimately appear in names, never trimmed as edge noise.
const SHORT_WORDS = new Set(["of", "to", "a", "an"]);
// An edge token is OCR noise if it's ≤2 chars, contains a letter (so pure grade digits
// like "1" stay), and isn't a small real word.
const isEdgeNoise = (t) => t.length <= 2 && /[A-Za-z]/.test(t) && !SHORT_WORDS.has(t.toLowerCase());

// Strip leading/trailing punctuation but keep colon (part of "Title:") and an opening paren.
const STRIP_PUNCT = /^[^\w(]+|[^\w):]+$/g;
const SOLO = { "[": "1", l: "1", I: "1", "!": "1", "|": "1", "}": "3", "{": "3" };

// Hard-coded corrections for names EasyOCR/Tesseract misread *consistently* and that
// can't be fixed generically (the "+" suffix read as "t"; a dropped possessive with no
// marker left to recover it; a thin grade "1" glyph never detected). Keyed by the final
// cleaned name; value is the truth.
const NAME_FIXES = {
  "Goibhniu's Stonet": "Goibhniu's Stone+",
  "Semias Essence": "Semias' Essence",
  "Mysterious Shard Grade": "Mysterious Shard Grade 1",
};

const HEADER_WORDS = new Set(["item", "level", "quality", "price", "listings"]);

// High-contrast outlined game text (the dim/colored rarity rows: green "Smooth/Solid/Keen…"
// crystals & chunks) is detected TWICE by Tesseract, the full word plus an edge-clipped
// "ghost" copy, interleaved as "Solid olid", "Crystal Crysta", "Keen een", "Moonli Moonlight".
// Two adjacent tokens are ghosts of each other when, case-insensitively, the shorter is a prefix
// OR suffix of the longer (the clipped edge) AND it's the SAME word truncated: either ≤2 chars
// were shaved, or the shorter still covers ≥60% of the longer (catches deeper clips like
// "Moonli"/"Moonlight"). Collapse to the fuller read. Real item names never place a word next to
// its own truncation, and the floors (≥3 chars, ≥60% for deep clips) protect small/short words.
function ghostPair(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la === lb) return true;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  if (short.length < 3) return false;
  const ratioOk = short.length >= 4 && short.length / long.length >= 0.6;
  // Exact edge clip: the shorter IS a prefix/suffix of the longer ("Crystal"/"Crysta", "Solid"/"olid").
  if (long.startsWith(short) || long.endsWith(short)) return long.length - short.length <= 2 || ratioOk;
  // Fuzzy edge clip: the shorter is within ONE char of a same-length edge slice of the longer, the
  // same word doubled where the full copy is ALSO garbled ("Niflh" vs "Hiflheim": "Niflh" is 1 edit
  // from "Hiflh", the leading 5 of "Hiflheim"). Keep the fuller token; the canonicalizer snaps the
  // residual single-char error. Tightly bounded (≥4 chars, ≥60% length, ≤1 edit) to avoid real words.
  if (ratioOk) {
    const k = short.length;
    if (editDistance(short, long.slice(0, k), 1) <= 1 || editDistance(short, long.slice(long.length - k), 1) <= 1) return true;
  }
  return false;
}
function dedupeGhostTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && ghostPair(prev, t)) { if (t.length > prev.length) out[out.length - 1] = t; continue; }
    out.push(t);
  }
  return out;
}

export function cleanName(raw) {
  // EasyOCR/Tesseract misread apostrophe+s as an optional quote then a bare "$".
  raw = raw.replace(/(?<=\w)["']*\s*\$/g, "'s");
  // The "$" is sometimes itself misread as a lone "5"/"S" ("Watcher' 5 …"). Only fire
  // when a quote precedes it (so grade/quantity numbers survive) and it's standalone.
  raw = raw.replace(/(?<=\w)["']+\s*[5S]\b/g, "'s");
  let tokens = raw.trim().split(/\s+/).filter(Boolean);
  // Normalize a trailing OCR double-quote to an apostrophe so the possessive survives.
  tokens = tokens.map((t) => t.replace(/(?<=\w)"$/, "'"));
  // Standalone grade digits misread as punctuation/letters, convert before strip/junk.
  tokens = tokens.map((t) => SOLO[t] ?? t);
  // Strip leading/trailing punctuation, preserving a trailing possessive apostrophe.
  const stripped = [];
  for (const t of tokens) {
    if (/\w'$/.test(t)) {
      const core = t.slice(0, -1).replace(STRIP_PUNCT, "");
      stripped.push(core ? core + "'" : "");
    } else stripped.push(t.replace(STRIP_PUNCT, ""));
  }
  const kept = [];
  for (let t of stripped) {
    if (!t) continue;
    // Fix doubled initial capital ("VValor" → "Valor").
    t = t.replace(/^([A-Z])\1(?=[a-z])/, "$1");
    if (JUNK.test(t)) {
      // Keep a digit grade/tier suffix directly after a grade word ("Grade 1").
      if (/^\d{1,3}$/.test(t) && kept.length && GRADE_WORDS.has(kept[kept.length - 1].toLowerCase())) kept.push(t);
    } else kept.push(t);
  }
  // Collapse OCR ghost-duplicates ("Solid olid Eriu Eriu Crystal Crysta" → "Solid Eriu Crystal")
  // before the edge trims, so a leading ghost ("olid Solid…") doesn't survive as edge noise.
  const deghosted = dedupeGhostTokens(kept);
  kept.length = 0; kept.push(...deghosted);
  // Trim short OCR-noise fragments that bled in from the level/price column at the NAME
  // EDGES (e.g. "...Rhod Compass ns", "Shrouded Moonlight iT", "ee reir Royal Castle").
  // Edge-only + ≤2 chars + must contain a letter (so a kept grade digit like "Grade 1"
  // is protected) + never a small real word ("of"/"to"). Mid-name tokens are untouched,
  // so "Roots of Abundance" survives. Trim repeatedly in case two fragments stack.
  while (kept.length > 1 && isEdgeNoise(kept[kept.length - 1])) kept.pop();
  while (kept.length > 1 && isEdgeNoise(kept[0])) kept.shift();
  let name = kept.join(" ").trim();
  name = name.replace(LEAD_NOISE, "").trim();
  name = name.replace(PERM_TAG, "").trim();
  return NAME_FIXES[name] ?? name;
}

// canonicalization against the app's known item names

const CANON_THRESHOLD = 0.88; // min similarity ratio to accept a fuzzy snap
const CANON_MARGIN = 0.05;    // best must beat the runner-up by this, else ambiguous
const CANON_MAX_EDITS = 2;    // absolute char edits allowed (blocks whole-word swaps)

// Levenshtein distance, short-circuiting once it exceeds cap.
export function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// LCS-based similarity ratio (2·LCS / (|a|+|b|)). A faithful stand-in for Python's
// difflib SequenceMatcher.ratio() for our purpose, since the absolute edit-distance
// cap below is the decisive guard anyway.
function ratio(a, b) {
  const la = a.length, lb = b.length;
  if (!la && !lb) return 1;
  if (!la || !lb) return 0;
  let prev = new Array(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1).fill(0);
    for (let j = 1; j <= lb; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[lb]) / (la + lb);
}

// Build a canonicalizer over a list of known names. A cleaned OCR name is snapped to
// the closest known item only when the match is both strong and unambiguous *and* the
// absolute edit distance is small, so common misses (dropped apostrophe, a thin grade
// digit, minor garble) are corrected while genuinely new items, and ambiguous body-part
// swaps like "Chest Armor" vs "Hand Armor", pass through unchanged. The edit-distance cap
// is the critical guard: a long name with one wrong word scores a high ratio off its
// shared prefix but differs by ~5 edits, far more than a dropped apostrophe (1–2).
const PREFIX_MIN_TOKENS = 3; // a prefix this long is enough to identify an item

// Normalize OCR spacing so a spacing garble becomes an EXACT match: split a merged
// camelCase word ("WakingStone" → "Waking Stone") and put a space after ":"/"," and
// around "(". OCR routinely drops these in structured names like
// "Waking Stone:Damage Boost(8%)". Idempotent on already-clean names.
export function normSpace(s) {
  return String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([:,])(?=\S)/g, "$1 ")
    .replace(/(\S)\(/g, "$1 (")
    .replace(/\)(?=\S)/g, ") ")
    .replace(/([A-Za-z])\+/g, "$1 +") // "DMG+8%" → "DMG +8%"
    .replace(/(?<=\d)[oO]/g, "0").replace(/[oO](?=\d)/g, "0") // digit-adjacent o/O is a misread 0: "(6o)" → "(60)"
    .replace(/%{2,}/g, "%")           // OCR doubled percent: "(8%%)" → "(8%)"
    .replace(/\s+/g, " ")
    .trim();
}

// The digit-runs in a name, sorted, the identity of a numeric-variant family (Waking
// Stone "(8%)" vs "(10%)", "(4 sec)" vs "(5 sec)", grade tiers). A fuzzy snap must NOT
// bridge a number difference: those are DISTINCT items, so a 1-digit gap is not a typo.
const numsOf = (s) => (String(s).toLowerCase().match(/\d+/g) || []).sort();
const sameNums = (a, b) => { const x = numsOf(a), y = numsOf(b); return x.length === y.length && x.every((v, i) => v === y[i]); };

export function makeCanonicalizer(names) {
  const list = [...new Set((names || []).filter(Boolean).map((n) => String(n).trim()).filter(Boolean))];
  const entries = list.map((n) => { const norm = normSpace(n).toLowerCase(); return { name: n, norm, toks: norm.split(/\s+/) }; });
  const lookup = new Map(entries.map((e) => [e.norm, e.name]));
  return function canonicalize(name) {
    if (!list.length || !name) return name;
    const norm = normSpace(name); // clean OCR spacing (case preserved); returned as-is when nothing snaps
    const key = norm.toLowerCase();
    const exact = lookup.get(key);
    if (exact) return exact; // fixes casing + OCR spacing
    let best = null, bestNorm = "", bestR = 0, secondR = 0;
    for (const e of entries) {
      const c = e.norm;
      // LCS ≤ min(len) → cheap upper bound on the ratio; skip when it can't beat runner-up.
      const upper = (2 * Math.min(c.length, key.length)) / (c.length + key.length);
      if (upper <= secondR) continue;
      const r = ratio(c, key);
      if (r > bestR) { best = e.name; bestNorm = c; secondR = bestR; bestR = r; }
      else if (r > secondR) secondR = r;
    }
    if (best && bestR >= CANON_THRESHOLD && (bestR - secondR) >= CANON_MARGIN &&
        editDistance(key, bestNorm, CANON_MAX_EDITS) <= CANON_MAX_EDITS && sameNums(key, bestNorm)) return best;

    // Unique long-prefix fallback: the read shares a long leading run of tokens with exactly ONE
    // vocab item, and only its TAIL diverges. OCR garbled the last word(s) ("The Watcher's
    // Mysterious Cat Jos tatue" → "…Cat Statue"). This is safe against sibling mis-snaps that the
    // edit-cap guards (Chest≠Hand Armor): those differ WITHIN the prefix, so no single vocab item
    // owns the matched prefix uniquely. Require ≥3 shared tokens, a strictly-unique best prefix,
    // and that the prefix covers ≥ half the matched item's tokens.
    const qToks = key.split(/\s+/);
    if (qToks.length >= PREFIX_MIN_TOKENS) {
      let pBest = null, p1 = 0, p2 = 0;
      for (const t of entries) {
        let p = 0;
        const lim = Math.min(qToks.length, t.toks.length);
        while (p < lim && qToks[p] === t.toks[p]) p++;
        if (p > p1) { p2 = p1; p1 = p; pBest = t; }
        else if (p > p2) p2 = p;
      }
      if (pBest && p1 >= PREFIX_MIN_TOKENS && p1 > p2 && p1 >= Math.ceil(0.5 * pBest.toks.length) && sameNums(key, pBest.norm)) return pBest.name;
    }

    // Unique-suffix fallback (clipped PREFIX): a detection box that starts a few px late clips the
    // first letter(s), so the read is a character-SUFFIX of the true name ("ecuting Enchant Scroll"
    // ← "Ex" lost). Edit-distance can't disambiguate, "ecuting" is 2 edits from BOTH "Echoing" and
    // "Executing", but the read is a suffix of only ONE ("executing"), which resolves it. Snap when
    // exactly one vocab item ends with the read AND the read covers ≥ half of it (so a bare
    // "…Enchant Scroll" suffix, shared by many, isn't unique → won't match; a genuinely ambiguous
    // clip like "ment" ← Lament/Judgment stays unsnapped). Exact matches were already returned above,
    // so a real shorter item is never clobbered by a longer one it happens to end.
    if (key.length >= 6) {
      let sBest = null, sCount = 0;
      for (const e of entries) {
        const c = e.norm;
        if (c !== key && c.endsWith(key) && key.length >= 0.5 * c.length) { sBest = e.name; sCount++; }
      }
      if (sCount === 1) return sBest;
    }
    return norm; // no snap, still return the spacing-normalized name (cleaner than the raw OCR read)
  };
}

// Best-effort ranked candidates for a name that DIDN'T auto-snap, the Scanner review UI shows
// these so the user can one-click the right item (or type their own). Pure text similarity: the
// top-N vocab items by LCS ratio, above a loose floor (well below `canonicalize`'s snap threshold,
// since here a human confirms). `names` is the same vocabulary passed to `makeCanonicalizer`; the
// caller may re-rank the result by price proximity. Returns `[{ name, ratio }]`, best first.
export function suggestNames(names, name, n = 5, floor = 0.4) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return [];
  const list = [...new Set((names || []).filter(Boolean).map((s) => String(s).trim()).filter(Boolean))];
  const scored = [];
  for (const cand of list) {
    const r = ratio(cand.toLowerCase(), key);
    if (r >= floor) scored.push({ name: cand, ratio: r });
  }
  scored.sort((a, b) => b.ratio - a.ratio);
  return scored.slice(0, n);
}

// Resolve an OCR'd raid-drop name to a canonical item. Prefer the GLOBAL resolver when it already
// identifies a real known item, so a legitimate item like "New Era Ore" is never force-merged into a
// similarly-named raid drop like "Enhanced New Era Ore" (of which it's a suffix) just because the
// picked raid's small drop table lacks the plain form. Only fall back to the raid-scoped
// canonicalizer for names the global vocabulary can't place, garbled reads, or raid-only items not
// in the price vocab. `globalCanon`/`isKnown`/`raidCanon` are supplied by the caller; `raidSet` is
// the lowercased set of the raid's drops (confirms the raid snap landed on a real entry). Pure.
export function resolveDropName(raw, { globalCanon, isKnown, raidCanon = null, raidSet = null }) {
  const g = globalCanon(raw);
  if (isKnown(g)) return g;
  if (raidCanon && raidSet) { const r = raidCanon(raw); if (raidSet.has(r.toLowerCase())) return r; }
  return g;
}

// sealed-container (bottle) valuation
// A "Mysterious Glass Bottle (Lv. N)" is a sealed container: its own market listing is worthless
// (untradeable), so it's valued at the EXPECTED VALUE of what it opens into (SPEC §16.8). Contents
// are game data (never guessed): `fixed` = guaranteed items [[name, qty]…]; `oneOf` = a
// uniform-random draw of ONE option (each option a list of items). Levels off the Lv.N tag.
export const BOTTLE_CONTENTS = {
  40:  { fixed: [["AP 50 Capsule", 1], ["Seal of Bravery", 1]] }, // AP Capsule untradeable; Seal of Bravery may carry a seal-shop value (SPEC §16.10)
  60:  { oneOf: [ [["Orb", 2]], [["New Era Cloth", 4]], [["New Era Ore", 4]], [["New Era Orb", 4]], [["New Era Leather", 4]] ] },
  80:  { fixed: [["Mysterious Shard Grade 1", 1]] },
  100: { fixed: [["Mysterious Shard Grade 2", 1]] },
  110: { fixed: [["Mysterious Shard Grade 3", 1]] },
  120: { fixed: [["Uaithne Crystal", 1]] },
};

const BOTTLE_RE = /glass bottle/i;

// Extract a bottle's level from its OCR'd name, tolerant of the dim level text's digit garble
// (100 reads as "10o"): o/O→0, l/I/i/|→1. Returns null when the name isn't a bottle or has no Lv tag.
export function bottleLevel(name) {
  const s = String(name || "");
  if (!BOTTLE_RE.test(s)) return null;
  const m = s.match(/lv\.?\s*([\dol iI|O]+)/i);
  if (!m) return null;
  const digits = m[1].replace(/[oO]/g, "0").replace(/[lLiI|]/g, "1").replace(/\D/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// Per-unit market value of a single drop. Bottles → EV of their contents (fixed = Σ qty·avg;
// oneOf = uniform mean over the options), pricing only the tradeable contents; null when none of
// the contents (or the item itself) is priced. Everything else → its rolling-avg price. Pure.
export function dropUnitValue(name, prices = {}) {
  const lvl = bottleLevel(name);
  if (lvl != null) {
    const c = BOTTLE_CONTENTS[lvl];
    if (!c) return null;
    const sumItems = (list) => {
      let v = 0, any = false;
      for (const [nm, qty] of list) { const a = prices[nm]?.avg; if (a != null) { v += a * qty; any = true; } }
      return any ? v : null;
    };
    if (c.fixed) return sumItems(c.fixed);
    if (c.oneOf) {
      if (!c.oneOf.some((opt) => sumItems(opt) != null)) return null;
      return c.oneOf.reduce((s, opt) => s + (sumItems(opt) ?? 0), 0) / c.oneOf.length;
    }
    return null;
  }
  return prices[name]?.avg ?? null;
}

// Canonicalize a bottle name: rewrite the OCR-garbled `Lv. N` tag with the repaired numeric level
// (e.g. "Mysterious Glass Bottle (Lv.10o)" → "Mysterious Glass Bottle (Lv. 100)"). Non-bottles (or
// bottles with no readable level) pass through unchanged. Applied at scan time so the STORED name is
// clean, two differently-garbled reads of the same bottle then merge into one drop tally row.
export function normalizeBottleName(name) {
  const lvl = bottleLevel(name);
  if (lvl == null) return name;
  return String(name).replace(/(lv\.?\s*)[\dol iI|O]+/i, `Lv. ${lvl}`);
}

// Human-readable contents summary for a bottle name (tooltip). "" when not a known bottle.
export function bottleContentsLabel(name) {
  const lvl = bottleLevel(name);
  const c = lvl != null ? BOTTLE_CONTENTS[lvl] : null;
  if (!c) return "";
  const fmtOpt = (list) => list.map(([nm, q]) => `${nm}${q > 1 ? ` ×${q}` : ""}`).join(" + ");
  if (c.fixed) return `Opens into: ${fmtOpt(c.fixed)}`;
  if (c.oneOf) return `Opens into one of (equal chance): ${c.oneOf.map(fmtOpt).join(" | ")}`;
  return "";
}

// vocabulary-guided junk repair
// Connectives that legitimately appear lowercase mid-name ("Roots of Abundance",
// "Protects the Altar"). Never stripped as junk.
const REPAIR_STOPWORDS = new Set(["of", "the", "to", "a", "an", "and", "or", "for", "in", "on", "with"]);

// Two adjacent tokens are likely the SAME word read twice (an OCR ghost of its neighbour) when
// they're near the same length and within 2 edits, e.g. "Uaithne"/"Harthne" (the THN-e tail
// survives, the head is garbled). Looser than ghostPair's edge-clip rule; safe ONLY because
// repairName accepts a removal solely when the result snaps to a KNOWN item.
function adjacentGhost(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la.length < 4 || lb.length < 4 || Math.abs(la.length - lb.length) > 1) return false;
  return editDistance(la, lb, 2) <= 2;
}

// Repair OCR junk the per-token cleaners can't reach, GUARDED by the vocabulary: a candidate is
// adopted only when it canonicalizes to a known item, so a genuinely new/odd name is never
// corrupted (it's returned unchanged and surfaced as "not in app"). Two passes:
//   A. strip all-lowercase non-stopword fragments wedged mid-name (the vocab is Title-cased, so
//      these are almost always junk): "Perfect gendan Legendary thu Chunk" → "Perfect Legendary Chunk".
//   B. drop a token that's an adjacent ghost of its neighbour: "Stable Uaithne Harthne Crystal"
//      → "Stable Uaithne Crystal".
// `isKnown(name)` and `canonicalize(name)` are supplied by the caller (the app's own vocabulary).
export function repairName(name, isKnown, canonicalize) {
  if (!name || isKnown(name)) return name;
  const toks = name.split(/\s+/);
  const trySnap = (arr) => {
    if (arr.length < 2) return null;
    const snapped = canonicalize(arr.join(" "));
    return isKnown(snapped) ? snapped : null;
  };
  // A, strip lowercase junk fragments
  const noJunk = toks.filter((t) => REPAIR_STOPWORDS.has(t.toLowerCase()) || t !== t.toLowerCase());
  if (noJunk.length !== toks.length) { const r = trySnap(noJunk); if (r) return r; }
  // B, drop an adjacent ghost (try removing either side; the vocab decides which is real)
  const base = noJunk.length >= 2 ? noJunk : toks;
  for (let i = 0; i < base.length - 1; i++) {
    if (!adjacentGhost(base[i], base[i + 1])) continue;
    for (const drop of [i, i + 1]) {
      const r = trySnap(base.filter((_, j) => j !== drop));
      if (r) return r;
    }
  }
  return name;
}

// PP-OCR detection adapter (pure)

// A price-shaped token: digits with , . or space grouping (no letters). Used to place the
// price at the right edge so `parseDetections` classifies it as the price column.
const PRICE_TOKEN_RE = /^[\d.,\s]*\d[\d.,\s]*$/;

// Convert PP-OCR line detections → the { text, conf, cx, cy, bbox } word tokens that
// `parseDetections` consumes, so all the downstream row-grouping / continuation-merge /
// cleanName / canonicalize logic is reused unchanged. Each detection is `{ text, mean, box }`
// with box = 4 corners [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]. A detection may hold a name, a price,
// or both ("Armor 55,555,555"). Sometimes spanning the empty middle gap.
//
// The row's price is the LAST numeric token (auction prices are right-aligned); it snaps to the
// detection's RIGHT edge (x1). Every other token is a name token at a char-interpolated x from the
// LEFT (x0). INCLUDING an earlier numeric, which is an in-name grade/level digit, not the price:
// "Abyssal Shard Grade 1 104,103", the "1" is the grade, "104,103" is the price. (Snapping every
// numeric to x1, as before, pulled that "1" into the price column, dropping it from the name AND
// misreading it as the price.) When the image width is known, a name token whose interpolated x
// would fall in the price column (a wide spanning box distributes its chars across the gap) is
// clamped just left of it, so a mid-name grade digit can never be misclassified as the price.
export function ppDetectionsToWords(detections, w = 0, priceXFrac = 0.75) {
  const priceX = w ? w * priceXFrac : Infinity;
  const words = [];
  for (const d of detections || []) {
    const box = d.box;
    if (!box || box.length < 4) continue;
    const x0 = box[0][0], y0 = box[0][1], x1 = box[1][0], y1 = box[2][1];
    const cy = (y0 + y1) / 2;
    const bbox = { x0, y0, x1, y1 };
    const toks = String(d.text ?? "").trim().split(/\s+/).filter(Boolean);
    const total = toks.join(" ").length || 1;
    let priceIdx = -1;
    for (let i = toks.length - 1; i >= 0; i--) { if (PRICE_TOKEN_RE.test(toks[i])) { priceIdx = i; break; } }
    // Is that last numeric actually a PRICE, not a bare level/qty? A price carries a grouping
    // separator (the level column is a bare 1–3 digit integer like "125") OR sits in the right
    // price column. Flag it explicitly so parseDetections isn't forced to re-derive price-ness from
    // the fixed 0.75·w x-fraction: on a narrow crop the whole row (name+level+price) can fall left
    // of that fraction yet still hold a clean "340,000,000", which the x-only rule silently drops.
    const isPriceTok = priceIdx >= 0 && (/[.,\s]/.test(toks[priceIdx]) || x1 >= priceX);
    let pos = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let cx, isPrice = false;
      if (i === priceIdx && isPriceTok) { cx = x1; isPrice = true; } // price → snap to right edge
      else {
        cx = x0 + ((pos + t.length / 2) / total) * (x1 - x0); // name/grade token → interpolated x
        if (cx >= priceX) cx = priceX - 1;                    // keep it left of the price column
      }
      words.push({ text: t, conf: d.mean ?? 0.9, cx, cy, bbox, isPrice });
      pos += t.length + 1;
    }
  }
  return words;
}

// row assembly + extraction (pure)

// Extract { name, price } rows from classified word boxes. `words` items are
// { text, conf (0..1), cx, cy, bbox }. opts: { iconX, priceXFrac, retry } where retry is
// an async (bbox) → Promise<int|null> high-quality re-OCR for prices the strict pass can't
// read (null in tests → lenient fallback only). Returns cleaned, filtered rows (NOT yet
// canonicalized, the caller applies that so this stays pure/testable).
export async function parseDetections(words, w, h, opts = {}) {
  const { iconX = 0, priceXFrac = 0.75, retry = null } = opts;
  const priceX = w * priceXFrac;

  // Classify; skip the icon area and a low-confidence floor (short name words like
  // "Leg" can read at ~0.047; junk below 0.04 is caught by JUNK/cleanName anyway).
  const classified = [];
  for (const d of words) {
    if (d.conf < 0.04) continue;
    if (d.cx < iconX) continue;
    classified.push({ cx: d.cx, cy: d.cy, text: d.text, isPrice: d.isPrice != null ? d.isPrice : d.cx >= priceX, bbox: d.bbox });
  }
  if (!classified.length) return [];

  // Group into rows using the *first element's y* as the row reference so averaging
  // drift doesn't pull continuation words into the previous row. 2.5% of height scales
  // 1080p (~20px) → 4K (~40px); floor 16 for short images; cap 40 below the continuation gap.
  const ROW_TOL = Math.max(Math.min(h * 0.025, 40), 16);
  classified.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const rows = [[classified[0]]];
  for (let i = 1; i < classified.length; i++) {
    const d = classified[i];
    const refY = rows[rows.length - 1][0].cy;
    if (d.cy - refY < ROW_TOL) rows[rows.length - 1].push(d);
    else rows.push([d]);
  }

  // Per-row: join name tokens left-to-right, resolve the first price-column token.
  const rawItems = [];
  for (const row of rows) {
    const nameTokens = [];
    let price = null, priceBox = null, hasLevel = false;
    const rowY = row[0].cy;
    // The row's true vertical extent from its token boxes (used by the caller to crop a clean
    // row strip for the review UI). Falls back to the reference cy when boxes are degenerate.
    let top = Infinity, bottom = -Infinity;
    for (const d of row) { if (d.bbox) { top = Math.min(top, d.bbox.y0); bottom = Math.max(bottom, d.bbox.y1); } }
    if (!isFinite(top) || !(bottom > top)) { top = rowY; bottom = rowY; }
    const hasPriceToken = row.some((d) => d.isPrice);
    // Order by READING order. Line (a coarse y-bucket) then x. Not pure x, so a wrapped name
    // whose 2nd line ("… Armor") shares the row isn't interleaved into the 1st ("Eriu Advancement
    // Stone: Head" + "Armor" → "…Head Armor", not "Eriu Armor Advancement…"). Single-line rows have
    // one bucket, so this is a no-op there.
    const lineTol = ROW_TOL * 0.6;
    for (const d of [...row].sort((a, b) => Math.floor(a.cy / lineTol) - Math.floor(b.cy / lineTol) || a.cx - b.cx)) {
      if (d.isPrice) {
        if (price === null) {
          let p = toPrice(d.text, true);
          if (p === null && /\d/.test(d.text)) {
            const r = retry ? await retry(d.bbox) : null;
            p = r || toPrice(d.text);
          }
          if (p) { price = p; priceBox = d.bbox; } // remember the box for a high-res re-verify
        }
      } else {
        if (LEVEL_RE.test(d.text.trim())) hasLevel = true;
        nameTokens.push(d.text);
      }
    }
    rawItems.push({ nameText: nameTokens.join(" "), price, priceBox, hasLevel, hasPriceToken, rowY, top, bottom });
  }

  // Merge wrapped-name continuation lines into the priced row they belong to. A wrapped name
  // can spill EITHER way: line 2 trailing line 1 ("The Watcher's Glowing" / "Mysterious Cat
  // Statue"). A FORWARD merge into the previous item; or line 1 leading line 2 when the price
  // sits on the second line ("The Winds of" / "Lochlann  1,222,222"). A BACKWARD merge into
  // the next item. A continuation has no parsed price, no level token, no price-column token,
  // and sits within one text line (gap < 2·ROW_TOL). `pending` holds a leading line until the
  // next priced row claims it (else it's dropped, as a priceless line always was).
  const merged = [];
  let prevRowY = null, pending = null;
  for (const it of rawItems) {
    const gap = prevRowY === null ? 0 : it.rowY - prevRowY;
    const isContinuation = it.price === null && !it.hasLevel && !it.hasPriceToken;
    if (isContinuation) {
      if (merged.length && gap < 2 * ROW_TOL) {                                                          // forward
        const m = merged[merged.length - 1];
        m.nameText += " " + it.nameText;
        m.top = Math.min(m.top, it.top); m.bottom = Math.max(m.bottom, it.bottom); // grow the crop extent
      } else pending = { nameText: it.nameText, rowY: it.rowY, top: it.top, bottom: it.bottom };         // hold for backward
    } else {
      let nameText = it.nameText, top = it.top, bottom = it.bottom;
      if (pending && it.price !== null && it.rowY - pending.rowY < 2 * ROW_TOL) {
        nameText = pending.nameText + " " + nameText;
        top = Math.min(top, pending.top); bottom = Math.max(bottom, pending.bottom); // include the leading line
      }
      pending = null;
      merged.push({ nameText, price: it.price, priceBox: it.priceBox, y: it.rowY, top, bottom });
    }
    prevRowY = it.rowY;
  }

  // Clean names, drop headers/junk/priceless. `y` (the row's reference cy) rides along so
  // the caller can match rows across OCR passes by position; `top`/`bottom` (the row's true
  // vertical token extent, spanning a merged wrapped 2nd line) let the caller crop a clean
  // row strip for the review UI; `priceBox` lets the caller re-verify the price from a
  // high-res crop (scanImage).
  // `keepUnpriced` retains rows whose name read fine but whose price didn't parse, so the
  // caller can surface them ("recognized X, couldn't read its price") instead of losing them
  // silently. Off by default (existing contract / tests): only priced rows are returned.
  const { keepUnpriced = false } = opts;
  const results = [];
  for (const { nameText, price, priceBox, y, top, bottom } of merged) {
    if (!price && !keepUnpriced) continue;
    const permanent = PERM_DETECT.test(nameText); // flag BEFORE cleanName strips the tag
    const cleaned = cleanName(nameText);
    if (!cleaned || cleaned.length <= 2) continue;
    const wordsLower = cleaned.split(/\s+/).map((s) => s.toLowerCase());
    const headerHits = wordsLower.filter((s) => HEADER_WORDS.has(s)).length;
    if (headerHits >= 1 && wordsLower.length <= headerHits + 1) continue;
    if (!cleaned.split(/\s+/).some((s) => s.length >= 3)) continue;
    results.push({ name: cleaned, price: price || null, priceBox, y, top, bottom, permanent });
  }
  return results;
}

// raid-drop chat-log parsing (pure, SPEC §16.8)
// The raid-drop tracker reads the SYSTEM chat log, not the auction table, so it has its own
// line-oriented parse (the price-column row logic above doesn't apply). Each line looks like:
//   "[SYSTEM] <Actor> [has] obtained [the] [Item Name] [× N]. (Optional Tag)"
// with variants "You have obtained N gold." and "Reward: Received [Item]." Only the player's OWN
// lines are counted; party members' drops share the same log and are filtered by actor name.

// Group PP-OCR detections into visual text lines (by y), joined left-to-right (by x). PP-OCR
// usually emits one detection per chat line, but a differently-coloured item name can be a separate
// box on the same line, grouping re-joins them. `tol` scales with image height. Pure.
export function detectionsToLines(detections, h = 0) {
  const tol = Math.max(h * 0.015, 10);
  const items = [];
  for (const d of detections || []) {
    const b = d.box; if (!b || b.length < 4) continue;
    const text = String(d.text ?? "").trim(); if (!text) continue;
    items.push({ text, x: b[0][0], y: (b[0][1] + b[2][1]) / 2 });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) < tol) { last.parts.push(it); last.y = (last.y + it.y) / 2; }
    else lines.push({ y: it.y, parts: [it] });
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(" "));
}

// A leading "[SYSTEM]" tag (brackets often OCR-garbled → tolerate any wrapping punctuation).
const SYSTEM_PREFIX = /^\W*\[?\s*system\s*\]?\W*\s*/i;
// Trailing "× N." quantity at the END of a line ("x 4.", "× 4", "X4"). Used to strip the count off
// a bracket-less item name. The ×/x may be an OCR misread of either.
const QTY_RE = /[x×✕╳]\s*(\d+)\s*\.?\s*$/i;
// The "× N" quantity ANYWHERE (not end-anchored). The count follows the item but a trailing
// "(Luck Effect)"/"(VVIP Service)" tag can sit AFTER it ("[Item] x2.(Luck Effect)"), so anchoring
// to end would miss it and undercount to 1. Applied to the tail after the item bracket.
const QTY_ANYWHERE = /[x×✕╳]\s*(\d+)/i;
// "<Actor> [has|have] obtained [the] <rest>". Actor is lazy so it stops at the first "obtained".
// Whitespace around the verb is optional. OCR squeezes it out both after has/have ("Droooo
// hasobtained[…]") AND between the actor and a no-"has" "obtained" ("Drooooobtained[…]", where the
// name's trailing letter runs straight into the verb). The leading `\s*` (not `\s+`) tolerates the
// glued case; the lazy actor still stops at the first literal "obtained".
const OBTAINED_RE = /^(.*?)\s*(?:ha(?:s|ve)\s*)?obtained\b\s*(?:the\s+)?(.*)$/i;
// Other players' end-of-run gold uses "earned", not "obtained" ("Malizioso has earned 35 gold.").
// Same actor/verb tolerance as OBTAINED_RE. These lines only ever carry gold.
const EARNED_RE = /^(.*?)\s*(?:ha(?:s|ve)\s*)?earned\b\s*(.*)$/i;
const REWARD_RE = /^reward\b[\s:.]*received\b\s*(.*)$/i;
const GOLD_RE = /^(\d[\d,]*)\s+gold\b/i;

// core-source tags (SPEC §16.9)
// A drop line's trailing "(…)" names WHY the extra core dropped, "(Campfire Effect)",
// "(Core Boost Plus Effect)", "(VVIP Service)", "(Pet Effect)", "(Guild Skill)",
// "(Luck Effect)". No tag = a normal base core (incl. the base core-boost's drops, that
// boost upgrades drop QUALITY, adds no lines). Matched on letters only (lowercased,
// non-letters stripped) so OCR-garbled parens/spacing still resolve. Order matters:
// "boost" before the rest so "Core Boost Plus Effect" can't fall through, and "vip"
// (not "vvip") tolerates a dropped V.
export const CORE_SOURCES = ["base", "campfire", "plus", "vvip", "pet", "guild", "luck"];
const CORE_SOURCE_KEYS = [
  ["campfire", "campfire"],
  ["boost", "plus"], // ONLY Core Boost Plus tags its cores, any "boost" tag is Plus
  ["plus", "plus"],
  ["vip", "vvip"],
  ["guild", "guild"],
  ["luck", "luck"],
  ["pet", "pet"],
];
export function coreSource(tagText) {
  const t = String(tagText || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return "base";
  for (const [key, src] of CORE_SOURCE_KEYS) if (t.includes(key)) return src;
  return "base";
}

// Parse ONE chat line → { kind:"item", actor, self, item, qty, source } | { kind:"gold", actor,
// self, gold } | null (not a drop line). `self` marks a line that is unambiguously the player's
// own ("You…" / "Reward: Received…"), so it's counted regardless of the actor filter. Item name =
// the LAST bracketed group (the first "[…]" is always "[SYSTEM]"); falls back to the trailing text
// with the qty/tag stripped when OCR dropped the brackets. `source` = core-source tag after the
// item (SPEC §16.9), "base" when untagged. Names are NOT canonicalized here (kept pure, the
// caller resolves them against the price vocabulary for valuation).
export function parseDropLine(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/\s+/g, " ").trim().replace(SYSTEM_PREFIX, "");
  let actor = null, rest = null, self = false;
  const m = t.match(OBTAINED_RE);
  if (m) {
    actor = m[1].trim(); rest = m[2].trim();
    if (/^you\b/i.test(actor)) { self = true; actor = null; }
  } else {
    const e = t.match(EARNED_RE);
    if (e && GOLD_RE.test(e[2].trim())) {
      actor = e[1].trim(); rest = e[2].trim();
      if (/^you\b/i.test(actor)) { self = true; actor = null; }
    } else {
      const r = t.match(REWARD_RE);
      if (r) { self = true; rest = r[1].trim(); }
    }
  }
  if (rest == null) return null;
  const g = rest.match(GOLD_RE);
  if (g) return { kind: "gold", actor, self, gold: parseInt(g[1].replace(/,/g, ""), 10) };
  // Item = the LAST bracketed group; `tail` = the text AFTER it, where the "× N" count and the
  // core-source tag live. Bracket-less fallback: only a TRAILING paren group can be the tag (the
  // name itself may contain parens, but those sit before the qty).
  let item = null, tail = rest, source = "base";
  const brs = [...rest.matchAll(/\[([^\]]+)\]/g)];
  if (brs.length) {
    item = brs[brs.length - 1][1]; tail = rest.slice(rest.lastIndexOf("]") + 1);
    const tags = [...tail.matchAll(/\(([^)]*)\)/g)];
    // Tag = last paren group after the item; if OCR lost the parens, try the tail text itself
    // (qty stripped). Letters-only matching in coreSource keeps this safe.
    source = coreSource(tags.length ? tags[tags.length - 1][1] : tail.replace(QTY_ANYWHERE, ""));
  } else {
    const tag = rest.match(/\(([^)]*)\)\s*$/);
    source = coreSource(tag ? tag[1] : "");
    item = rest.replace(/\([^)]*\)\s*$/, "").replace(QTY_RE, ""); // no brackets: strip trailing tag+qty
  }
  // Quantity (default 1): the count follows the item, tolerant of a trailing tag after it.
  const q = tail.match(QTY_ANYWHERE);
  const qty = q ? parseInt(q[1], 10) : 1;
  item = item.replace(/^[^\w(]+|[^\w)%]+$/g, "").trim(); // trim edge punctuation; keep name parens + a trailing "%" (…DMG +8%)
  if (!item || item.length <= 1) return null;
  return { kind: "item", actor, self, item, qty, source };
}

// Re-join chat lines the game wrapped mid-message. A long drop line wraps its trailing
// core-source tag onto the next visual line ("…x 1.(Core Boost Plus" / "Effect)"), so per-line
// parsing mis-reads both halves. Conservative join: the previous line has MORE "(" than ")"
// (an unclosed paren group) AND the next line closes the balance AND the next line is not a
// fresh chat message (no [SYSTEM] prefix. OCR keeps it on real message starts). Pure; run on
// the merged (post-stitch) line list, where each wrapped pair appears once. SPEC §16.8.
export function unwrapLines(lines) {
  const count = (s, ch) => (String(s).match(new RegExp(`\\${ch}`, "g")) || []).length;
  const out = [];
  for (const raw of lines || []) {
    const line = String(raw || "");
    const prev = out[out.length - 1];
    if (
      prev != null &&
      count(prev, "(") > count(prev, ")") &&
      !SYSTEM_PREFIX.test(line.trim()) && /\)/.test(line) &&
      count(prev + line, "(") <= count(prev + line, ")")
    ) {
      out[out.length - 1] = `${prev} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

// Cluster raw OCR'd actor names so jittered reads of the same player ("Kaelin"/"Kaelim") share
// one bucket. Greedy by frequency: the most-seen spelling becomes canonical; a later spelling
// within the edit-distance cap (same scaling as makeActorMatcher) folds into it ONLY when it's
// also clearly rarer (≤2 reads, or ≤half the canonical's). Two genuinely distinct players with
// near-identical names ("Eira3"/"Eira5") each rack up many reads, while OCR jitter surfaces
// once or twice, so frequency separates the cases the edit distance can't. Returns
// Map(rawLowercased → canonical spelling). Pure. SPEC §16.11.
export function clusterActors(names = []) {
  const freq = new Map();
  for (const n of names) {
    const k = String(n || "").trim();
    if (k) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const ordered = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const canon = []; // [{name, lower, count}]
  const map = new Map();
  for (const [name, count] of ordered) {
    const lower = name.toLowerCase();
    let hit = null;
    for (const c of canon) {
      const cap = Math.min(c.lower.length, lower.length) >= 6 ? 2 : 1;
      if (editDistance(c.lower, lower, cap) <= cap && (count <= 2 || count * 2 <= c.count)) { hit = c; break; }
    }
    if (!hit) { hit = { name, lower, count }; canon.push(hit); }
    map.set(lower, hit.name);
  }
  return map;
}

// Build a predicate that matches a scanned actor name against the player's character name,
// case-insensitively and fuzzily (OCR drops/doubles letters). Edit-distance cap scales with the
// name's length. An empty character name matches nothing (tracker inert until set). Pure.
export function makeActorMatcher(charName) {
  const target = String(charName || "").trim().toLowerCase();
  if (!target) return () => false;
  const cap = target.length >= 6 ? 2 : 1;
  return (name) => {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return false;
    if (n === target) return true;
    return editDistance(n, target, cap) <= cap;
  };
}

// Parse a batch of OCR chat lines into the player's drops. `matchActor(name)` decides ownership
// for actored lines; self lines always count. Returns aggregated-nothing here (the caller's store
// accumulates). Just the per-line results: { drops:[{name,qty,source}], gold, foreign:[actor…],
// party:[{actor,drops}] }, where `foreign` lists other players' actors seen (surfaced so the user
// can confirm the filter worked) and `source` is the line's core-source tag ("base" when
// untagged, SPEC §16.9). With `party: true` (SPEC §16.11), other players' ITEM drops are kept,
// grouped per clustered actor (clusterActors folds OCR-jittered spellings of one player
// together); their gold lines are deliberately ignored, gold is tracked self-only, the run
// analysis assumes party members earned what you did, but still register the actor, so a
// player seen only via an "earned gold" line counts toward the party roster.
export function parseDrops(lines, matchActor = () => true, { party = false } = {}) {
  const drops = []; let gold = 0; const foreign = new Set();
  const parsed = (lines || []).map((line) => parseDropLine(line)).filter(Boolean);
  const canon = party
    ? clusterActors(parsed.filter((p) => p.actor && !matchActor(p.actor)).map((p) => p.actor))
    : null;
  const byActor = new Map(); // canonical actor → [{name,qty,source}]
  for (const p of parsed) {
    const mine = p.self || (p.actor && matchActor(p.actor));
    if (!mine) {
      if (p.actor) foreign.add(p.actor);
      if (party && p.actor) {
        const who = canon.get(p.actor.trim().toLowerCase()) || p.actor.trim();
        const bucket = byActor.get(who) || [];
        if (p.kind === "item") bucket.push({ name: p.item, qty: p.qty, source: p.source });
        byActor.set(who, bucket);
      }
      continue;
    }
    if (p.kind === "gold") gold += p.gold;
    else drops.push({ name: p.item, qty: p.qty, source: p.source });
  }
  const out = { drops, gold, foreign: [...foreign] };
  if (party) out.party = [...byActor.entries()].map(([actor, adrops]) => ({ actor, drops: adrops }));
  return out;
}

// loot-box opening parsing (pure, SPEC §16.12)
// The Tracker's Boxes subtab reads the SYSTEM chat log of opening loot boxes:
//   "[SYSTEM] You used [Box Name]."
//   "[SYSTEM] You obtained [Item Name] x N."   (one or more, multi-item boxes exist)
//   "[SYSTEM] All items have been used."       (delimiter; may be missing/garbled)
// Only the player's OWN lines are part of an opening, an obtained line reuses the
// drop-line parser (same bracket/qty/OCR tolerance), so a party member's pickup in
// the same log window is ignored, and a "You have obtained N gold" box payout is
// kept as a pseudo-item named "Gold" (qty = the gold amount, unit value 1).

// "You [have] used <rest>", same glued-whitespace tolerance as OBTAINED_RE
// ("Youused[…]" still matches: \s* accepts the squeezed-out space).
const USED_RE = /^you\s*(?:ha(?:ve|d)\s*)?used\b\s*(.*)$/i;
// The "All items have been used." delimiter, tolerant of a dropped plural/verb garble.
const ALL_USED_RE = /^all\s+items?\s+ha(?:ve|s)\s+been\s+used/i;

// Parse ONE chat line of the box-opening grammar → { kind:"used", box } |
// { kind:"obtained", name, qty } | { kind:"end" } | null (not a box line).
// Box name = the LAST bracketed group (the first "[…]" is "[SYSTEM]"); bracket-less
// fallback strips the trailing period. Names are NOT canonicalized here (kept pure).
export function parseBoxLine(raw) {
  if (!raw) return null;
  const t = String(raw).replace(/\s+/g, " ").trim().replace(SYSTEM_PREFIX, "");
  if (ALL_USED_RE.test(t)) return { kind: "end" };
  const u = t.match(USED_RE);
  if (u) {
    const rest = u[1].trim();
    const brs = [...rest.matchAll(/\[([^\]]+)\]/g)];
    let box = brs.length ? brs[brs.length - 1][1] : rest;
    box = box.replace(/^[^\w(]+|[^\w)%]+$/g, "").trim(); // trim edge punctuation (incl. the trailing ".")
    return box.length > 1 ? { kind: "used", box } : null;
  }
  const p = parseDropLine(raw);
  if (p && p.self) {
    if (p.kind === "item") return { kind: "obtained", name: p.item, qty: p.qty };
    if (p.kind === "gold") return { kind: "obtained", name: "Gold", qty: p.gold };
  }
  return null;
}

// Parse a batch of OCR chat lines into box openings. Every self "obtained" line
// attaches to the most recent "You used" until the next "used" or the "All items
// have been used." delimiter closes it. Obtained lines with NO open box (screenshot
// cropped above its "used" line) land in `orphans` so the caller can surface them
// instead of losing them silently. Returns { openings:[{box, items:[{name,qty}]}],
// orphans:[{name,qty}] }. Pure. SPEC §16.12.
export function parseBoxOpenings(lines) {
  const openings = [], orphans = [];
  let cur = null;
  const close = () => { if (cur) { openings.push(cur); cur = null; } };
  for (const line of lines || []) {
    const p = parseBoxLine(line);
    if (!p) continue;
    if (p.kind === "used") { close(); cur = { box: p.box, items: [] }; }
    else if (p.kind === "end") close();
    else (cur ? cur.items : orphans).push({ name: p.name, qty: p.qty });
  }
  close();
  return { openings, orphans };
}

// Aggregate a box-opening log (each record = ONE opening: { box, items:[{name,qty}] };
// extra fields like id/at pass through untouched) into per-box stats: `opens`, and per
// distinct item `times` (openings that contained it, drives the observed drop rate
// times/opens) + `totalQty` (avg qty when it hits = totalQty/times). Items sorted by
// times desc, boxes by opens desc. Valuation is the CALLER's job (dropUnitValue at
// render time, live prices, nothing frozen). Pure. SPEC §16.12.
export function summarizeBoxes(records) {
  const byBox = new Map();
  for (const r of records || []) {
    const box = String(r?.box || "").trim();
    if (!box) continue;
    const b = byBox.get(box) || { box, opens: 0, items: new Map() };
    b.opens++;
    const seen = new Set();
    for (const it of r.items || []) {
      const e = b.items.get(it.name) || { name: it.name, times: 0, totalQty: 0 };
      e.totalQty += it.qty || 0;
      if (!seen.has(it.name)) { e.times++; seen.add(it.name); }
      b.items.set(it.name, e);
    }
    byBox.set(box, b);
  }
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return [...byBox.values()]
    .map((b) => ({ box: b.box, opens: b.opens, items: [...b.items.values()].sort((a, x) => x.times - a.times || byName(a, x)) }))
    .sort((a, b) => b.opens - a.opens || a.box.toLowerCase().localeCompare(b.box.toLowerCase()));
}

// Expected value per open, per box, from the opening log, what one more open of this box is
// worth. `unitValue(name)` prices a payout item (caller passes dropUnitValue over live prices;
// the Gold pseudo-item is worth 1). ev = Σ(unit × totalQty) / opens over the PRICED payouts;
// null when nothing priced. `unpricedItems` counts the distinct payouts the EV had to skip
// (surfaced so an undercounting EV is visible). Feeds the synthetic price injection (a logged
// box then values like any drop. SPEC §16.12) and the Items-tab RNG rows. Pure.
export function boxExpectedValues(records, unitValue) {
  return summarizeBoxes(records).map((b) => {
    let v = 0, any = false, unpriced = 0;
    for (const e of b.items) {
      const u = unitValue(e.name);
      if (u == null) { unpriced++; continue; }
      any = true; v += u * e.totalQty;
    }
    return { box: b.box, opens: b.opens, ev: any ? v / b.opens : null, unpricedItems: unpriced };
  });
}

// GIF frame stitching (SPEC §16.8)
// A GIF of the SYSTEM chat log is a SCROLLING capture: the earliest frame is the top of the log and
// each later frame has scrolled down, so consecutive frames overlap heavily (frame N's bottom lines
// reappear at frame N+1's top, shifted up, with only a line or two of genuinely-new text at the
// bottom). We reconstruct the full ordered log by OVERLAP-STITCHING: align each new frame's head
// against the tail of what we've accumulated and append only the non-overlapping remainder. Each
// message is then counted EXACTLY ONCE, unlike the old per-frame-max clustering, which (a) split a
// line whose "× N" count jittered between frames into two counted buckets (overcount) and (b) capped
// a repeated-line block at the most visible in any single frame (undercount). `frames` = array of
// per-frame line arrays IN SCROLL ORDER; returns one merged line array to feed parseDrops. Pure.
// KNOWN LIMIT (unfixable from text alone. CONFIRMED): a run of TRULY IDENTICAL lines (e.g. many
// "obtained [Uaithne Remnant]." in a row) that fills the ENTIRE visible window is inherently
// ambiguous, with no distinct line to anchor the scroll offset, an all-identical window that
// scrolled by K lines is indistinguishable from a static one, so a block longer than the window can
// undercount by the overflow. A partial identical block bounded by ANY distinct line above or below
// IS resolved correctly (the anchor fixes the offset). The pixels do keep scrolling through such a
// block, but this stitch is deliberately engine-agnostic (pure text, no frame images), so that
// signal isn't available here; inferring K from an assumed scroll velocity would risk OVER-counting
// (reviving the old N× bug), a worse failure than the mild, bounded undercount. Left as-is. Far
// milder than the old per-frame-max summing.
const normLine = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Item-quality modifier words OCR intermittently drops mid-scroll, "Enhanced New Era Ore"
// read as plain "New Era Ore" in one frame. Ignored ONLY when TESTING whether two frames show
// the same message, so the two reads align and the fuller (Enhanced) one is kept; the stored
// text is untouched, and an all-frames-drop-it read stays plain (SPEC §16.8). The whole-word
// boundary keeps it from touching substrings of other names.
const STITCH_MODIFIER_RE = /\benhanced\b/gi;
const matchNorm = (s) => normLine(String(s || "").replace(STITCH_MODIFIER_RE, " "));

export function mergeGifFrameLines(frames, { fuzz = 0.14 } = {}) {
  // Two chat lines are "the same message" when their normalized (spacing/punctuation-insensitive)
  // text matches within a length-scaled edit distance. Deliberately NO numeric guard here: a scroll
  // re-reads the SAME line with OCR "× N" jitter, so those must collapse. Genuinely distinct drops
  // stay apart because alignment is POSITIONAL (same slot within the overlap), not a global cluster.
  // A dropped "Enhanced" modifier is normalized away for the MATCH so the two reads still align.
  const sameLine = (a, b) => {
    const na = matchNorm(a), nb = matchNorm(b);
    if (na === nb) return true;
    if (!na || !nb) return false;
    const cap = Math.max(1, Math.floor(Math.min(na.length, nb.length) * fuzz));
    return editDistance(na, nb, cap) <= cap;
  };
  let acc = null;
  for (const frame of frames || []) {
    const lines = (frame || []).map((l) => String(l || "").trim()).filter((l) => normLine(l));
    if (!lines.length) continue;
    if (acc === null) { acc = lines.slice(); continue; }
    // Find the scroll offset: the overlap length L where acc's last L lines best match the frame's
    // first L lines. Score each candidate L as hits − 2·misses so a too-long L (which drags older,
    // non-overlapping acc lines into the comparison → forced misses at the head) is rejected in
    // favour of the tight true overlap. A fully-matching longer L still wins (its score keeps
    // rising), so a non-scrolled duplicate frame collapses entirely.
    const maxL = Math.min(acc.length, lines.length);
    let bestL = 0, bestScore = -1;
    for (let L = 1; L <= maxL; L++) {
      let hits = 0;
      for (let i = 0; i < L; i++) if (sameLine(acc[acc.length - L + i], lines[i])) hits++;
      const score = hits - 2 * (L - hits);
      if (score > bestScore) { bestScore = score; bestL = L; }
    }
    const overlap = bestScore > 0 ? bestL : 0; // no positive match → a jump/scene change; append all
    // Keep the fuller read for overlapping lines. NO sameLine gate here: the alignment already
    // decided these slots are the same message, and the case that matters is exactly the one
    // sameLine can't pass, a line caught mid-scroll at a frame's bottom edge enters acc as an
    // extreme garble ("SYSTEM Eraorblx3"), then the next frame reads it cleanly; the clean read
    // must win or the message is lost. Length asymmetry keeps this safe both ways: a clipped
    // TOP-edge read in the new frame is short → loses to acc's full line.
    for (let i = 0; i < overlap; i++) {
      const ai = acc.length - overlap + i;
      if (lines[i].length > acc[ai].length) acc[ai] = lines[i];
    }
    for (let i = overlap; i < lines.length; i++) acc.push(lines[i]);
  }
  return acc || [];
}

// run history & profit tracking (SPEC §16.8)
// A saved run freezes a drop tally's value at save time (prices drift), while keeping
// name+qty so a view can still recompute "value at today's prices". All pure, the UI
// snapshots the session `dropStore` + character/raid/timer meta through these.

// Build one run record from a drop tally. `items` = [[name, qty, source]…] (dropStore.items
// entries; names already canonical; source = core-source key, defaults "base". SPEC §16.9).
// Each drop's `unit` is the rolling-avg price at save (null if unpriced → contributes null
// value, not counted in the total). Luck-core yield is tracked via the drops' `luck` source
// tag; the character's Luck stat itself is no longer recorded (old records may carry `luck`,
// it's ignored).
export function makeRunRecord({ items = [], gold = 0, prices = {}, character = "", raid = "", mode = "Normal", coreBoost = false, maxLevel = false, name = "", durationSec = null, savedAt = null, id = null, party = [] } = {}) {
  const priceDrops = (list) => {
    const drops = []; let itemsValue = 0;
    for (const [nm, qty, source] of list) {
      const unit = dropUnitValue(nm, prices);
      const value = unit != null ? unit * qty : null;
      if (value != null) itemsValue += value;
      drops.push({ name: nm, qty, source: CORE_SOURCES.includes(source) ? source : "base", unit, value });
    }
    return { drops, itemsValue };
  };
  const { drops, itemsValue } = priceDrops(items);
  // Party members' drops (SPEC §16.11): same [name, qty, source] triples, valued at the same
  // snapshot prices. Their gold is NOT recorded, the pooled analysis assumes each member
  // earned what the player did. An actor with no items still rides along (counts to partySize).
  const partyOut = (party || []).map((m) => {
    const p = priceDrops(m.items || []);
    return { actor: String(m.actor || "").trim(), drops: p.drops, itemsValue: p.itemsValue };
  }).filter((m) => m.actor);
  const g = Number(gold) || 0;
  return {
    id: id || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    name: String(name || "").trim() || `${raid || "Run"}`, // date lives in its own column, don't repeat it here
    character: String(character || "").trim(),
    raid: String(raid || ""),
    mode: mode === "Hero" ? "Hero" : "Normal", // Hero = doubled HP + doubled drops; still ONE run
    coreBoost: !!coreBoost, // whether the run was core-boosted (adds the raid's Core Gold, applied live)
    maxLevel: !!maxLevel,   // whether the character was max-level (adds the +20% level-cap gold bonus, applied live)
    savedAt: savedAt || new Date().toISOString(),
    durationSec: durationSec == null ? null : Math.max(0, Math.round(durationSec)),
    gold: g,
    itemsValue,
    total: itemsValue + g, // SELF-ONLY, the profit log means "what I made"; pooled value lives in summarizeRuns
    drops,
    ...(partyOut.length ? { party: partyOut, partySize: 1 + partyOut.length } : {}),
  };
}

// A drop is JUNK when its name contains any user-curated junk substring (case-insensitive):
// untradeable buff drops (Waking Stones), event Seals, etc. Junk is filtered from the tally +
// value and never fuzzy-matched to a priced item. `junk` = array of lowercased substrings.
export function isJunk(name, junk = []) {
  if (!junk || !junk.length) return false;
  // Whitespace-insensitive so a pattern catches OCR spacing garbles too ("waking stone" hides the
  // mis-read "WakingStone:Major Cooldown"). Both sides lowercased with all spaces stripped.
  const n = String(name || "").toLowerCase().replace(/\s+/g, "");
  return junk.some((p) => { const q = String(p || "").toLowerCase().replace(/\s+/g, ""); return q && n.includes(q); });
}

// Which mode(s) a raid offers, and the default to preselect. A raid NAME containing
// "hero"/"normal" is a single fixed mode (those are separately-listed variants where hero
// changes the requirements, no toggle). Otherwise a raid with a Hero version offers both
// and defaults to Hero (it's usually the faster farm); one without offers Normal only. No
// raid selected → both offered, default Normal (availability unknown).
export function raidModeOptions(raidName, hasHero) {
  const n = String(raidName || "").toLowerCase();
  if (/hero/.test(n)) return { locked: "Hero", options: ["Hero"], default: "Hero" };
  if (/normal/.test(n)) return { locked: "Normal", options: ["Normal"], default: "Normal" };
  if (!raidName) return { locked: null, options: ["Normal", "Hero"], default: "Normal" };
  if (hasHero) return { locked: null, options: ["Normal", "Hero"], default: "Hero" };
  return { locked: null, options: ["Normal"], default: "Normal" };
}

// Distinct character names seen across saved runs (for the name-box datalist + filter).
export function distinctCharacters(runs = []) {
  const seen = new Set();
  const out = [];
  for (const r of runs) {
    const c = (r?.character || "").trim();
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Same-day run count for the daily-limit indicator (raids cap how many times/day you can
// run them). Scoped to a character and optionally a raid. `now` defaults to today.
export function runsToday(runs = [], { character = "", raid = "", now = new Date() } = {}) {
  const day = (d) => new Date(d).toDateString();
  const today = day(now);
  const ch = character.trim().toLowerCase();
  return runs.filter((r) =>
    day(r.savedAt) === today &&
    (!ch || (r.character || "").trim().toLowerCase() === ch) &&
    (!raid || r.raid === raid)
  ).length;
}

// Aggregate stats over a set of runs. Value = snapshot totals; value/hour uses only the
// runs that recorded a duration (so untimed runs don't drag the rate to zero).
export function summarizeRuns(runs = []) {
  // `timedValue`/`timedDurationSec` accumulate ONLY runs that recorded a time, so value/hour
  // is computed strictly from timed runs (an untimed run's value never inflates the rate).
  const base = () => ({ count: 0, value: 0, gold: 0, durationSec: 0, pooledDurationSec: 0, timedValue: 0, timedDurationSec: 0, timedCount: 0, pooledValue: 0, timedPooledValue: 0, partyRuns: 0, pooledCount: 0, pooledTotalValue: 0 });
  const total = base();
  const perRaid = {}, perCharacter = {};
  // Pooled per-player value (SPEC §16.11): items pooled across the whole party ÷ party size,
  // plus the player's own gold (incl. live reward/core/level bonuses = total − itemsValue;
  // party gold is assumed equal, per design). A partyless run pools to its own total, so the
  // pooled average stays comparable across mixed histories while converging partySize× faster.
  // A ×N party run counts as N SAMPLES in the pooled view: `pooledCount` sums party sizes and
  // `pooledTotalValue` sums every player's assumed haul (pv × size), so pooled Runs/Total scale
  // with the party while pooledPerRun (= pooledTotalValue/pooledCount, a size-weighted mean)
  // and pooledPerHour stay per-player. TIME pools the same way (`pooledDurationSec` = Σ d × size,
  // every player spends the run's wall clock), so the pooled summary stays internally consistent:
  // total value ÷ total time still reads as the per-player rate.
  const pooled = (r) => {
    const size = r.partySize > 1 ? r.partySize : 1;
    const partyItems = (r.party || []).reduce((s, m) => s + (m.itemsValue || 0), 0);
    return ((r.itemsValue || 0) + partyItems) / size + ((r.total || 0) - (r.itemsValue || 0));
  };
  for (const r of runs) {
    const v = r.total || 0, g = r.gold || 0, d = r.durationSec > 0 ? r.durationSec : 0;
    const size = r.partySize > 1 ? r.partySize : 1;
    const pv = pooled(r);
    const raidB = (perRaid[r.raid || "—"] ??= base());
    // Per-raid Hero/Normal split (a Hero clear is still ONE run, this lets the By-raid view
    // list the two modes as separate rows, since Hero doubles drops but takes longer).
    const mode = r.mode === "Hero" ? "Hero" : "Normal";
    const mb = ((raidB.byMode ??= {})[mode] ??= base());
    for (const bucket of [total, raidB, (perCharacter[r.character || "—"] ??= base()), mb]) {
      bucket.count++; bucket.value += v; bucket.gold += g; bucket.durationSec += d; bucket.pooledDurationSec += d * size;
      bucket.pooledValue += pv; bucket.pooledCount += size; bucket.pooledTotalValue += pv * size;
      if (r.partySize > 1) bucket.partyRuns++;
      if (d > 0) { bucket.timedValue += v; bucket.timedDurationSec += d; bucket.timedCount++; bucket.timedPooledValue += pv; }
    }
  }
  const perHour = (b) => (b.timedDurationSec > 0 ? b.timedValue / (b.timedDurationSec / 3600) : null);
  const pooledPerHour = (b) => (b.timedDurationSec > 0 ? b.timedPooledValue / (b.timedDurationSec / 3600) : null);
  const finishBucket = (b) => ({ ...b, valuePerRun: b.count ? b.value / b.count : 0, valuePerHour: perHour(b), avgDurationSec: b.timedCount ? b.timedDurationSec / b.timedCount : null, pooledPerRun: b.pooledCount ? b.pooledTotalValue / b.pooledCount : 0, pooledPerHour: pooledPerHour(b) });
  const finish = (b) => {
    const out = finishBucket(b);
    if (b.byMode) out.byMode = Object.fromEntries(Object.entries(b.byMode).map(([m, mb]) => [m, finishBucket(mb)]));
    return out;
  };
  const mapVals = (o) => Object.fromEntries(Object.entries(o).map(([k, b]) => [k, finish(b)]));
  return {
    count: total.count,
    totalValue: total.value,
    pooledCount: total.pooledCount,          // Σ party sizes, every player's run is a sample (SPEC §16.11)
    totalPooledValue: total.pooledTotalValue, // Σ every player's assumed haul (pv × size)
    totalGold: total.gold,
    totalDurationSec: total.durationSec,
    totalPooledDurationSec: total.pooledDurationSec, // Σ d × party size, the pooled sample's clock
    valuePerRun: total.count ? total.value / total.count : 0,
    valuePerHour: perHour(total),
    pooledPerRun: total.pooledCount ? total.pooledTotalValue / total.pooledCount : 0,
    pooledPerHour: pooledPerHour(total),
    partyRuns: total.partyRuns,
    perRaid: mapVals(perRaid),
    perCharacter: mapVals(perCharacter),
  };
}

// core-source analysis (SPEC §16.9)
// Aggregate WHERE cores came from across saved runs, to answer "is each drop buff worth
// its cost". Only runs whose drops ALL carry a `source` are analyzed (records saved before
// source tracking exist but can't be attributed, they count in `runCount` only). Values
// are the runs' frozen save-time drop values (d.value; unpriced drops count cores, add 0).
//
// Costs are the CALLER's (config constants / live tracker prices). This stays pure:
//   campfireCost, gold per run (the buff is per-battle; tag presence ⇒ it was bought)
// Core Boost Plus's price and term live in the UI's settings, not here: they're a property of
// the player's account, not of the runs, so the caller does that arithmetic on `sources.plus`.
//
// TWO separate readings (the user's design): CONTRIBUTION = what each buff's tagged cores were
// actually worth (sources/campfire/vvip/plus/luck). WORTH-IT = EV-based: the marginal value of
// one extra core at a raid ≈ that raid+mode's AVERAGE core value (common cores are cheap; rare
// spikes carry the EV, a buff is worth it if avgCore beats its per-core cost, regardless of
// which items happened to carry the tag). Only campfire is scored here (`ev.campfire`): it's a
// per-battle purchase, so one more core at the mean value either beats its price or doesn't.
// VVIP and Core Boost Plus are deliberately NOT judged in this module. VVIP carries benefits
// well beyond core drops, so a core-only verdict would call it a loss for a sub worth holding
// regardless; Plus is an account-wide fixed-term purchase whose accounting needs a start date
// the runs don't carry. Both still have their cores TALLIED in `sources`.
// `pooled` (SPEC §16.11): also fold every party member's tagged cores into the core-VALUE sample
//, `perRaidMode` cores/value (→ a far larger, more reliable `avgCore`, which prices the worth-it
// EV) and the `sources` contribution cores/value (→ how much each buff yields at party scale).
// Pet cores are NEVER pooled (a party member's pet is their own buff, useless to your verdicts).
// The campfire ledger pools BOTH sides: a member's campfire core cost them the same 65k yours
// did, so pooling the earnings without the spend would read as free money.
// Deliberately NOT pooled: the `ev` run counts. Core Boost Plus is bought per account, so what
// a party member earns from their sub is not yours to collect; the worth-it decision stays
// anchored to YOUR runs while the per-core value estimate benefits from everyone's cores.
// Luck is tallied as a plain source (sources.luck), no per-level split, the player's Luck stat
// is no longer recorded. Returns { runCount, trackedCount, sources, perRaidMode, campfire,
// vvip, plus, ev }.
export function summarizeCoreSources(runs = [], { now = new Date(), windowDays = 30, campfireCost = 65000, pooled = false } = {}) {
  const cutoff = new Date(now).getTime() - windowDays * 86400_000;
  const inWindow = runs.filter((r) => new Date(r.savedAt).getTime() >= cutoff);
  const tracked = inWindow.filter((r) => (r.drops || []).length === 0 || (r.drops || []).every((d) => CORE_SOURCES.includes(d.source)));

  // `runsWith` counts run SAMPLES that yielded this source (pooled: each party member's run is
  // its own sample, so cores/value and the run count they divide by scale together).
  const srcBucket = () => Object.fromEntries(CORE_SOURCES.map((s) => [s, { cores: 0, value: 0, runsWith: 0 }]));
  const sources = srcBucket();
  const perRaidMode = {}; // "raid|mode" → { raid, mode, runs, timedDurationSec, timedCount, sources }
  const plusByMode = { Normal: { runs: 0, boosts: 0, cores: 0, value: 0 }, Hero: { runs: 0, boosts: 0, cores: 0, value: 0 } };

  for (const r of tracked) {
    const mode = r.mode === "Hero" ? "Hero" : "Normal";
    const key = `${r.raid || "—"}|${mode}`;
    const rm = (perRaidMode[key] ??= { raid: r.raid || "—", mode, runs: 0, cores: 0, value: 0, avgCore: null, timedDurationSec: 0, timedCount: 0, sources: srcBucket() });
    rm.runs++;
    if (r.durationSec > 0) { rm.timedDurationSec += r.durationSec; rm.timedCount++; }
    const runSrc = srcBucket();
    for (const d of r.drops || []) {
      const s = runSrc[d.source];
      s.cores += d.qty; s.value += d.value || 0;
      rm.cores += d.qty; rm.value += d.value || 0;
    }
    for (const src of CORE_SOURCES) {
      const s = runSrc[src];
      if (!s.cores) continue;
      for (const b of [sources[src], rm.sources[src]]) { b.cores += s.cores; b.value += s.value; b.runsWith++; }
    }
    // Plus boost efficiency: every character gets 10 core boosts/day (free, sub or not);
    // a boosted Hero run is believed to spend 2 of them, Normal 1, the split lets the data
    // confirm. Only runs that actually yielded Plus-tagged cores count, the tag is the proof
    // the sub was active (a boosted run without the sub proves nothing about Plus).
    if (runSrc.plus.cores > 0) {
      const pb = plusByMode[mode];
      pb.runs++; pb.boosts += mode === "Hero" ? 2 : 1; pb.cores += runSrc.plus.cores; pb.value += runSrc.plus.value;
    }
    // Pooled: each party member's run is another SAMPLE of the same raid, so their tagged cores
    // join the value sample AND bump `runsWith` (the per-run figures stay per-player that way,
    // instead of dividing four players' cores by your run count). A member's buffs are their
    // own: a Plus core in their list counts even on a run where you had no sub, which is the
    // point, it's more evidence about what Plus yields. Campfire spend rides `runsWith` too, so
    // their 65k is counted alongside yours. Pet cores are skipped entirely, another player's
    // pet says nothing about yours.
    if (pooled) {
      for (const m of r.party || []) {
        const memberSrc = srcBucket();
        for (const d of m.drops || []) {
          const src = CORE_SOURCES.includes(d.source) ? d.source : "base";
          if (src === "pet") continue;
          const s = memberSrc[src];
          s.cores += d.qty; s.value += d.value || 0;
          rm.cores += d.qty; rm.value += d.value || 0;
        }
        for (const src of CORE_SOURCES) {
          const s = memberSrc[src];
          if (!s.cores) continue;
          for (const b of [sources[src], rm.sources[src]]) { b.cores += s.cores; b.value += s.value; b.runsWith++; }
        }
      }
    }
  }

  // Average core value per raid+mode bucket, the EV of one marginal core there.
  for (const rm of Object.values(perRaidMode)) rm.avgCore = rm.cores > 0 ? rm.value / rm.cores : null;
  // EV worth-it aggregates. Run counts are ALWAYS the player's own runs (Core Boost Plus is
  // bought per account: what a party member earns from their sub isn't yours to collect), so
  // these never pool. The per-core value (avgCore) does pool when `pooled` is on, so pooling
  // sharpens the estimate of what each extra core is worth without inflating how often you'd
  // get one.
  //   campfire: one more core at the raids you actually ran ≈ mean avgCore, vs its per-buy cost
  //   plus: +3 cores per boosted battle, counted only on runs where a Plus tag appeared
  // VVIP is absent by design, see the header note: its non-drop benefits dominate the decision.
  //
  // TIME NORMALIZATION: a subscription is priced per period, but the runs in the window may
  // span far less than that period (2 days of logs vs a 30-day price reads as a huge loss
  // purely because the data is young). So earnings are converted to a DAILY rate over
  // `daySpan` (the actual span the tracked runs cover, at least one day), and the cost is
  // converted to its own daily rate. Both sides are then per-day and directly comparable, and
  // the verdict is meaningful from the first day of tracking.
  const stamps = tracked.map((r) => new Date(r.savedAt).getTime()).filter((t) => Number.isFinite(t));
  const daySpan = stamps.length ? Math.max(1, (Math.max(...stamps) - Math.min(...stamps)) / 86400_000) : 1;
  const ev = {
    daySpan,
    campfire: { runs: 0, value: 0, avg: null, cost: campfireCost, net: null },
  };
  for (const r of tracked) {
    const mode = r.mode === "Hero" ? "Hero" : "Normal";
    const avgCore = perRaidMode[`${r.raid || "—"}|${mode}`].avgCore;
    if (avgCore == null) continue;
    ev.campfire.runs++; ev.campfire.value += avgCore;
  }
  // Campfire is a per-battle buy, not a subscription: no time normalization, just core vs cost.
  if (ev.campfire.runs) { ev.campfire.avg = ev.campfire.value / ev.campfire.runs; ev.campfire.net = ev.campfire.avg - campfireCost; }

  // Contribution (observed tagged cores). Campfire's `cost` is the spend those cores implied
  // (tag ⇒ a campfire was bought), priced off the CORE count: one campfire yields exactly one
  // core, so cores are what you paid 65k apiece for. Counting runs instead would undercharge a
  // run that logged two campfire cores. This also scales with pooling for free, since a party
  // member's campfire core cost them the identical 65k, and pooling has to move both sides or
  // the net reads as free money.
  const campfire = {
    runsWith: sources.campfire.runsWith,
    cores: sources.campfire.cores, value: sources.campfire.value,
    cost: sources.campfire.cores * campfireCost, costPerRun: campfireCost,
  };
  const vvip = { runsWith: sources.vvip.runsWith, cores: sources.vvip.cores, value: sources.vvip.value };
  const plusValue = sources.plus.value;
  const plus = {
    runsWith: sources.plus.runsWith, cores: sources.plus.cores, value: plusValue,
    boosts: plusByMode.Normal.boosts + plusByMode.Hero.boosts,
    valuePerBoostedRun: sources.plus.runsWith ? plusValue / sources.plus.runsWith : null,
    byMode: plusByMode, // price/term are the caller's (account settings), not the runs'
  };
  return { windowDays, pooled, runCount: inWindow.length, trackedCount: tracked.length, sources, perRaidMode, campfire, vvip, plus, ev };
}

// Run-level TSV export (paste into a Sheet for long-term storage). One row per run.
// Drops carry their core-source tag as a suffix ("Item×2 [luck]"; base cores bare).
export function runsToTSV(runs = []) {
  const header = ["Date", "Name", "Character", "Raid", "Mode", "Core boost", "Max level", "Duration (min)", "Items value", "Gold", "Run reward", "Core gold", "Level cap bonus", "Total", "Party size", "Party items value", "Drops", "Party drops"];
  const rows = runs.map((r) => [
    new Date(r.savedAt).toISOString().slice(0, 10),
    r.name,
    r.character,
    r.raid,
    r.mode || "Normal",
    r.coreBoost ? "Yes" : "",
    r.maxLevel ? "Yes" : "",
    r.durationSec == null ? "" : (r.durationSec / 60).toFixed(1),
    Math.round(r.itemsValue),
    r.gold,
    Math.round(r.baseGold || 0),  // flat per-run gold reward (looked up live; folded into Total below)
    Math.round(r.coreGold || 0),  // core-boost gold (only when the run was boosted; folded into Total)
    Math.round(r.levelBonus || 0), // +20% level-cap bonus on reward+core gold (only when maxLevel; folded into Total)
    Math.round(r.total),
    r.partySize > 1 ? r.partySize : "",
    r.party?.length ? Math.round(r.party.reduce((s, m) => s + (m.itemsValue || 0), 0)) : "",
    (r.drops || []).map((d) => `${d.name}×${d.qty}${d.source && d.source !== "base" ? ` [${d.source}]` : ""}`).join("; "),
    (r.party || []).map((m) => `${m.actor}: ${m.drops.map((d) => `${d.name}×${d.qty}${d.source && d.source !== "base" ? ` [${d.source}]` : ""}`).join(", ")}`).join("; "),
  ]);
  return [header, ...rows].map((row) => row.map((c) => tsvCell(c)).join("\t")).join("\n");
}

const tsvCell = (s) => String(s).replace(/[\t\n]/g, " ");

// price store (accumulates across screenshots)

// Outlier rejection: with ≥2 prices all ≥ 5M, drop any > 5× the median so one absurd
// listing can't inflate the average. If everything would be filtered, keep the original.
function cleanPrices(prices) {
  if (prices.length < 2 || Math.min(...prices) < 5_000_000) return prices;
  const s = [...prices].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const threshold = median * 5;
  const filtered = prices.filter((p) => p <= threshold);
  return filtered.length ? filtered : prices;
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

export function makeStore() {
  const data = new Map(); // name → number[]
  return {
    data,
    add(entries) {
      for (const { name, price } of entries) {
        if (!data.has(name)) data.set(name, []);
        data.get(name).push(price);
      }
    },
    clear() { data.clear(); },
    // Drop every listing recorded under `name` (the Scanner review UI's "discard" action).
    remove(name) { data.delete(name); },
    // Move `from`'s listings onto `to` (the review UI corrects a misread name to the real item):
    // merge into any existing `to` bucket, then drop `from`. No-op if `from` isn't present.
    relabel(from, to) {
      if (from === to || !data.has(from)) return;
      const moved = data.get(from);
      data.delete(from);
      if (!data.has(to)) data.set(to, []);
      data.get(to).push(...moved);
    },
    get itemCount() { return data.size; },
    get listingCount() { let n = 0; for (const v of data.values()) n += v.length; return n; },
    summary() {
      const rows = [];
      for (const [name, prices] of data) {
        const c = cleanPrices(prices);
        rows.push({ name, avg: Math.round(c.reduce((a, b) => a + b, 0) / c.length), min: Math.min(...c), count: c.length });
      }
      rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return rows;
    },
    // Copy-for-Sheets only needs Date, Item, Min (avg/listings stay in the table + CSV).
    toTSV() { const t = todayIso(); return this.summary().map((r) => `${t}\t${r.name}\t${r.min}`).join("\n"); },
    toCSV() {
      const t = todayIso();
      const lines = ["Date,Item,Avg,Min,Listings"];
      for (const r of this.summary()) lines.push([t, csvCell(r.name), r.avg, r.min, r.count].join(","));
      return lines.join("\n");
    },
  };
}
