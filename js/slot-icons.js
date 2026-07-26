// Equipment-slot icons (SPEC §22)
//
// One glyph per slot, hand-drawn on a 24x24 grid. Everything here is markup only: no
// colours are baked in. Inside a glyph,
//   .g  = the body, filled with `currentColor`
//   .gs = an open wire shape, stroked with `currentColor`
//   .d  = a cut-in detail, filled with whatever sits BEHIND the icon (page or tile)
// so a caller sets the tone by setting `color` on any ancestor, and the two tones
// (gold var(--gold), muted var(--head)) cost nothing extra. The `.d` fill is the one
// thing that depends on the backdrop, so it is set per style in the page's CSS.
//
// Ring-shaped glyphs (ring band, brooch rim, compass rim) use `fill-rule="evenodd"`
// rather than a `.d` disc, so their holes show the real backdrop and survive being put
// on a tile, a card, or the page.
//
// Two styles ship: "solid" (bare silhouette, used by the Upgrades rows) and "tile"
// (the same glyph inset on a soft gradient tile). Standalone .svg copies of every
// style/tone combination are generated into assets/icons/ by scripts/build-slot-icons.mjs.

// A single fish-hook earring, top to bottom: the hook wire (a STROKED open path, so it
// can round over the top and flare outward at the tail the way real ear wire does; a
// filled band cannot hold an even width through that), a bead, a wire wrap, and a pear
// stone. Each piece overlaps the next so the whole reads as one connected shape.
const EARRING = `<g transform="translate(0 -.6)">
  <path class="gs" fill="none" stroke-width=".95" stroke-linecap="round"
    d="M6.4 8.9V6a2 2 0 0 1 4 0v2.3c0 1 .2 1.5.8 2"/>
  <circle class="g" cx="6.4" cy="9.4" r="1.05"/>
  <rect class="g" x="5.2" y="10.2" width="2.4" height="1" rx=".45"/>
  <path class="g" d="M6.4 11c1.65 1.9 2.5 3.45 2.5 4.9a2.5 2.5 0 0 1-5 0c0-1.45.85-3 2.5-4.9z"/></g>`;

// Per-ITEM artifact glyphs, one per family that has a real upgrade chain in the Gear
// sheet (six tier variants each). Drawn and exported, but nothing selects between them
// yet: SLOT_GLYPHS.artifact points at `goddess` for every artifact. Wiring them up means
// matching the equipped item's NAME to a family, the first icon that would depend on the
// item rather than the slot. The four one-off artifacts (Bronze Lion Statue, Phoenix
// Feather Bundle, Kobold's Clockwork Doll, Fire Wisp Crystal) have no glyph of their own.
// Declared ahead of SLOT_GLYPHS because that object references `goddess`.
export const ARTIFACT_GLYPHS = Object.freeze({
  // Succubus Fang: hung from a ring with cord windings at the root, so it reads as a
  // taken trophy rather than as a loose tooth.
  fang: `<path class="g" fill-rule="evenodd" d="M12 1.2a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8zm0 1.1a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z"/>
    <path class="g" d="M8.2 4.6h7.6c.7 0 1.2.6 1.1 1.3l-1.5 8.4c-.7 4.1-1.7 6.6-3.4 8.1-1.7-1.5-2.7-4-3.4-8.1L7.1 5.9c-.1-.7.4-1.3 1.1-1.3z"/>
    <path class="d" d="M7.6 7.4h8.8l-.25 1.4H7.85zM8.05 10.2h7.9l-.25 1.4H8.3z"/>`,
  // Werewolf Paw: pad and four toe beans with a claw over each, so it reads as a beast
  // rather than a housecat next to the cat-statue glyph.
  paw: `<path class="g" d="M12 21.6c-3.7 0-6.4-2.1-6.4-4.8 0-2.5 2.7-4.6 6.4-4.6s6.4 2.1 6.4 4.6c0 2.7-2.7 4.8-6.4 4.8z"/>
    <ellipse class="g" cx="6.5" cy="11" rx="1.9" ry="2.4" transform="rotate(-22 6.5 11)"/>
    <ellipse class="g" cx="9.9" cy="7.9" rx="2" ry="2.5"/>
    <ellipse class="g" cx="14.1" cy="7.9" rx="2" ry="2.5"/>
    <ellipse class="g" cx="17.5" cy="11" rx="1.9" ry="2.4" transform="rotate(22 17.5 11)"/>
    <path class="g" d="M9.9 2.6 11.1 5.2H8.7zM14.1 2.6 15.3 5.2h-2.4zM5.1 5.4 7 7.4 4.9 8.4zM18.9 5.4 17 7.4l2.1 1z"/>`,
  // Mysterious Cat Statue: seated figure with the tail curling round the base.
  cat: `<path class="g" d="M9.1 2.6 11.8 5.6 8.9 7.1zM14.9 2.6 12.2 5.6l2.9 1.5z"/>
    <circle class="g" cx="12" cy="7.1" r="3.4"/>
    <path class="g" d="M12 8.8c2.9 0 4.8 3.3 5.2 10.6H6.8C7.2 12.1 9.1 8.8 12 8.8z"/>
    <path class="g" d="M17 19.2c1.8 0 3-1 3-2.4s-.9-2.3-2.1-2.3v1.5c.4 0 .7.3.7.8 0 .6-.6.9-1.6.9z"/>
    <rect class="g" x="5.6" y="19.2" width="12.8" height="2.2" rx=".7"/>
    <circle class="d" cx="10.6" cy="6.8" r=".85"/><circle class="d" cx="13.4" cy="6.8" r=".85"/>`,
  // War Goddess Statue: wings swept out from a small figure on a stepped plinth. The
  // widest silhouette of the set, which is what makes it work as the catch-all.
  goddess: `<path class="g" d="M11 8.4 3.4 5.2c-.7-.3-1.3.5-.9 1.1l3.6 5.8 4.9 1.1zM13 8.4l7.6-3.2c.7-.3 1.3.5.9 1.1l-3.6 5.8-4.9 1.1z"/>
    <circle class="g" cx="12" cy="4.8" r="2.3"/>
    <path class="g" d="M12 6.8c1.8 0 3.1 2.6 3.4 12H8.6c.3-9.4 1.6-12 3.4-12z"/>
    <rect class="g" x="6.6" y="18.6" width="10.8" height="1.6" rx=".5"/>
    <rect class="g" x="4.8" y="20.4" width="14.4" height="2.2" rx=".7"/>`,
});

