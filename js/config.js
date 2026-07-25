// Single source of truth for game constants and data sources.
// Per CLAUDE.md: ranking weights live in ONE place and are referenced everywhere.

// The whole Google Sheet is published to web, so every tab shares this base and
// differs only by gid.
const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQR4KY8Cramu8kyf5cW29DeCucTRJopno6cEjcNYkf3R-GyPukyMWZB1PJ5dCeXZ8S2YG76l2vGdic0/pub";
const tabCsv = (gid) => `${SHEET_BASE}?gid=${gid}&single=true&output=csv`;

// Ranking weights (fixed game constants, SPEC §2)
export const RANKING_WEIGHTS = Object.freeze({
  att: 1,
  def: 1,
  destruction: 8,
  addDmg: 8,
  crit: 300,
  critRes: 125,
  bal: 300,
  attSpd: 300,
  defPen: 50,
});

// Current character totals
// Seeds Threshold mode's "current" column so absolute targets ("Crit ≥ 320")
// compute a gap. The app can't fully DERIVE these from scratch (character base
// stats / set bonuses / infusions aren't in the data), so they're a hand-entered
// snapshot. The live totals are editable in the SIDEBAR and persisted under
// CURRENT_STATS_STORAGE_KEY; editing a gear slot also applies that slot's stat
// DELTA (old config → new config) on top of this seed.
//
// The SEED IS BLANK (all zero). A first-time visitor starts with an empty
// character, not someone else's stats. Fill it in via the sidebar, or apply a
// GEAR_PRESETS kit (which brings its own stat snapshot).
export const CURRENT_STATS = Object.freeze({
  att: 0,
  def: 0,
  destruction: 0,
  addDmg: 0,
  crit: 0,
  critRes: 0,
  bal: 0,
  attSpd: 0,
  defPen: 0,
});

// Price feed (main pricing tab, one row per item, deduped from the log)
export const PRICE_CSV_URL = tabCsv(948265913);
export const PRICE_CSV_FALLBACK = "data/prices.csv";

// Header names in the published sheet → fields we keep. Parsed by name, so the
// column order in the sheet can change without breaking anything.
export const PRICE_COLUMNS = Object.freeze({
  name: "Item",
  min: "Latest Min",        // cheapest current listing (volatile; used for deal flag)
  avg: "Rolling Avg (Min)", // smoothed across snapshots (the cost basis, see PRICE_BASIS)
  date: "Latest Date",
  trend: "Min Trend",
  ath: "ATH Min",
  atl: "ATL Min",
  snapshots: "# Snapshots",
});

// Which price the cost model uses everywhere: "avg" (Rolling Avg Min, stable,
// matches the user's sheet) or "min" (Latest Min, true current floor).
export const PRICE_BASIS = "avg";

// Flag a price as a "deal" when the Latest Min sits this far below the Rolling
// Avg (i.e. an unusually cheap listing right now).
export const DEAL_DISCOUNT_THRESHOLD = 0.15;

// Enchants tab (96 rows = one per unique scroll)
// Applicability is encoded by `Slot` (expanded to slot ids via TAG_TO_SLOT_IDS),
// not by per-slot fan-out rows. `Family` groups a slot's scrolls into upgrade
// chains / effect sets (blank = the "default" family, see below). `Level` is the
// minimum ITEM level a scroll can be applied to (blank = no requirement). Prices
// (scroll + scrap) come from the price feed, not this tab.
export const ENCHANT_CSV_URL = tabCsv(288842640);
export const ENCHANT_CSV_FALLBACK = "data/enchants.csv";

export const ENCHANT_COL_WIDTH = 17;
export const ENCHANT_COLUMNS = Object.freeze({
  name: "Enchant",      // matches the scroll's marketplace name in the price feed
  tag: "Slot",          // slot-group; expands to slot ids via TAG_TO_SLOT_IDS
  minLevel: "Level",    // minimum item level the scroll can go on (blank → no requirement)
  family: "Family",     // upgrade-chain / effect group within a slot (blank = default family)
  affix: "P/S",         // P = prefix, S = suffix (one of each per item)
  rank: "R",
  effect: "Effect",
});

// Enchant stat column → scored-stat key (SPEC §2). HP/Stm are intentionally
// omitted: they are not scored. (Def Pen was dropped from the tab, no scroll
// uses it.)
export const ENCHANT_STAT_COLUMNS = Object.freeze({
  Att: "att",
  Def: "def",
  Crit: "crit",
  "Crit Res": "critRes",
  "Add Dmg": "addDmg",
  Bal: "bal",
  "Att Spd": "attSpd",
  Dest: "destruction",
});

// Enchant Slot group → applicable slot ids (SPEC §3 slot ids). A scroll's `Slot`
// cell names the group of slots it can be applied to; the loader expands it into
// `appliesTo`. Accessory scrolls also apply to rhod; rhod-only scrolls do NOT apply
// to other accessories. Groups nest (Armor ⊃ Chest/Helm&Pants/Gloves&Boots;
// Accessory ⊃ Artifact/Belt/Rings/Belt&Rings/Brooch) but each scroll carries the one
// group that matches its actual applicable-slot set.
export const TAG_TO_SLOT_IDS = Object.freeze({
  Weapon: ["weapon"],
  Rhod: ["rhod"],
  Armor: ["helm", "chest", "pant", "hand", "feet"],
  "Helm & Pants": ["helm", "pant"],
  Chest: ["chest"],
  "Gloves & Boots": ["hand", "feet"],
  Accessory: ["earrings", "belt", "brooch", "necklace", "ring1", "ring2", "artifact", "rhod"],
  Artifact: ["artifact"],
  Belt: ["belt"],
  "Belt & Rings": ["belt", "ring1", "ring2"],
  Rings: ["ring1", "ring2"],
  Brooch: ["brooch"],
  Totem: ["totem"],
  // Legacy scrolls tracked for pricing/catalog only: classified as Enchant in the
  // Gear tab but applicable to no slot, so they never surface as upgrade moves,
  // in scroll dropdowns, or in the Appraiser/Planner candidates.
  Legacy: [],
});

