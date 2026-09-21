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

// Overpass is a free shared service run by volunteers, and every mirror
// rate-limits. These all serve the whole planet, so a 429 from one is a
// reason to ask the next rather than to give up.
// Global instances only. Regional mirrors (overpass.osm.ch is
// Switzerland-only) answer 200 with an empty element set for an Australian
// bounding box, which looks exactly like "there are no footpaths here".
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
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

  let lastError = "no endpoint tried";
  for (let round = 1; round <= 3; round++) {
    for (const endpoint of ENDPOINTS) {
      const host = new URL(endpoint).host;
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            // overpass-api.de answers 406 without these two: it wants a
            // form body, an explicit Accept, and a named client.
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            "user-agent": "comp4020-crit7-campus-fetch/1.0 (ANU student project)",
          },
          body: new URLSearchParams({ data: query }),
        });
      } catch (error) {
        lastError = `${host}: ${String(error)}`;
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        // a rate-limited or timed-out mirror answers 200 with an HTML notice
        if (!text.trimStart().startsWith("{")) {
          lastError = `${host}: non-JSON response (rate limited or query timed out)`;
          continue;
        }
        const elements = (JSON.parse(text) as { elements: Element[] }).elements;
        // An empty answer from a mirror that holds a different part of the
        // world is indistinguishable from a real empty answer, and caching
        // it bakes the mistake in. Every query here expects data.
        if (elements.length === 0) {
          lastError = `${host}: returned no elements (wrong region, or an extract)`;
          console.log(`  ${name}: ${lastError}`);
          continue;
        }
        mkdirSync(".cache", { recursive: true });
        writeFileSync(cached, text);
        console.log(`  ${name}: ${elements.length} from ${host}`);
        return elements;
      }

      lastError = `${host}: ${res.status} ${res.statusText}`;
      console.log(`  ${name}: ${lastError}`);
    }

    const wait = 30 * round;
    console.log(`  ${name}: every mirror busy, waiting ${wait}s (round ${round}/3)`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }

  throw new Error(`overpass: could not fetch ${name} — last was ${lastError}`);
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

type Box = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Cut a polyline to a rectangle, returning the pieces that survive.
 *  Cohen–Sutherland per segment, stitched back into runs so a road that
 *  leaves and re-enters the box comes back as two lines, not one that
 *  short-cuts across the gap. */