export const SLOT_GLYPHS = Object.freeze({
  // long blade (14 units) over a compact hilt
  weapon: `<g class="g">
    <path d="M12 1.4 13.7 4.6V15.4H10.3V4.6Z"/>
    <rect x="6.6" y="15.4" width="10.8" height="2" rx=".9"/>
    <rect x="11" y="17.4" width="2" height="3.4"/>
    <circle cx="12" cy="21.6" r="1.5"/></g>
    <path class="d" d="M11.6 3.8h.8v11.2h-.8z"/>`,
  helm: `<path class="g" d="M5.2 20.4V9.6a6.8 6.8 0 0 1 13.6 0v10.8h-4.4v-4.6a2.4 2.4 0 0 0-4.8 0v4.6z"/>
    <rect class="d" x="7.3" y="9.1" width="3.7" height="2" rx="1"/>
    <rect class="d" x="13" y="9.1" width="3.7" height="2" rx="1"/>`,
  // cuirass: wide pauldrons, trapezoid neck cut, flat hem, banded abdomen
  chest: `<path class="g" d="M9 3.4 4.6 5.6 3.2 9.2v2.2l3.4 1 .8 8h9.2l.8-8 3.4-1V9.2L19.4 5.6 15 3.4l-1.4 2.2h-3.2z"/>
    <path class="d" d="M6.4 8.9h3.4v1.1H6.4zM14.2 8.9h3.4v1.1h-3.4z"/>
    <path class="d" d="M8.5 14.2h7v1.1h-7zM8.7 16.9h6.6V18H8.7z"/>`,
  pant: `<g class="g"><rect x="5.4" y="3" width="13.2" height="3.4" rx="1.2"/>
    <path d="M5.8 7.2h5.4L10.6 21H7Z"/><path d="M12.8 7.2h5.4L17 21h-3.6z"/></g>
    <path class="d" d="M6.5 13h4.3v1.3H6.5zM13.3 13h4.3v1.3h-4.3z"/>`,
  // 13.5 wide. The thumb extends UP from a pivot INSIDE the palm, so it points up-and-out
  // and stays fused to it; it is shorter and thicker than the fingers, reaching only
  // partway up the index, the way a real hand does.
  hand: `<g class="g">
    <rect x="7.6" y="3.2" width="2.1" height="8.2" rx="1.05"/>
    <rect x="10.1" y="2" width="2.1" height="9.4" rx="1.05"/>
    <rect x="12.6" y="2.8" width="2.1" height="8.6" rx="1.05"/>
    <rect x="15.1" y="4.4" width="2" height="7" rx="1"/>
    <rect x="6.3" y="8.4" width="2.8" height="4.8" rx="1.4" transform="rotate(-28 7.7 12.4)"/>
    <rect x="7.4" y="9.8" width="9.8" height="6.2" rx="1.6"/>
    <path d="M7.4 16h9.8l1 4.1c.15.6-.3 1.2-.9 1.2H7.3c-.6 0-1.05-.6-.9-1.2z"/></g>
    <path class="d" d="M7.9 11.3h8.8v1H7.9z"/>
    <rect class="d" x="6.8" y="17.6" width="10.8" height="1.1"/>`,
  // 6-wide ankle shaft over a 14.4-unit foot run. One ankle strap, plus an angled plate
  // joint across the instep so it reads as a sabaton rather than a leather boot; the
  // joint sits clear of both the foot's top edge and the sole band.
  feet: `<path class="g" d="M5.4 2.6h6v9.8l6.2 2.9c1.4.7 2.2 2.1 2.2 3.7v1.6H5.4z"/>
    <rect class="d" x="5.4" y="10.8" width="6" height="1.4"/>
    <path class="d" d="M12.2 15.2 16.6 17.2v1.3l-4.4-2z"/>
    <path class="d" d="M5.4 19h14.4v1.3H5.4z"/>`,

  // not a true oval: the chain is widest up near the shoulders, draws back in through a
  // waist at mid height, then rounds out again to the pendant. Tilted 8 degrees.
  necklace: `<g transform="rotate(8 12 11)">
    <path class="g" fill-rule="evenodd" d="M12 1.7c3.6 0 6.8 2.6 6.8 5.9 0 1.8-1.4 2.8-1.4 4.6 0 3.2-2.4 5.7-5.4 5.7s-5.4-2.5-5.4-5.7c0-1.8-1.4-2.8-1.4-4.6 0-3.3 3.2-5.9 6.8-5.9zm0 1.8C9.2 3.5 7 5.4 7 7.6c0 1.4 1.4 2.6 1.4 4.6 0 2.2 1.6 3.9 3.6 3.9s3.6-1.7 3.6-3.9c0-2 1.4-3.2 1.4-4.6 0-2.2-2.2-4.1-5-4.1z"/>
    <path class="g" d="M12 16.4 15 19.5 12 22.6 9 19.5z"/></g>`,
  // ONE earring, not a pair: a pair halves every feature and the wire stops reading at 24px
  earrings: `<g transform="translate(12 12) scale(1.45) translate(-7.79 -10.36)">${EARRING}</g>`,
  // strap + buckle, punch holes on the tail
  belt: `<rect class="g" x="2.4" y="9" width="19.2" height="6" rx="1.4"/>
    <rect class="g" x="8.6" y="6.8" width="6.8" height="10.4" rx="1.6"/>
    <rect class="d" x="10.4" y="8.6" width="3.2" height="6.8" rx=".9"/>
    <rect class="g" x="11.55" y="8.6" width="1" height="6.8"/>
    <circle class="d" cx="18.2" cy="12" r=".9"/><circle class="d" cx="20.4" cy="12" r=".9"/>`,
  // in-game brooches are round medallions: a thin rim (1.3) around a tilted feather
  brooch: `<path class="g" fill-rule="evenodd" d="M12 1.4a10.6 10.6 0 1 0 0 21.2 10.6 10.6 0 1 0 0-21.2zm0 1.3a9.3 9.3 0 1 1 0 18.6 9.3 9.3 0 0 1 0-18.6z"/>
    <g transform="rotate(22 12 12)">
      <path class="g" d="M12 4.6c1.9 1.7 2.8 3.9 2.8 6.4 0 2.2-.9 4.2-2.8 5.9-1.9-1.7-2.8-3.7-2.8-5.9 0-2.5.9-4.7 2.8-6.4z"/>
      <rect class="g" x="11.6" y="16.2" width=".8" height="3.4" rx=".4"/>
      <path class="d" d="M11.68 6.4h.64v12.9h-.64z"/>
    </g>`,
  // slim band (1.45 thick, was 2.4) with a narrower stone to match
  ring: `<path class="g" fill-rule="evenodd" d="M12 8a6.6 6.6 0 1 0 0 13.2A6.6 6.6 0 0 0 12 8zm0 1.45a5.15 5.15 0 1 1 0 10.3 5.15 5.15 0 0 1 0-10.3z"/>
    <path class="g" d="M12 3.2 14.5 6.7 12 10.2 9.5 6.7z"/>`,
  // totem items are books ("The Book of Legacy", "Eriu Book"), not carved poles:
  // rounded spine, a fore-edge page block on the right, spine groove, ribbon, title bars
  totem: `<path class="g" d="M6.6 1.8h12.2v20.4H6.6a2.8 2.8 0 0 1-2.8-2.8V4.6a2.8 2.8 0 0 1 2.8-2.8z"/>
    <rect class="g" x="18.8" y="3.4" width="1.6" height="17.2" rx=".5"/>
    <rect class="d" x="6.4" y="1.8" width="1.3" height="20.4"/>
    <path class="d" d="M14.6 1.8h2.6v6.6l-1.3-1.5-1.3 1.5z"/>
    <path class="d" d="M9.6 12.4h6.8v1.4H9.6zM9.6 15.4h4.6v1.4H9.6z"/>`,
  // The artifact slot uses the war-goddess glyph for EVERY artifact right now. Per-item
  // glyphs are drawn and exported (ARTIFACT_GLYPHS below) but not wired up yet.
  artifact: ARTIFACT_GLYPHS.goddess,
  // rhod = Rhod Compass: a compass rose, not a needle. Heavier rim than the brooch's
  // (2.2 vs 1.3) plus an 8-point star filling the dial, so the two never read alike at 24px.
  rhod: `<path class="g" fill-rule="evenodd" d="M12 1.4a10.6 10.6 0 1 0 0 21.2 10.6 10.6 0 1 0 0-21.2zm0 2.2a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z"/>
    <path class="g" transform="rotate(45 12 12)" d="M12 6.6 12.9 11.1 17.4 12 12.9 12.9 12 17.4 11.1 12.9 6.6 12 11.1 11.1z"/>
    <path class="g" d="M12 4 13.5 10.5 20 12 13.5 13.5 12 20 10.5 13.5 4 12 10.5 10.5z"/>
    <circle class="d" cx="12" cy="12" r="1.5"/>`,
});