// Crafting tab (recipe per craftable item, now incl. advancement tier chains)
// One unified tab: ordinary craftables AND the weapon/armor tier-chain recipes
// (SPEC §4) live here, since both are "just crafting". Layout: Item | Gold(flat
// fee) | [Item N, #]×8, each material is a name + qty ("#") pair (no per-line "$"
// total or "Craft/MP Price" snapshot columns; the app recomputes craft cost live
// from the price feed). We keep only the material name + qty; the flat fee comes
// from "Gold" (blank ⇒ 0). The recursive craftCost rolls up tier chains because a
// tier's recipe lists the PREVIOUS tier as a material (e.g. "Fine Uaithne Helm"
// requires "Beginner Uaithne Helm"). NOTE: only the COST side is live, tierStep
// move-generation is still blocked on other data (system-jump enchant-wipe flag,
// unpriced Premium Enhancement Runes, partial chain), even though some tier items
// now carry stat lines on the Gear tab (SPEC §4 / §12).
export const CRAFTING_CSV_URL = tabCsv(1517243497);
export const CRAFTING_CSV_FALLBACK = "data/crafting.csv";
export const CRAFTING_COLUMNS = Object.freeze({
  name: "Item",
  fee: "Gold",           // flat crafting fee (blank → 0)
});
export const CRAFTING_MAX_MATERIALS = 8; // "Item 1..8" each followed by "#"

// A tier chain's "+15 Orna <slot>" baseline is assumed already owned / free (SPEC
// §4), so when it appears as a recipe material it is NOT added as a priced leaf
// (else it would be an unpriceable material that breaks the whole chain's cost).
export const CRAFTING_BASELINE_RE = /^\+?\s*15\s+orna\b/i;

// Gear tab (full candidate stat lines per slot)
// Slot labels map through SLOT_NAME_TO_ID. A single Slot cell may list more than
// one slot ("Ring 1, Ring 2"). The loader splits on commas. HP/Stam are present
// in the sheet but intentionally not parsed (not scored, SPEC §2). Stat columns
// use the long headers (ITEM_STAT_COLUMNS). The Enchants tab now uses short ones,
// so the two no longer share a column map.
export const GEAR_CSV_URL = tabCsv(1054482569);
export const GEAR_CSV_FALLBACK = "data/gear.csv";
export const ITEMS_COLUMNS = Object.freeze({
  name: "Item",   // marketplace name; key into the price feed
  level: "Level", // item level (informational / within-slot ordering)
  slot: "Slot",   // one or more slot labels, comma-separated
  effect: "Effect",
});

// Gear-tab stat column → scored-stat key (SPEC §2). Distinct from
// ENCHANT_STAT_COLUMNS: this tab still carries the long headers and a Def Pen col.
export const ITEM_STAT_COLUMNS = Object.freeze({
  Attack: "att",
  Defense: "def",
  Crit: "crit",
  "Crit Res": "critRes",
  "Add Dmg": "addDmg",
  "Def Pen": "defPen",
  Bal: "bal",
  "Att Spd": "attSpd",
  Dest: "destruction",
});

// Set bonuses (SPEC §13)
// Weapon + armor set effect: wearing N of the 6 tier slots (weapon + 5 armor) in
// one gear system (Orna / Uaithne / Eriu) grants that system's N-piece bonus.
// Values in the tab are the TOTAL bonus AT N pieces (not incremental). You get
// exactly the row matching your current piece count. Only the SCORED stat columns
// (SPEC §2) are consumed; HP/Stam/STR/AGI/INT/WIL are carried in the sheet but not
// scored. The tab keys rows by the bare system word ("Uaithne"); an item's system
// is DERIVED from its name (see itemSystem() in utils.js) and the UI labels it
// "<System> Set". Ring set bonuses (§13.1) are NOT here yet, no ring-set data.
export const SETBONUS_CSV_URL = tabCsv(2101289643);
export const SETBONUS_CSV_FALLBACK = "data/setbonuses.csv";
export const SETBONUS_COLUMNS = Object.freeze({
  set: "Set",       // bare system word (Orna / Uaithne / Eriu)
  pieces: "Pieces", // piece-count tier (1..6)
});
// SetBonuses stat column → scored-stat key (SPEC §2). Same keys as RANKING_WEIGHTS;
// only populated columns contribute (currently Def + Bal, the rest are blank).
export const SETBONUS_STAT_COLUMNS = Object.freeze({
  Att: "att", Def: "def", Crit: "crit", "Crit Res": "critRes",
  "Add Dmg": "addDmg", "Def Pen": "defPen", Bal: "bal",
  "Att Spd": "attSpd", Dest: "destruction",
});

// The gear systems that participate in a weapon/armor set bonus, longest-name first
// so itemSystem() matches "Uaithne" before any shorter substring. An item's system
// is the one of these whose name appears in the item name; displayed as "<sys> Set".
export const GEAR_SYSTEMS = Object.freeze(["Uaithne", "Eriu", "Orna"]);

// Tuning (SPEC §12 tuneStep)
// Lv.90+ weapon/armor gain bonus stats by "tuning": a flat gold + material cost per
// tick adds `Step` to a stat up to a `MaxTune` total increase. Rows are keyed per
// (system base × stat). E.g. "Uaithne Helm", "Orna Weapon". So all tiers within a
// system share the same tuning rows (a base's tuning key strips its tier word + "+N"
// baseline prefix via tuningKey() in utils.js). Material name/qty pairs reuse the
// Crafting convention. `Unlock` gates the cumulative climb: 0 = base stats (tune
// freely), 1 = ATT Surplus I (only after every 0 stat is maxed), 2 = ATT Surplus II
// (after 1 maxed). Gear tab holds UNTUNED stats; tuning layers on top.
export const TUNING_CSV_URL = tabCsv(1326632211);
export const TUNING_CSV_FALLBACK = "data/tuning.csv";
export const TUNING_COLUMNS = Object.freeze({
  item: "Item", stat: "Stat", step: "Step", maxTune: "MaxTune", gold: "Gold", unlock: "Unlock",
});
export const TUNING_MAX_MATERIALS = 5; // "Mat 1..5" each followed by "#"

// Tuning in-game stat label → scored-stat key (SPEC §2). ATT Surplus / DES /
// Destruction (I, II, or Orna's single un-numbered one) ALL map to `destruction`
// (w8). The item UI labels it "ATT Surplus" but it IS the final-damage stat. The
// loader accepts every spelling; we keep "ATT Surplus I/II" as the canonical label.
export const TUNING_STAT_TO_KEY = Object.freeze({
  "ATT/M. ATT": "att",
  DEF: "def",
  BAL: "bal",
  "CRIT RTE": "crit",
  "CRIT RST": "critRes",
  "ATT SPD": "attSpd",
  "ATT Surplus I": "destruction",
  "ATT Surplus II": "destruction",
  "ATT Surplus": "destruction",
  "DES I": "destruction",
  "DES II": "destruction",
  "Dest I": "destruction",
  "Dest II": "destruction",
  "Destruction I": "destruction",
  "Destruction II": "destruction",
});

