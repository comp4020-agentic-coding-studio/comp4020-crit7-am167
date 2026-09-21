import { BUILDINGS } from "../data/campus";

// One colour per building, and one place that decides it.
//
// The map is colourful because the CAMPUS is: hue means "which building",
// not "how busy". Marie Reay is red everywhere — on the map, on its card, down
// the side of its grid rows, on its floor plan — so you learn the campus by
// colour and can find it again without reading a label.
//
// Availability is carried by FILL instead: how much of a bar is painted, how
// vivid the building is against the paper. That split is what lets the page be
// loud without becoming unreadable, and it means nobody has to distinguish ten
// hues to answer "is there a room free" — that question is answered by a
// proportion and a number, both of which survive any kind of colour vision.

export type Swatch = {
  /** the building's colour at full strength */
  hex: string;
  /** a pale wash of it, for fills behind text */
  wash: string;
  /** ink that stays legible ON the full-strength colour */
  on: string;
};

/** Ten hues around the wheel, pitched to ANU's own palette rather than to a
 *  screen default: black ink and ANU gold are the anchors, so these are rich
 *  and earthy — crimson, burnt orange, olive, teal, indigo, plum — instead of
 *  the neon set that would fight the gold. Still far enough apart to tell
 *  from each other at the size of a grid row's edge.
 *
 *  `on` is picked per swatch rather than computed, because the label sitting
 *  on a building's colour is large bold text and needs 3:1 — gold and olive
 *  take black, the darker hues take white. */
const WHEEL: Swatch[] = [
  { hex: "#c8102e", wash: "#fbe1e5", on: "#ffffff" }, // crimson
  { hex: "#e4572e", wash: "#fce6de", on: "#1a1a1a" }, // burnt orange
  { hex: "#be830e", wash: "#f9edd2", on: "#1a1a1a" }, // ANU gold
  { hex: "#6e8b14", wash: "#eef3d8", on: "#1a1a1a" }, // olive
  { hex: "#0e8a5f", wash: "#d9f0e6", on: "#ffffff" }, // emerald
  { hex: "#00838f", wash: "#d5eef1", on: "#ffffff" }, // teal
  { hex: "#1268b3", wash: "#dde9f6", on: "#ffffff" }, // cerulean
  { hex: "#35408e", wash: "#e0e3f4", on: "#ffffff" }, // indigo
  { hex: "#6b3fa0", wash: "#e9e0f5", on: "#ffffff" }, // plum
  { hex: "#a62161", wash: "#f7deeb", on: "#ffffff" }, // mulberry
];

// Dealt by position in the sorted list of codes rather than by hashing the
// code: with ten buildings and ten hues, a hash collides and hands two
// buildings the same identity, which is the one thing this must not do.
// Sorting rather than using the campus file's own order means re-ordering
// that file can't reshuffle colours under someone who has learnt them.
const ORDER = [...BUILDINGS.map((building) => building.code)].sort();

export function swatchFor(code: string): Swatch {
  const at = ORDER.indexOf(code);
  return WHEEL[(at < 0 ? code.length : at) % WHEEL.length];
}

/** The identity colours, as CSS custom properties to hang on an element. */
export function swatchVars(code: string): string {
  const swatch = swatchFor(code);
  return `--hue:${swatch.hex};--hue-wash:${swatch.wash};--on-hue:${swatch.on}`;
}