// Slot ids used by the app (config.js LOADOUT) that do not name a glyph 1:1. Both ring
// slots share one glyph; everything else matches by name.
const SLOT_ALIAS = Object.freeze({ ring1: "ring", ring2: "ring" });

export const SLOT_ICON_STYLES = Object.freeze(["solid", "tile"]);

// The tile style's backdrop. Kept here (not in the page CSS) because it is part of the
// icon rather than part of the theme: the same gradient has to travel with the exported
// .svg files, which have no stylesheet to inherit from.
const TILE_GRADIENT = `<linearGradient id="slotTileBg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#232833"/><stop offset="1" stop-color="#14171d"/></linearGradient>`;

/** Glyph key for an app slot id, or null when the slot has no icon. */
export function slotGlyphKey(slotId) {
  if (!slotId) return null;
  const key = SLOT_ALIAS[slotId] || slotId;
  return key in SLOT_GLYPHS ? key : null;
}

/**
 * Wrap raw glyph markup in an `<svg>`. Colour comes from the CSS `color` of an ancestor,
 * see the header note. Exported so the asset exporter can render ARTIFACT_GLYPHS too.
 */
export function renderIcon(glyph, { style = "solid", size = null, label = "" } = {}) {
  const dims = size ? ` width="${size}" height="${size}"` : "";
  // role/aria-label rather than <title>: a <title> would raise a NATIVE tooltip on hover,
  // which fights the app's own instant [data-tip] tooltips.
  const a11y = ` role="img" aria-label="${label}"`;
  const body = style === "tile"
    ? `<defs>${TILE_GRADIENT}</defs><rect width="24" height="24" rx="6" fill="url(#slotTileBg)"/>` +
      `<g transform="translate(12 12) scale(.64) translate(-12 -12)">${glyph}</g>`
    : glyph;
  return `<svg class="slot-ico slot-ico-${style}" viewBox="0 0 24 24"${dims}${a11y}>${body}</svg>`;
}

/**
 * `<svg>` markup for a slot, or "" when the slot has no glyph (so an unknown slot
 * degrades to nothing rather than throwing or drawing a broken box).
 */
export function slotIcon(slotId, opts = {}) {
  const key = slotGlyphKey(slotId);
  if (!key) return "";
  return renderIcon(SLOT_GLYPHS[key], { label: slotId, ...opts });
}

/** `<svg>` markup for a named artifact family, or "" if the family is unknown. */
export function artifactIcon(family, opts = {}) {
  const glyph = ARTIFACT_GLYPHS[family];
  return glyph ? renderIcon(glyph, { label: family, ...opts }) : "";
}