// Stable comparison TOKEN for a tuning stat LABEL. The destruction capstone has been renamed
// across patches (ATT Surplus → DES → Dest), so a loadout's persisted tuning (keyed by the
// label that was current when it was saved) can mismatch the live sheet's row labels. Matching
// a saved tuning amount to its row by RAW label then silently fails, `reTuneCost` returns null
// ("—") and `amountOf` reads 0. Canonicalizing BOTH sides to this token before comparing makes
// the match survive any rename. Non-destruction labels (DEF, CRIT RST, …) never changed → they
// pass through unchanged and still match exactly. (Orna's single un-numbered "ATT Surplus" =
// Dest I.) Keep the tier distinction (I vs II). They are separate, independently-tuned rows.
export const TUNING_STAT_CANON = Object.freeze({
  "ATT Surplus I": "dest1", "DES I": "dest1", "Dest I": "dest1", "Destruction I": "dest1", "ATT Surplus": "dest1",
  "ATT Surplus II": "dest2", "DES II": "dest2", "Dest II": "dest2", "Destruction II": "dest2",
});
export const tuneStatCanon = (label) => TUNING_STAT_CANON[label] || label;

// Enhancement (SPEC §12 gear +N→+15)
// Weapon/armor enhancement steps (currently +12→+15 on the Orna baseline). Each
// row = one +level step: absolute per-attempt success rates (Base = the 1st
// attempt, Fail1..N = the rate AFTER N consecutive failures, last col = 100 =
// guaranteed), a flat gold fee + materials consumed PER attempt. Failure KEEPS the
// level (no downgrade) → each step is a finite EV series (gearEnhanceCost in
// cost.js). Rates are community-sourced (Nexon hides them in-game) so they live in
// the Sheet, editable without a code change. Materials must be in the price feed.
export const ENHANCEMENT_CSV_URL = tabCsv(2053049296); // the Sheet's "Orna" tab
export const ENHANCEMENT_CSV_FALLBACK = "data/orna.csv";
export const ENHANCEMENT_COLUMNS = Object.freeze({
  from: "From", to: "To", base: "Base", gold: "Gold",
});
export const ENHANCEMENT_MAX_FAILS = 5;     // "Fail1..5" absolute per-attempt rate columns
export const ENHANCEMENT_MAX_MATERIALS = 2; // "Material N" + "Qty N" pairs
// The +level every tier chain's Orna baseline material assumes owned (a +15 Orna
// piece). A loadout piece below this must be enhanced up to it first, adding the
// gearEnhanceCost EV to the Orna→Uaithne tierStep (SPEC §12).
export const ENHANCE_TARGET_LEVEL = 15;

// Enchant cost model (SPEC §5.3)
// Success rate by rank: numeric rank ≥ 8 (and the future 9) is 100%; ranks 1–7
// are 40% (1–2 don't exist yet, assumed 40%); letter ranks (A/B/C…) are 100%.
export const ENCHANT_SUCCESS_BASE = 0.40;
export const ENCHANT_GUARANTEED_RANK = 8; // numeric rank at/above which p = 1.0

// Guaranteed alternative to spamming: 4 scraps → 100% (consumes the 4 scraps).
export const SCRAP_GUARANTEE_COUNT = 4;

// Exquisite rune path: scroll + rune → 100% (consumes both). Priced live once
// this exact name appears in the feed; until then the path is skipped.
export const EXQUISITE_RUNE_NAME = "Airtight Exquisite Enchant Rune";

// Base protect rune ("Enchant Rune"): consumed only on a FAILED enchant, never
// on success. Effectively unpriceable (most players stockpile them), so it
// defaults to 0 and is a tunable knob.
export const PROTECT_RUNE_COST = 0;

// A failed enchant yields one scrap, which can be sold. Realized resale =
// scrapPrice × (1 − fee); the marketplace takes 5% on a sale.
export const SCRAP_SALE_FEE = 0.05;

// Base enhancement rune (the weapon/armor tier-chain material, craft-only. NOT
// the enchant-protect "Enchant Rune" above). It occasionally drops free, and a
// player may hold a stockpile. By default it is priced at its real craft cost
// (the coster's automatic min(market, craft)); the UI "free Enhancement Runes"
// toggle forces its cost to 0 for players running off a stockpile. Only the BASE
// rune is freed, the Premium variants are always crafted from it. Default below
// is the toggle's initial state; flip to true to treat them as free on load.
export const ENHANCEMENT_RUNE_NAME = "Enhancement Rune";
export const FREE_ENHANCEMENT_RUNE_DEFAULT = false;

// Extraction rune (SPEC §3/§4): on a wipe tier jump (system change), armor/weapon
// can PRESERVE both current enchants by consuming ONE extraction rune instead of
// re-buying every kept affix. ONE rune saves BOTH affixes (not per-affix), so the
// preservation cost of a wipe = min(Σ re-enchant kept affixes, one rune). Priced
// off the market like any item via the coster (min(market, craft)); if it can't be
// priced the re-enchant path is used. Accessories/special slots have NO extraction
// rune (§3) and always re-enchant. The wipe warning ("rebase?") fires only when the
// re-enchant path is the cheaper/only one, i.e. preserving is NOT cheap.
export const EXTRACTION_RUNE_NAME = "Airtight Extraction Rune 1x";

// Raid essences (SPEC §4/§5.2): the per-boss tier-chain materials handed out by
// WEEKLY raids, most players acquire them for free rather than buying off the
// market, which dominates the cost of every weapon/armor advance. Like the base
// enhancement rune, these are forced to cost 0 via the coster's `freeItems` set,
// toggled by the UI "free raid essences" checkbox (default below). They are leaf
// materials, so zeroing them re-prices the whole tier chain through the recursion.
// (A future refinement could ask the player how many of EACH they hold and only
// zero up to that count; for now it's an all-or-nothing stockpile toggle.)
export const FREE_RAID_ESSENCES = Object.freeze([
  "Sreng's Essence", "Spinos' Essence", "Gorbas' Essence", "Morgant's Essence",
  "Lucian's Essence", "Semias' Essence", "Uscias' Essence",
]);
export const FREE_RAID_ESSENCES_DEFAULT = false;

// User-marked free items (SPEC §17.9)
// Beyond the two built-in stockpile toggles above, the player can flag ANY individual item as
// FREE (they have a stash, a free scroll, a leftover material) via a checkbox in the Planner's
// materials panel. These names are added to the coster's live `freeItems` set on top of the
// toggle-driven ones, so the item prices at 0 EVERYWHERE (planner, Upgrades, Target, catalog;
// consistent cost model). Stored as an array of item names, GLOBAL (not per-character). This is
// the SIXTEENTH allowed localStorage key; an empty list is the no-op default.
export const FREE_ITEMS_STORAGE_KEY = "vgu.freeitems.v1";

