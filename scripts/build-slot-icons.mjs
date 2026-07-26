// Exports every slot glyph as a standalone .svg (SPEC §22).
//
// js/slot-icons.js is the source of truth and is colour-agnostic: it paints with
// `currentColor` and leaves cut-in details to the page's CSS. Standalone files have no
// stylesheet to inherit from, so this script resolves both of those into an inline
// <style> block and writes one file per style/tone/slot:
//
//   assets/icons/<style>-<tone>/<slot>.svg          2 x 2 x 14 slots
//   assets/icons/<style>-<tone>/artifact-<family>.svg   + the per-item artifact glyphs
//
// Run with `npm run build:icons`. Nothing builds at page load; the app imports the
// module directly and these files are for reuse elsewhere (docs, README, the Sheet).
import { writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SLOT_GLYPHS, ARTIFACT_GLYPHS, SLOT_ICON_STYLES, renderIcon } from "../js/slot-icons.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "icons");

// Theme tokens, mirrored from index.html :root. Kept as literals because a standalone
// .svg cannot read a CSS variable off the page it is dropped into.
const TONES = { gold: "#c9a84c", muted: "#8a9ab8" };
// What sits BEHIND the glyph, which is what a .d cut-in has to be painted with:
// the page background for a bare silhouette, the tile's mid-gradient for a tile.
const BACKDROP = { solid: "#111318", tile: "#1a1e26" };

const SIZE = 32; // the size the Upgrades rows use; the viewBox still scales freely

let written = 0;
for (const style of SLOT_ICON_STYLES) {
  for (const [tone, ink] of Object.entries(TONES)) {
    const dir = join(OUT, `${style}-${tone}`);
    // Rebuild the directory so a renamed or dropped glyph cannot leave a stale file behind.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // Slot glyphs, then the per-item artifact glyphs under an `artifact-` prefix. The
    // latter are not selected by anything yet, they are exported so they exist as assets.
    const all = [
      ...Object.entries(SLOT_GLYPHS).map(([k, g]) => [k, g]),
      ...Object.entries(ARTIFACT_GLYPHS).map(([k, g]) => [`artifact-${k}`, g]),
    ];
    for (const [name, glyph] of all) {
      const svg = renderIcon(glyph, { style, size: SIZE, label: name })
        .replace(/^<svg /, `<svg xmlns="http://www.w3.org/2000/svg" `)
        .replace(/>/, `><style>.g{fill:${ink}}.gs{stroke:${ink}}.d{fill:${BACKDROP[style]}}</style>`);
      writeFileSync(join(dir, `${name}.svg`), svg + "\n");
      written++;
    }
  }
}

const dirs = readdirSync(OUT).sort();
console.log(`wrote ${written} icons into assets/icons/ (${dirs.join(", ")})`);
