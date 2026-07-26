// User-facing changelog. Newest entry FIRST. `VERSION` is what the header badge shows.
// Keep it equal to CHANGELOG[0].version. Pure data; rendered by the header's version link
// (index.html `renderChangelog`). Write entries in plain player language, not commit-speak.
export const CHANGELOG = [
  {
    version: "0.5",
    date: "2026-07-25",
    notes: "Added equipment icons; reworked the Upgrades table",
    changes: [
      "Added icons for every equipment type. They are not the specific icons from in game, just generic ones drawn as SVG.",
      "The Upgrades page changed a lot visually. The Slot and Type columns are gone, replaced by a slot icon on each row. You can still search by slot or type, but you can no longer sort by them.",
      "Added icons to the Equipped section, and widened it a bit to fit them in.",
    ],
  },
  {
    version: "0.4",
    date: "2026-07-25",
    notes: "Faster loading; filtered out legacy items; fixed Orna upgrade pricing",
    changes: [
      "The app loads in half a second instead of 8. Fix comes from using cached data, and loading snapshotted data from the pricing spreadsheet.",
      "Added a new legacy section in the Items tab. Tagged many items and scrolls legacy so they don't show up as upgrades or sidegrades. They are still price tracked.",
      "Orna upgrading now looks more like Uaithne and Eriu upgrading. The items chain from +12 to +15 like how Uaithne and Eriu chain from base to Legendary.",
      "Backend improvements to price logging from the in game marketplace",
    ],
  },
  {
    version: "0.3",
    date: "2026-07-24",
    notes: "Updated damage and appraiser tabs",
    changes: [
      "Updated damage and appraiser tabs",
      "Rewrote most hint/helper text",
    ],
  },
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