// Leading tier adjectives on weapon/armor tier items ("Beginner Uaithne Helm",
// "Legendary Uaithne Weapon"). Stripped to derive an item's chain FAMILY so the
// Items tab can group same-chain tiers together ("Uaithne Helm" gathers all six).
// Distinct from FAMILY_TIER_WORDS (artifact/rhod tiers) above.
export const ITEM_TIER_WORDS = Object.freeze([
  "beginner", "fine", "superior", "rare", "legendary",
]);

// Accessory slots (SPEC §3): the only category you improve by buying/crafting a
// different BASE item (baseSwap). Weapon/armor are craft-only tier chains (no base
// decision); artifact/rhod are out of the optimizer; bracelets are parked. These
// are also the slots that take enchants without tier-jump complications, so they
// drive both move types in v1.
export const ACCESSORY_SLOT_IDS = Object.freeze([
  "necklace", "totem", "brooch", "ring1", "ring2", "belt", "earrings",
]);

// The subset of accessory slots that can be ENHANCED 0→20 (SPEC §3 "Accessory
// (enhanceable)"). necklace/totem/brooch are enchant-only and never enhanced.
export const ENHANCEABLE_SLOT_IDS = Object.freeze(["ring1", "ring2", "belt", "earrings"]);

// The two ring slots, a matched pair (two DIFFERENT rings of the same level) grants a
// ring set bonus (SPEC §13.1). Used by solver ringsOf() + ring baseSwap set-delta.
export const RING_SLOT_IDS = Object.freeze(["ring1", "ring2"]);

// Weapon + armor slots: upgraded by CRAFTING the next tier in a chain (SPEC §4),
// NOT by a free base swap. These drive `tierStep` moves (solver.js). A slot only
// generates tier steps when its current base has a next tier with recipe + stat
// data; slots whose chain data is absent simply emit none.
export const TIER_SLOT_IDS = Object.freeze(["weapon", "helm", "chest", "pant", "hand", "feet"]);

// Special slots (SPEC §3): artifact + rhod. They take enchants (enchantSwap) AND
// allow priced base swaps, but with their own rules (SPEC §6 specialBaseSwap): swaps
// stay WITHIN the equipped item's family (a cat statue upgrades to a better cat
// statue, never a werewolf paw), and the unobtainable "Complete <name>" variant is
// excluded. Cost is the normal min(market, craft) like accessory baseSwap; these
// items ARE in the price feed (only the Complete tier is unlisted). They live in
// their own SPECIAL_SLOT_IDS (not ACCESSORY_SLOT_IDS) only to route through the
// family-restricted specialBaseSwap instead of the plain accessory baseSwap.
export const SPECIAL_SLOT_IDS = Object.freeze(["artifact", "rhod"]);

// "Complete <name>" artifact/rhod variants are time-gated behind high-level content
// and never listed → excluded from specialBaseSwap candidates (also unpriceable).
export const COMPLETE_VARIANT_RE = /\bcomplete\b/i;

// Tier adjectives stripped (along with the leading possessive owner phrase, e.g.
// "Usurper's", "Fallen One's", "The Watcher's") to derive an item's family:
// the shared core name that groups same-effect variants. See itemFamily() in utils.js.
export const FAMILY_TIER_WORDS = Object.freeze(["rusty", "shiny", "glowing", "complete", "greater"]);

// Accessory enhancement tables (SPEC §6 enhanceStep)
// Snapshot-only for now: this tab is hand-maintained and has no published gid, so
// the live URL is null and the loader reads the committed CSV directly. The file
// holds a shared "Chances" pity table (level × consecutive-fail bonus, additive %
// points; a 100 sentinel = guaranteed) plus one stat/cost table per item-level
// bracket (105/110/115/120/125), each level 1-20 giving Success Rate, Att, Def Pen,
// flat Gold fee, and material quantities. Failure keeps the level (no downgrade),
// so step cost is a finite expected-value series. See SPEC §6 + §12.
export const ACCESSORIES_CSV_URL = tabCsv(442417469); // "Accessories" tab; CSV layout matches data/accessories.csv
export const ACCESSORIES_CSV_FALLBACK = "data/accessories.csv";
// Fixed (non-material) columns in each bracket's table, by position; material
// columns follow and are named per-bracket by their own header row.
export const ACCESSORY_ENHANCE_COLUMNS = Object.freeze({
  level: 0, successRate: 1, att: 2, defPen: 3, gold: 4, firstMaterial: 5,
});

