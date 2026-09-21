#!/usr/bin/env node
// Dev-only. Pulls real ANU Acton building footprints from OpenStreetMap and
// bakes them into src/data/campus.ts, which is COMMITTED — the app and CI
// never touch the network, so builds are deterministic and work offline.
//
//   node scripts/fetch-campus.ts
//
// OSM data is ODbL: "© OpenStreetMap contributors" is credited in the map
// footer and README.md. Re-run this only when you want fresher geometry;
// the committed output is the source of truth for everything downstream.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// overpass-api.de 406s on this client; the kumi mirror serves the same data.
const ENDPOINT = "https://overpass.kumi.systems/api/interpreter";
const BBOX = "-35.2830,149.1150,-35.2700,149.1250";

// The Acton campus core, used as the projection origin so coordinates come
// out as small metre offsets rather than unwieldy degrees.
const ORIGIN = { lat: -35.2775, lon: 149.1195 };

/** The bookable buildings, curated. Each maps one or more OSM `name` values
 *  onto the code a room number would actually carry. Everything else on
 *  campus still gets drawn, just dimmed and non-interactive. */
const BOOKABLE: Array<{
  code: string;
  name: string;
  slug: string;
  osm: string[];
  levels?: number;
}> = [
  {
    code: "MRTC",
    name: "Marie Reay Teaching Centre",
    slug: "marie-reay",
    osm: ["Marie Reay Teaching Centre"],
  },
  {
    code: "HN",
    name: "Hanna Neumann Building",
    slug: "hanna-neumann",
    osm: ["Hanna Neumann Building - 145"],
  },
  {
    code: "CHI",
    name: "JB Chifley Building",
    slug: "chifley",
    osm: ["JB Chifley Building"],
  },
  {
    code: "HAN",
    name: "Hancock Library",
    slug: "hancock",
    osm: ["Hancock Library West Wing", "Hancock Library East Wing"],
  },
  {
    code: "COP",
    name: "Copland Building",
    slug: "copland",
    osm: ["Copland Building"],
  },
  {
    code: "MEN",
    name: "RG Menzies Library",
    slug: "menzies",
    osm: ["R.G. Menzies Library"],
  },
  {
    code: "HA",
    name: "Haydon-Allen Building",
    slug: "haydon-allen",
    osm: ["Haydon-Allen Building"],
  },
  {
    code: "BIR",
    name: "Birch Building",
    slug: "birch",
    osm: ["Birch Building - 35"],
  },
  {
    code: "PK",
    name: "Peter Karmel Building",
    slug: "peter-karmel",
    osm: ["Peter Karmel Building"],
  },
  {
    code: "ENG",
    name: "Engineering Building",
    slug: "engineering",
    osm: ["Engineering Building - 32"],
  },
];

type LatLon = { lat: number; lon: number };
type Element = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: Array<{ role: string; geometry?: LatLon[] }>;
};