function clipToBox(line: Array<[number, number]>, box: Box): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];

  const inside = (p: [number, number]) =>
    p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minZ && p[1] <= box.maxZ;

  /** where the segment a→b crosses the box edge, as a parameter in [0,1] */
  const clipSegment = (a: [number, number], b: [number, number]) => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const tests: Array<[number, number]> = [
      [-dx, a[0] - box.minX],
      [dx, box.maxX - a[0]],
      [-dz, a[1] - box.minZ],
      [dz, box.maxZ - a[1]],
    ];
    for (const [p, q] of tests) {
      if (p === 0) {
        if (q < 0) return undefined;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return undefined;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return undefined;
        if (r < t1) t1 = r;
      }
    }
    const at = (t: number): [number, number] => [round(a[0] + dx * t), round(a[1] + dz * t)];
    return [at(t0), at(t1)] as const;
  };

  for (let i = 0; i < line.length - 1; i++) {
    const piece = clipSegment(line[i], line[i + 1]);
    if (!piece) {
      if (run.length >= 2) out.push(run);
      run = [];
      continue;
    }
    const [from, to] = piece;
    if (run.length === 0) run.push(from);
    else if (run[run.length - 1][0] !== from[0] || run[run.length - 1][1] !== from[1]) {
      if (run.length >= 2) out.push(run);
      run = [from];
    }
    run.push(to);
    // a segment that left the box ends this run
    if (!inside(line[i + 1])) {
      if (run.length >= 2) out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out;
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
  console.log("fetching ANU Acton geometry from OpenStreetMap…");

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

  // The footpaths are most of what makes a campus map legible — you walk
  // between these buildings, you don't drive. Separate query: there are an
  // order of magnitude more of them than roads, and Overpass times out if
  // you ask for everything at once. `service` is deliberately excluded —
  // car park aisles and loading lanes are the bulk of the cost and add
  // nothing you would navigate by.
  // Campus roads are a different OSM class from the arterials around it:
  // Barry Drive is `primary`, the loop past Chifley is `service`. They want
  // to look different too, so they're fetched and kept apart.
  const lanes = await overpass("lanes", `[out:json][timeout:180];
    way["highway"~"^(service|unclassified|living_street)$"](${BBOX});
    out geom;`);
  console.log(`  ${lanes.length} campus lanes`);

  const paths = await overpass("paths", `[out:json][timeout:180];
    way["highway"~"^(footway|path|pedestrian|steps|cycleway)$"](${BBOX});
    out geom;`);
  console.log(`  ${paths.length} paths`);

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

  // Where the drawn campus actually ends. Everything linear is clipped to
  // this: without it Sullivans Creek and the arterials simply run off to
  // the horizon, which reads as an unfinished map rather than an edge.
  const drawn = bounds([...bookable.flatMap((b) => b.rings), ...scenery.map((b) => b.ring)]);
  const CLIP = {
    minX: drawn.minX - 40,
    maxX: drawn.maxX + 40,
    minZ: drawn.minZ - 40,
    maxZ: drawn.maxZ + 40,
  };

  const lines = (source: Element[], predicate: (el: Element) => boolean, tolerance = 2) =>
    source
      .filter(predicate)
      .flatMap((el) => (el.geometry ? clipToBox(simplify(el.geometry.map(project), tolerance), CLIP) : []))
      .filter((l) => l.length >= 2);

  // The creek is clipped tighter than the rest: at full extent it runs the
  // whole bounding box and dominates the frame end to end.
  const creekBox = {
    minX: CLIP.minX + (CLIP.maxX - CLIP.minX) * 0.06,
    maxX: CLIP.maxX - (CLIP.maxX - CLIP.minX) * 0.06,
    minZ: CLIP.minZ + (CLIP.maxZ - CLIP.minZ) * 0.14,
    maxZ: CLIP.maxZ - (CLIP.maxZ - CLIP.minZ) * 0.14,
  };
  const water = context
    .filter((el) => el.tags?.waterway === "stream")
    .flatMap((el) => (el.geometry ? clipToBox(simplify(el.geometry.map(project), 2), creekBox) : []))
    .filter((l) => l.length >= 2);
  const roads = lines(context, (el) => Boolean(el.tags?.highway));
  const campusLanes = lines(lanes, () => true, 2);

  // Paths get a coarser simplification than roads, and the short stubs go:
  // there are 800-odd of them, they render 2.6 m wide, and nobody navigates
  // a campus overview by the exact curve of a footpath. Anything under 12 m
  // is a kerb ramp or a doorway spur — bytes and draw calls for something
  // invisible at this scale.
  const footpaths = lines(paths, () => true, 5).filter((line) => {
    let length = 0;
    for (let i = 1; i < line.length; i++) {
      length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    }
    return length >= 12;
  });

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

/** The arterials around campus — Barry Drive, Clunies Ross and friends. */
export const ROADS: Ring[] = ${JSON.stringify(roads)};

/** Roads inside campus: service loops, car park aisles, delivery lanes. */
export const LANES: Ring[] = ${JSON.stringify(campusLanes)};

/** Footpaths, steps and service lanes — how you actually cross campus. */
export const PATHS: Ring[] = ${JSON.stringify(footpaths)};

export const ATTRIBUTION = "© OpenStreetMap contributors";
`;

  writeFileSync("src/data/campus.ts", out);
  const kb = (out.length / 1024).toFixed(0);
  console.log(
    `wrote src/data/campus.ts — ${bookable.length} bookable, ${scenery.length} scenery, ` +
      `${water.length} water, ${roads.length} roads, ${campusLanes.length} lanes, ` +
      `${footpaths.length} paths (${kb} kB)`,
  );
}

await main();