// Raid Info tab (SPEC §7.2 "raid targets")
// One row per raid. Two families of stat columns drive Threshold "Raid" mode:
//   QB ...  = Quick-Battle ENTRY minimums (floors, you need ≥ to queue).
//   ... Cap = the point beyond which a stat stops helping THIS raid (ceiling:
//             aim FOR the cap; over-capping is wasted). Cap ≥ its QB floor in the
//             data, so where a stat has both, the cap is the effective target.
// A raid's `targets` (built in js/raids.js) = QB floors, with bal/crit/critRes
// raised to their caps. NOTE: the sheet ALSO carries Crit Rate / Crit Res / Bal
// Res / Def (no QB/Cap prefix) columns, intentionally NOT used (no defined role
// yet; never invent data). QB ALR maps to `destruction` but is currently 0 for
// every raid, so it imposes no constraint until the sheet fills it in.
// Rows are sorted ascending difficulty in the loader (the sheet lists them
// hardest→easiest), so "next raid" = the easiest one whose QB floors you don't meet.
export const RAID_INFO_CSV_URL = tabCsv(0);
export const RAID_INFO_CSV_FALLBACK = "data/raid_info.csv";
export const RAID_INFO_COLUMNS = Object.freeze({
  name: "Raid",
  level: "Level",
  type: "Type", // Raid / Special / RAR / RME, used to group the Scanner raid picker
});
// OPTIONAL column: whether the raid has a Hero version (doubled HP + drops). Read
// leniently by header name so raid loading still works before the column is added
// (absent → hero:false). Truthy cell = yes/y/true/1/hero. When present, the Scanner
// drop tracker defaults new runs to Hero and offers a Normal/Hero toggle. Raids whose
// NAME already contains "hero"/"normal" are a single fixed mode (no toggle). E.g. a
// separately-listed "RME Hero" vs "RME Normal" when hero changes the requirements.
export const RAID_HERO_COLUMN = "Hero";
// OPTIONAL columns: the FLAT gold reward for completing the run, per mode (separate from the
// per-drop chat-log gold). Read leniently by header name so raids load before the columns are
// added (absent/blank → 0). Applied LIVE to saved runs, a run's base gold is looked up from
// the raid data at display time, NOT frozen at save, so filling a value in later automatically
// updates every past run of that raid+mode. The player adds each value once they've done the run.
export const RAID_GOLD_COLUMNS = Object.freeze({
  goldNormal: "Normal Gold",
  goldHero: "Hero Gold",
});
// OPTIONAL column: extra gold if you CORE BOOST the run (mode-independent). Applied LIVE too, but
// only when the run's `coreBoost` flag is set (a per-run checkbox). So it adds on top of the
// mode's base gold for boosted runs and leaves un-boosted runs unchanged.
export const RAID_CORE_GOLD_COLUMN = "Core Gold";
// Level-cap bonus: a max-level character earns an extra 20% on the raid's gold reward. Applied LIVE,
// only when the run's `maxLevel` flag is set (a per-CHARACTER checkbox, see MAXLEVEL_STORAGE_KEY). It
// multiplies the run reward + core gold (the deterministic gold the app models), not the chat-log gold.
export const LEVEL_CAP_GOLD_BONUS = 0.2;
// QB <header> → scored stat key (entry FLOORS).
export const RAID_QB_COLUMNS = Object.freeze({
  att: "QB Att", def: "QB Def", crit: "QB Crit", bal: "QB Bal",
  addDmg: "QB ADD", defPen: "QB Pen", destruction: "QB ALR",
});
// <header> → scored stat key (CEILINGS; override the QB floor where present).
export const RAID_CAP_COLUMNS = Object.freeze({
  bal: "Bal Cap", crit: "Crit Cap", critRes: "Crit Res Cap",
});
// OPTIONAL bare boss-stat columns (no QB/Cap prefix) → `boss{}` on each raid row.
// `Def` drives the Damage tab / DPS columns (SPEC §19); `Crit Res` is parsed now so a
// future crit-subtraction model needs no data change. Read leniently by header name
// (absent column / blank cell → field omitted); the user fills values from the
// in-game Battle (N) window per raid.
export const RAID_BOSS_COLUMNS = Object.freeze({
  def: "Def", critRes: "Crit Res",
});

// Raid Drops tab (SPEC §16.8)
// One row per (raid, dropped item). The canonical drop table for each raid/battle.
// Used by the Scanner raid-drop tracker: picking a raid scopes OCR name-matching to
// that raid's ~10–30 known drops (a tiny, exact vocabulary → far better than snapping
// against the whole app), and labels the run. Columns: Raid | Item.
export const RAID_DROPS_CSV_URL = tabCsv(869582791);
export const RAID_DROPS_CSV_FALLBACK = "data/raid_drops.csv";
export const RAID_DROPS_COLUMNS = Object.freeze({
  raid: "Raid",
  item: "Item",
});

// Seal Shop tab (SPEC §16.10, redemption-currency valuation)
// Some drops are untradeable "currencies" (Uaithne Seal, Seal of Bravery, event
// tokens) with no market price of their own, but they REDEEM for tradeable items at
// a fixed shop. One row per (currency, redeemable item): `Cost` seals buy a pack of
// `Count` items (blank Count → 1). A currency's implied per-unit value = the BEST
// (max) redemption: max over rows of price(item)·Count / Cost, priced live off the
// feed. Injected into `prices` at load so the drop tracker + catalog value seals like
// any other drop (sealshop.js → sealShopValues). `Stock` (weekly/daily cap; blank =
// unlimited) is carried for display only, it doesn't affect per-unit value. The tab
// has a SECOND "Cost" column + "Profit / Seal" (the user's own scratch math). Both
// ignored; headerIndex binds "Cost" to the FIRST match (the seals-per-pack column).
export const SEAL_SHOP_CSV_URL = tabCsv(24229037);
export const SEAL_SHOP_CSV_FALLBACK = "data/seal_shop.csv";
export const SEAL_SHOP_COLUMNS = Object.freeze({
  currency: "Seal or Ticket", // col A: the drop/currency we're pricing
  item: "Item",               // display/in-game reward name (e.g. "Uaithne Crystal Box")
  cost: "Cost",               // currency units per pack (first "Cost" column)
  stock: "Stock",             // purchase cap (blank = unlimited); display only
  count: "Count",             // items per pack (blank = 1)
  // Optional "Contains" column (price-feed key(s); A|B choose / A&B random / A+B bundle) is
  // looked up softly in rowsToSealShop so old sheets/snapshots without it still load.
});

// Legacy tab: old gear/materials/enchants no longer in circulation but still
// price-tracked. One row per name: `Item` (price-feed key), optional `P/S`
// (enchant affix), `Rank/Lvl`, `Stats` (old stat line, display text only, never
// scored). Names here render in the Items catalog as Legacy-kind rows (numeric
// columns blanked, hidden behind the Legacy chip) instead of Material rows.
// Purely cosmetic: pricing and craft-cost math never consult this tab.
export const LEGACY_CSV_URL = tabCsv(862737194);
export const LEGACY_CSV_FALLBACK = "data/legacy.csv";
export const LEGACY_COLUMNS = Object.freeze({
  name: "Item",
  type: "Type",   // Gear | Material | Enchant (display/sort grouping within the Legacy kind)
  affix: "P/S",
  rank: "Rank/Lvl",
  stats: "Stats",
});

// Weekly Boxes tab (SPEC §18, weekly free choice boxes)
// One free choice box per week per character that can run the qualifying raid;
// contents BIND (unsellable), claimed boxes never expire. One row per box:
// `Box` = menu entry, `Contains` = its contents in the Seal Shop grammar
// ("A | B" choice, "xN" quantity). Loader + advisor in js/weeklybox.js.
export const WEEKLY_BOX_CSV_URL = tabCsv(2010100274);
export const WEEKLY_BOX_CSV_FALLBACK = "data/weekly_boxes.csv";
export const WEEKLY_BOX_COLUMNS = Object.freeze({ box: "Box", contains: "Contains" });
// Weekly reset: Tuesday (UTC day 2) 07:00 UTC, anchors the schedule's week dates.
export const WEEKLY_BOX_RESET = Object.freeze({ day: 2, hourUTC: 7 });
// Horizon cap on the open/claim schedule (weeks). Demand beyond this reads
// "more than a year of boxes"; the planner reports it as uncovered instead.
export const WEEKLY_BOX_MAX_WEEKS = 52;
// Account state: { onHand: unopened boxes banked, alts: farming characters (boxes
// per week) }. GLOBAL, boxes ship account-wide via shared storage, so this is NOT
// profile-snapshotted. The SEVENTEENTH allowed localStorage key; {0,1} default.
export const WEEKLY_BOX_STORAGE_KEY = "vgu.weeklybox.v1";

