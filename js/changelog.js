// User-facing changelog. Newest entry FIRST. `VERSION` is what the header badge shows.
// Keep it equal to CHANGELOG[0].version. Pure data; rendered by the header's version link
// (index.html `renderChangelog`). Write entries in plain player language, not commit-speak.
export const CHANGELOG = [
  {
    version: "0.2",
    date: "2026-07-23",
    notes: "Added Esras; Changed initial gear/stats",
    changes: [
      "Added a new raid, Esras, and all the related items, recipes, etc.",
      "First load now starts with empty equipment and stats.",
      "New Character preset dropped temporary items and now has 0 stats.",
      "Applying presets now opens a pop-up first to explain and verify.",
      "Item information now automatically refreshes from the live spreadsheet.",
      "Added this changelog: the version button in the header shows what's new.",
    ],
  },
  {
    version: "0.1",
    date: "2026-07-21",
    notes: "First public build.",
    changes: [
      "Upgrades: ranked cheapest-per-point action list, with damage % and gold per damage %.",
      "Target: solve for a stat threshold, a gold budget, or a raid's entry requirements.",
      "Planner: build your own upgrade path: materials list, projected stats, next-raid gap, weekly free boxes.",
      "Damage: per-stat damage marginals against a chosen raid boss, with what-if stat tweaks.",
      "Tracker: screenshot OCR for marketplace prices, raid drops / profit per run, and loot-box opening logs.",
      "Appraiser, Items catalog, Checklist, character save slots, owned-item inventory, and vetoes.",
    ],
  },
];

export const VERSION = CHANGELOG[0].version;
