// User-facing changelog. Newest entry FIRST. `VERSION` is what the header badge shows —
// keep it equal to CHANGELOG[0].version. Pure data; rendered by the header's version link
// (index.html `renderChangelog`). Write entries in plain player language, not commit-speak.
export const CHANGELOG = [
  {
    version: "0.1",
    date: "2026-07-21",
    notes: "First public build.",
    changes: [
      "Upgrades: ranked cheapest-per-point action list, with damage % and gold per damage %.",
      "Target: solve for a stat threshold, a gold budget, or a raid's entry requirements.",
      "Planner: build your own upgrade path — materials list, projected stats, next-raid gap, weekly free boxes.",
      "Damage: per-stat damage marginals against a chosen raid boss, with what-if stat tweaks.",
      "Tracker: screenshot OCR for marketplace prices, raid drops / profit per run, and loot-box opening logs.",
      "Appraiser, Items catalog, Checklist, character save slots, owned-item inventory, and vetoes.",
    ],
  },
];

export const VERSION = CHANGELOG[0].version;