// Player loadout (SPEC §9)
// DEFAULT SEED only. The app keeps a MUTABLE working copy (see index.html) that the
// user edits in-browser; edits persist in `localStorage` under LOADOUT_STORAGE_KEY
// and OVERRIDE this object per slot. "Reset to default" clears storage → falls back
// here. (This intentionally overturns the old "no browser-storage" rule for the
// loadout; SQLite via the `.pyw` path remains a later option. SPEC §9/§12.)
//
// Current gear per slot. prefix/suffix = scroll name (key into Enchants tab) or
// null (empty affix). base = base item name (key into Gear tab). enhance = current
// enhancement level + item-level bracket for enhanceable accessories (ring1/ring2/
// belt/earrings); bracket is derived from the item's level in the Gear tab.
// Weapon/armor `base` drives BOTH enchantSwap and tierStep (now LIVE for the full
// Uaithne system, every weapon/armor slot climbs Orna→Legendary). Artifact + Rhod
// are enchant-only (enchantSwap coverage; never enhanced, and their upgrade path
// ("Complete <name>" variants) is time-gated/unpriceable, so it stays OUT of the
// gold-per-point optimizer, informational flag only; see CLAUDE.md). Bracelets remain
// out of scope.
// The SEED IS BLANK, every slot empty (`{ base:null, prefix:null, suffix:null }`,
// which still renders + stays editable). A first-time visitor should see their OWN
// (empty) character, not a hardcoded one. Fill slots in via the sidebar editor, or
// apply the GEAR_PRESETS starter kit below (which also seeds matching stat totals).
// Note: with an empty weapon/armor slot the solver has no acquire move to offer for
// that slot (base swaps exist only for accessories/specials, SPEC §6). Those slots
// stay quiet until a base is set.
const EMPTY_SLOT = Object.freeze({ prefix: null, suffix: null, base: null });

export const LOADOUT = Object.freeze({
  weapon:   { ...EMPTY_SLOT },
  helm:     { ...EMPTY_SLOT },
  chest:    { ...EMPTY_SLOT },
  pant:     { ...EMPTY_SLOT },
  hand:     { ...EMPTY_SLOT },
  feet:     { ...EMPTY_SLOT },
  totem:    { ...EMPTY_SLOT },
  earrings: { ...EMPTY_SLOT },
  necklace: { ...EMPTY_SLOT },
  belt:     { ...EMPTY_SLOT },
  brooch:   { ...EMPTY_SLOT },
  ring1:    { ...EMPTY_SLOT },
  ring2:    { ...EMPTY_SLOT },
  artifact: { ...EMPTY_SLOT },
  rhod:     { ...EMPTY_SLOT },
});

// localStorage key for the user's edited loadout (per-slot override of LOADOUT).
// Versioned so a future shape change can be migrated/ignored cleanly.
export const LOADOUT_STORAGE_KEY = "vgu.loadout.v1";

// Persisted override for the live stat totals (sidebar-editable; also auto-adjusted
// by gear-slot edits). Stored as a partial { stat: value } map merged over CURRENT_STATS.
export const CURRENT_STATS_STORAGE_KEY = "vgu.stats.v1";

// Owned-items inventory (SPEC §5.2)
// The game hands out untradeable crafting/upgrade materials (shards, essences, crystals,
// runes). The player declares how many of each priced item they HOLD; upgrade costs net
// that stock out of every BOM (cheaper when part of a craft is already owned). Stored as a
// { itemName: count } map, item names canonical to the price/recipe namespace; count 0 (or
// absent) = none. This is the THIRD allowed localStorage key (alongside the loadout + stat
// totals). Inventory is durable player state the app can't derive. Netting is naive
// per-move (a move may credit the full stock; nothing is globally allocated, SPEC §7.1).
// This working map now also RIDES the character profile (snapshot `inventory` field,
// SPEC §17.5). Legacy profiles lacking it keep the working stock on switch (never wiped).
export const INVENTORY_STORAGE_KEY = "vgu.inventory.v1";

// Vetoed upgrades (SPEC §7.4)
// Moves the player never wants suggested (a tier they won't chase, a scroll they
// dislike, a whole slot's enchants). Stored as a list of veto RULES (see
// `moveVetoed` in utils.js for the rule shapes), each carrying a display `label` for
// the manage list. This is the FOURTH allowed localStorage key, vetoes are durable
// player intent the app can't derive. An empty list is the no-op default.
export const VETO_STORAGE_KEY = "vgu.vetoes.v1";

// Scanner name aliases (SPEC §16.5)
// User-confirmed corrections for OCR misreads the canonicalizer can't snap on its own
// (a garbled name → the real item the user picked in the Scanner review UI). Stored as a
// { readNameLower: canonicalName } exact-match map and applied in the Scanner's canonicalize
// path, replacing the old hardcoded `SCAN_OVERRIDES` list with a per-user, persisted table.
// This is the FIFTH allowed localStorage key; an empty map is the no-op default.
export const SCAN_ALIASES_STORAGE_KEY = "vgu.scanaliases.v1";

// Character name (SPEC §16.8. Scanner raid-drop tracker)
// The raid-drop tracker OCRs the SYSTEM chat log; every line is prefixed by the
// actor's character name, and only the player's OWN lines are counted (party
// members' drops share the same log). The player declares their character name so
// those lines can be matched (fuzzily, to absorb OCR variance). This is the SIXTH
// allowed localStorage key, durable player state the app can't derive. Empty seed;
// the tracker is inert until a name is set.
export const CHARACTER_NAME = "";
export const CHARACTER_NAME_STORAGE_KEY = "vgu.charname.v1";

// Saved raid runs (SPEC §16.8, run history & profit tracking)
// A completed raid run, saved from the drop tracker: its named drop tally (snapshot
// value frozen at save time), gold, the character who ran it, the raid, a timer
// duration, and a timestamp. Stored as an array of run records (see `makeRunRecord`
// in scanner.js). This is the SEVENTH allowed localStorage key, durable run log the
// app can't derive; exported to TSV for long-term storage in a Sheet. Empty default.
export const RUNS = [];
export const RUNS_STORAGE_KEY = "vgu.runs.v1";