// Overpass is a shared free service and rate-limits hard. Responses are
// cached under .cache/ (untracked) so re-running to tweak the projection or
// the allowlist costs nothing and doesn't hammer someone else's server.
async function overpass(name: string, query: string): Promise<Element[]> {
  const cached = join(".cache", `overpass-${name}.json`);
  if (existsSync(cached)) {
    console.log(`  ${name}: from ${cached}`);
    return (JSON.parse(readFileSync(cached, "utf8")) as { elements: Element[] }).elements;
  }

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, { method: "POST", body: query });
    if (res.ok) {
      const text = await res.text();
      mkdirSync(".cache", { recursive: true });
      writeFileSync(cached, text);
      return (JSON.parse(text) as { elements: Element[] }).elements;
    }
    // 429 (rate limited) and 504 (query slot busy) are both worth waiting out
    if ((res.status !== 429 && res.status !== 504) || attempt >= 5) {
      throw new Error(`overpass ${res.status} ${res.statusText}`);
    }
    const wait = 15 * attempt;
    console.log(`  ${name}: ${res.status}, retrying in ${wait}s (attempt ${attempt}/5)`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

// Equirectangular projection onto a local metre grid: x east, z south, so
// three.js's XZ ground plane has north pointing at -z.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

function project(p: LatLon): [number, number] {
  return [
    round((p.lon - ORIGIN.lon) * M_PER_DEG_LON),
    round(-(p.lat - ORIGIN.lat) * M_PER_DEG_LAT),
  ];
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Douglas–Peucker. Footprints arrive with far more detail than a 3D campus
 *  needs; ~1 m of tolerance halves the payload without a visible change. */
function simplify(points: Array<[number, number]>, tolerance = 1): Array<[number, number]> {
  if (points.length < 3) return points;
  const [first] = points;
  const last = points[points.length - 1];

  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicular(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= tolerance) return [first, last];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

function perpendicular(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Shoelace area, in m². Used to rank a building's rings (the biggest is the
 *  one floorplans get laid out in) and to drop sheds from the context layer. */
function area(ring: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** An element's outer ring, projected and simplified. Multipolygon relations
 *  carry their outline across member ways; we take the longest outer member,
 *  which for these buildings is the outline rather than a courtyard. */
function ringOf(el: Element): Array<[number, number]> | undefined {
  let geometry = el.geometry;
  if (!geometry && el.members) {
    geometry = el.members
      .filter((m) => m.role === "outer" && m.geometry)
      .sort((a, b) => (b.geometry?.length ?? 0) - (a.geometry?.length ?? 0))[0]?.geometry;
  }
  if (!geometry || geometry.length < 4) return undefined;
  const ring = simplify(geometry.map(project));
  // close the ring exactly once
  const [head] = ring;
  const tail = ring[ring.length - 1];
  if (head[0] === tail[0] && head[1] === tail[1]) ring.pop();
  return ring.length >= 3 ? ring : undefined;
}

function bounds(rings: Array<Array<[number, number]>>) {
  const xs = rings.flat().map((p) => p[0]);
  const zs = rings.flat().map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

async function main(): Promise<void> {
  console.log(`fetching ANU Acton geometry from ${new URL(ENDPOINT).host}…`);

  const buildings = await overpass("buildings", `[out:json][timeout:90];
    ( way["building"](${BBOX}); relation["building"](${BBOX}); );
    out geom;`);
  console.log(`  ${buildings.length} building elements`);

  const context = await overpass("context", `[out:json][timeout:90];
    (
      way["waterway"="stream"](${BBOX});
      way["highway"~"^(primary|secondary|tertiary|residential)$"](${BBOX});
    );
    out geom;`);
  console.log(`  ${context.length} context ways`);

  const byName = new Map<string, Element[]>();
  for (const el of buildings) {
    const name = el.tags?.name;
    if (name) byName.set(name, [...(byName.get(name) ?? []), el]);
  }

  const claimed = new Set<number>();
  const bookable = BOOKABLE.map((entry) => {
    const elements = entry.osm.flatMap((name) => {
      const found = byName.get(name);
      if (!found) throw new Error(`no OSM building named "${name}" in the bbox`);
      return found;
    });
    for (const el of elements) claimed.add(el.id);

    const rings = elements
      .map(ringOf)
      .filter((r): r is Array<[number, number]> => r !== undefined)
      .sort((a, b) => area(b) - area(a));
    if (rings.length === 0) throw new Error(`no usable ring for ${entry.code}`);

    const levels =
      entry.levels ??
      Math.max(
        ...elements.map((el) => Number.parseInt(el.tags?.["building:levels"] ?? "0", 10) || 0),
        2,
      );

    const b = bounds(rings);
    return {
      code: entry.code,
      name: entry.name,
      slug: entry.slug,
      levels,
      rings,
      // the largest ring is the one floorplans are laid out inside
      plan: rings[0],
      centre: [round((b.minX + b.maxX) / 2), round((b.minZ + b.maxZ) / 2)] as [number, number],
      radius: round(Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2),
    };
  });

  // Everything else on campus, drawn dim so the map reads as ANU rather than
  // ten buildings floating in the dark. Sheds and bike racks add noise, not
  // recognition, so anything under 120 m² is dropped.
  const scenery = buildings
    .filter((el) => !claimed.has(el.id))
    .map((el) => ({
      ring: ringOf(el),
      levels: Number.parseInt(el.tags?.["building:levels"] ?? "0", 10) || 1,
    }))
    .filter((b): b is { ring: Array<[number, number]>; levels: number } => b.ring !== undefined)
    .filter((b) => area(b.ring) >= 120)
    .map((b) => ({ ring: b.ring, levels: Math.min(b.levels, 8) }));

  const lines = (predicate: (el: Element) => boolean) =>
    context
      .filter(predicate)
      .map((el) => (el.geometry ? simplify(el.geometry.map(project), 2) : []))
      .filter((l) => l.length >= 2);

  const water = lines((el) => el.tags?.waterway === "stream");
  const roads = lines((el) => Boolean(el.tags?.highway));

  const out = `// GENERATED by scripts/fetch-campus.ts — do not edit by hand.
//
// Real ANU Acton building footprints from OpenStreetMap, © OpenStreetMap
// contributors, licensed ODbL (https://www.openstreetmap.org/copyright).
// Projected to a local metre grid: +x east, +z south, origin near the campus
// core, so three.js's XZ ground plane has north at -z.
//
// Footprints and storey counts are real. Floor layouts and room numbers are
// invented — see src/lib/floorplan.ts and README.md.

export type Ring = Array<[number, number]>;

export type CampusBuilding = {
  code: string;
  name: string;
  slug: string;
  levels: number;
  /** every footprint this building is drawn from */
  rings: Ring[];
  /** the largest ring — the one floorplans are laid out inside */
  plan: Ring;
  centre: [number, number];
  radius: number;
};

/** The bookable buildings, in map order. */
export const BUILDINGS: CampusBuilding[] = ${JSON.stringify(bookable, null, 2)};

/** Every other campus building, drawn dim and non-interactive for context. */
export const SCENERY: Array<{ ring: Ring; levels: number }> = ${JSON.stringify(scenery)};

/** Sullivans Creek. */
export const WATER: Ring[] = ${JSON.stringify(water)};

/** Surrounding roads. */
export const ROADS: Ring[] = ${JSON.stringify(roads)};

export const ATTRIBUTION = "© OpenStreetMap contributors";
`;

  writeFileSync("src/data/campus.ts", out);
  const kb = (out.length / 1024).toFixed(0);
  console.log(
    `wrote src/data/campus.ts — ${bookable.length} bookable, ${scenery.length} scenery, ` +
      `${water.length} water, ${roads.length} roads (${kb} kB)`,
  );
}

await main();