// Scanner junk-drop filter (SPEC §16.8)
// User-curated list of drop-name substrings to treat as JUNK in the raid-drop
// tracker, untradeable buff drops (Waking Stones), event currency (Seals), etc.
// A drop whose name contains any of these (case-insensitive) is filtered out of
// the tally + run value (hidden, but restorable). Also stops a garbled junk name
// from spuriously fuzzy-matching a priced item. Stored as an array of lowercased
// substrings. This is the EIGHTH allowed localStorage key; empty default (the
// player decides what's junk via the drops-subtab per-row hide button).
export const SCAN_JUNK = [];
export const SCAN_JUNK_STORAGE_KEY = "vgu.scanjunk.v1";

// Loot-box opening log (SPEC §16.12)
// The Tracker's Boxes subtab: every scanned box opening ("You used [Box] → You
// obtained [Item] ×N"), stored as an array of { id, at, box, items:[{name,qty}] }
// records. GLOBAL (account-wide, like the weekly-box state, not per-character).
// Durable data the app can't derive; feeds the per-box drop-rate/value aggregates.
export const BOX_LOG_STORAGE_KEY = "vgu.boxlog.v1";

// Party drop tracking (SPEC §16.11): when on, the drops scanner keeps OTHER party members' item
// lines too (grouped per player) so one run samples the raid's drop table partySize× faster.
// A global UI preference ("1"/"0"), like the planner consume toggle, not per-character.
export const PARTY_TRACK_KEY = "vgu.partytrack.v1";

// Sticky Drops-subtab run options (SPEC §16.8): { raid, mode, coreBoost, buffOpen }, the picked
// raid, Normal/Hero mode, the manual core-boost checkbox, and the Drop Data "Core buffs" panel's
// open state. Persisted so the setup you used yesterday is still selected today (options no
// longer reset after each saved run). A global UI preference, like the party-track toggle.
export const RUN_PREFS_KEY = "vgu.runprefs.v1";

// Per-character max-level flag: which characters are at the level cap and so earn the +20%
// LEVEL_CAP_GOLD_BONUS on raid gold. A character-level setting (NOT per-run/per-raid), stored as
// { charNameLower: true }. The TENTH allowed localStorage key. Toggling the drops-subtab "Max level"
// checkbox writes it; each saved run freezes the character's flag as `maxLevel` for a stable value.
export const MAXLEVEL_STORAGE_KEY = "vgu.maxlevel.v1";

// Core-source tracking (SPEC §16.9)
// Per-character Luck stat: { charNameLower: number }. Sticky (edited only when the player's
// luck changes, blessing stones, Cadet Badge, luck gear); each saved run freezes the value as
// `luck` so luck-core yield can be tallied per luck level. The ELEVENTH allowed localStorage key.
export const LUCK_STORAGE_KEY = "vgu.luck.v1";

// Buff costs for the core-source verdicts. Campfire is a fixed per-battle gold sink. VVIP and
// Cadet Badge are 30-day purchases whose gold price drifts, a PriceInfo row whose name contains
// the *_PRICE_MATCH substring (case-insensitive) overrides the fallback when present. Core Boost
// Plus is real money (USD), reported as gold-per-dollar, never converted.
export const CAMPFIRE_CORE_COST = 65_000;
export const VVIP_COST_30D = 19_000_000;        // fallback when no tracker row matches
export const VVIP_PRICE_MATCH = "vvip";
export const CADET_COST_30D = 11_000_000;       // fallback when no tracker row matches
export const CADET_PRICE_MATCH = "cadet badge";
export const CORE_BOOST_PLUS_USD = 19;

// Character save slots + gear presets (SPEC §9.1)
// The player runs many characters with different gear. A profile is a named snapshot
// of the SWAP UNIT, the working loadout (all slots) + the hand-entered stat totals, 
// so switching characters is one click, not a full re-edit. Stored as
// { active: <id|null>, list: [ { id, name, loadout, stats, savedAt } ] } (see
// js/profiles.js for the record shape). The snapshot ALSO carries the owned-items
// inventory, the manual gold total, and the planner path (SPEC §17.5), so those swap
// per character too; only vetoes stay global. This is the NINTH allowed localStorage
// key; the working loadout/stats keys remain the live state the rest of the app reads.
export const PROFILES_STORAGE_KEY = "vgu.profiles.v1";

// Prep checklist manual goals (SPEC §14)
// The Checklist tab's non-infusion sections (Redeemers, Ein Lacher, Balance Outfit,
// Buffs) are one-time account/character progression goals with fixed stat rewards:
// nothing the app can derive from gear, just done/not-done toggles. Stored as an array
// of the checked goal ids (see PREP_GOALS for the item ids). This is the TWELFTH allowed
// localStorage key; an empty list is the no-op default. The goal DEFINITIONS are static
// game data (PREP_GOALS below); only the checked set persists.
export const CHECKLIST_STORAGE_KEY = "vgu.checklist.v1";

// Gold on hand (SPEC §17.5. Planner affordability)
// A manual per-character gold total the player maintains (sidebar numField row); feeds the
// Planner's affordability projection. Like the stat totals, it's a working number persisted
// under its own key AND snapshotted into the character profile (`gold` field) so it swaps per
// character. This is the THIRTEENTH allowed localStorage key; 0 is the default.
export const GOLD_STORAGE_KEY = "vgu.gold.v1";

// Working planner path (SPEC §17)
// The user-built upgrade path, `{ v: 1, steps: [Step] }` (step schema in js/planner.js).
// Persisted like the loadout AND snapshotted into the character profile (`path` field) so each
// character carries its own guide. This is the FOURTEENTH allowed localStorage key; an empty
// { v: 1, steps: [] } is the default.
export const PLANNER_STORAGE_KEY = "vgu.planner.v1";

// Planner "Consume resources on complete" toggle (SPEC §17.5)
// When on, "Mark complete" also subtracts the step's expected materials from inventory and
// its gold from the tracker. A GLOBAL UI preference (not per-character, not exported with the
// path). This is the FIFTEENTH allowed localStorage key; off ("0") is the default.
export const PLANNER_CONSUME_KEY = "vgu.plannerconsume.v1";

// Planner "Next raid" card preferences (SPEC §17.13)
// `{ raid: string|null, aim: "qb"|"cap" }`, the card's manual raid override (null = auto:
// the easiest raid the plan's projected stats don't reach) and its QB-entry/Caps toggle.
// A GLOBAL UI preference like the consume toggle; auto + "qb" is the default.
export const PLANNER_RAID_KEY = "vgu.plannerraid.v1";

// Damage tab preferences (SPEC §19)
// `{ raid: string|null, custom: {def, balCap, critCap}, tweaks: {stat: delta} }`, the
// selected reference raid (null = custom boss), the custom/override boss numbers, and the
// what-if stat tweaks overlaid on currentStats (the real stats are never mutated). The
// selected boss also drives the Upgrades tab's DPS%/Gold-per-DPS% columns. A GLOBAL UI
// preference like the Planner raid card.
export const DAMAGE_STORAGE_KEY = "vgu.damage.v1";

// The manual checklist goals, grouped by section. Each item:
//   { id, label, reward, stats }
// `reward` is the display string of everything gained on completion. `stats` is the SCORED
// portion that folds into the player's stat totals when the goal is checked (keys must be
// scored-stat keys: att/def/crit/critRes/addDmg/defPen/bal/attSpd/destruction). HP is NOT a
// scored stat, so it appears in `reward` for reference but is omitted from `stats` (not folded).
export const PREP_GOALS = [
  { section: "Redeemers", items: [
    { id: "redeem-neamhain", label: "Neamhain", reward: "1000 Att, 5 Crit, 1000 HP, 300 Destruction", stats: { att: 1000, crit: 5, destruction: 300 } },
    { id: "redeem-balor",    label: "Balor",    reward: "1000 Att, 5 Crit, 1000 HP, 300 Destruction", stats: { att: 1000, crit: 5, destruction: 300 } },
    { id: "redeem-brigid",   label: "Brigid",   reward: "1000 Att, 5 Crit, 500 HP, 200 Destruction",  stats: { att: 1000, crit: 5, destruction: 200 } },
    { id: "redeem-laura",    label: "Laura",    reward: "1000 Att, 5 Crit, 500 HP, 100 Destruction",  stats: { att: 1000, crit: 5, destruction: 100 } },
  ] },
  { section: "Ein Lacher", items: [
    { id: "einlacher-bal",  label: "Ein Lacher: 5 Bal",  reward: "5 Bal",  stats: { bal: 5 } },
    { id: "einlacher-crit", label: "Ein Lacher: 3 Crit", reward: "3 Crit", stats: { crit: 3 } },
  ] },
  { section: "Balance Outfit", items: [
    { id: "balance-outfit-bal", label: "Balance Outfit: 2 Bal", reward: "2 Bal", stats: { bal: 2 } },
  ] },
  { section: "Buffs", items: [
    { id: "buff-crimson-epaulet", label: "7-day Crimson Blade Epaulet", reward: "500 Att, 500 Def", stats: { att: 500, def: 500 } },
  ] },
];

// Built-in "base gear given to a fresh character" templates. Applying one overwrites
// the working loadout/stats (deep-cloned); the player then Saves-as to make it a
// character. Pure data, append more presets here as the game adds starter kits.
//
// The base kit: +12 Orna weapon + armor with their default enchants, the starter
// accessories (belt/earrings/rings at +12) and totem, necklace, brooch, artifact and
// rhod are EMPTY slots (base:null). No tuning on anything. Stats seed to ZERO: the
// totals include things the data can't model (character base stats by level, set
// bonuses, infusions, buffs), so the kit ships no snapshot and the player enters their
// own totals in the sidebar after applying. (An empty base slot is `{ base:null,
// prefix:null, suffix:null }` so the slot still renders + stays editable.)
const BASE_GEAR_LOADOUT = Object.freeze({
  weapon:   { prefix: "Chaotic Enchant Scroll",     suffix: "Spirited Enchant Scroll",  base: "+12 Orna Weapon" },
  helm:     { prefix: "Heartless Enchant Scroll",   suffix: "Capture Enchant Scroll",   base: "+12 Orna Helm" },
  chest:    { prefix: "Infinite Enchant Scroll",    suffix: "Barrier Enchant Scroll",   base: "+12 Orna Mail" },
  pant:     { prefix: "Heartless Enchant Scroll",   suffix: "Capture Enchant Scroll",   base: "+12 Orna Greaves" },
  hand:     { prefix: "Weeping Enchant Scroll",     suffix: "Soul Enchant Scroll",      base: "+12 Orna Gauntlets" },
  feet:     { prefix: "Weeping Enchant Scroll",     suffix: "Soul Enchant Scroll",      base: "+12 Orna Boots" },
  totem:    { prefix: null,                         suffix: null,                       base: "The Book of Legacy" },
  earrings: { prefix: "Significant Enchant Scroll", suffix: "Passion Enchant Scroll",   base: "Dimensional Earrings", enhance: { level: 12, bracket: 110 } },
  belt:     { prefix: "Petite Enchant Scroll",      suffix: "Passion Enchant Scroll",   base: "Dark Belt",            enhance: { level: 12, bracket: 110 } },
  ring1:    { prefix: "Sparkling Enchant Scroll",   suffix: "Berserker Enchant Scroll", base: "Rage of the Rift",     enhance: { level: 12, bracket: 110 } },
  ring2:    { prefix: "Sparkling Enchant Scroll",   suffix: "Passion Enchant Scroll",   base: "Fear of the Divide",   enhance: { level: 12, bracket: 110 } },
  // Empty slots (no gear equipped on a fresh character).
  necklace: { prefix: null, suffix: null, base: null },
  brooch:   { prefix: null, suffix: null, base: null },
  artifact: { prefix: null, suffix: null, base: null },
  rhod:     { prefix: null, suffix: null, base: null },
});

// `blurb` (optional) drives the post-apply explainer modal (same chrome as the
// changelog popup): `goal` = what this template is for, `steps` = what to do next.
// Plain strings, rendered escaped, no markup.
export const GEAR_PRESETS = Object.freeze([
  { name: "New character, base +12 Orna", loadout: BASE_GEAR_LOADOUT, stats: {
    att: 0, def: 0, crit: 0, critRes: 0, addDmg: 0,
    defPen: 0, bal: 0, attSpd: 0, destruction: 0,
  }, blurb: {
    goal: "This preset applies a full new character setup after finishing leveling. "
      + "It has a full +12 Orna, and the permanent accessories that come from the Lvl 115 box.",
    steps: [
      "The temporary accessories are excluded and have to be added manually.",
      "Stats will also have to be added manually.",
      "Visit the Checklist tab to tick off the one-time progression goals you've already completed.",
    ],
  } },
]);

// Sheet slot labels → SPEC §3 slot ids. The secondary slot is intentionally
// absent: it takes no enchants and has no meaningful stats to track.
export const SLOT_NAME_TO_ID = Object.freeze({
  Head: "helm", Chest: "chest", Legs: "pant", Hands: "hand", Feet: "feet",
  Weapon: "weapon",
  Belt: "belt", "Ring 1": "ring1", "Ring 2": "ring2", Brooch: "brooch",
  Earrings: "earrings", Necklace: "necklace", Totem: "totem",
  Artifact: "artifact", Rhod: "rhod",
});
