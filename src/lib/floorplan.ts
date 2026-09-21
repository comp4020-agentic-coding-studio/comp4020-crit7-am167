import type { CampusBuilding, Ring } from "../data/campus";

// Floor layouts, invented but derived from each building's REAL OpenStreetMap
// footprint. The footprint is rotated onto its minimum-area bounding box, a
// corridor is run down the long axis, and rooms are cut either side of it on
// a grid — then any room that doesn't sit wholly inside the real outline is
// dropped. So Marie Reay's floors are Marie Reay-shaped and Birch's are
// Birch-shaped, and nothing floats outside a wall.
//
// It's pure and deterministic: the same building and floor always plan the
// same way, seeded from the building code. That's what lets the layout live
// in the database as seeded rows and still be reproducible from source.
//
// One thing this is NOT: accurate. ANU's real floor plans aren't open data.
// README.md says so plainly — the outlines are real, the insides are fiction.

/** metres */
const WALL = 1.2; // setback from the outer wall
const CORRIDOR = 2.4; // central corridor width
const MIN_DEPTH = 3; // shallowest room worth having
const MAX_DEPTH = 8; // deeper than this and rooms stop reading as rooms
const CELL = 1.5; // layout grid step along the corridor
const PARTY = 0.25; // wall between neighbouring rooms

export type PlannedRoom = {
  code: string;
  floor: number;
  /** centre, in the same local metre grid as src/data/campus.ts */
  cx: number;
  cz: number;
  /** extent along the corridor, and across it */
  w: number;
  d: number;
  /** rotation of the corridor axis, radians */
  angle: number;
  capacity: number;
  features: string[];
  kind: RoomKind;
};

export type RoomKind = "meeting" | "tutorial" | "computer-lab" | "study" | "lecture";

const KIND_LABEL: Record<RoomKind, string> = {
  meeting: "Meeting room",
  tutorial: "Tutorial room",
  "computer-lab": "Computer lab",
  study: "Group study",
  lecture: "Lecture theatre",
};

export function labelFor(kind: RoomKind): string {
  return KIND_LABEL[kind];
}

// --- geometry ------------------------------------------------------------

/** Ray casting. Points exactly on an edge are undefined either way, which is
 *  why the layout culls with a margin rather than relying on this alone. */
export function containsPoint(ring: Ring, [x, z]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** A room's four world-space corners, clockwise from its near-left. */
export function cornersOf(room: PlannedRoom): Array<[number, number]> {
  const cos = Math.cos(room.angle);
  const sin = Math.sin(room.angle);
  const hw = room.w / 2;
  const hd = room.d / 2;
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as Array<[number, number]>
  ).map(([u, v]) => [room.cx + u * cos - v * sin, room.cz + u * sin + v * cos]);
}

/** Andrew's monotone chain. */
function hull(points: Ring): Ring {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (pts: Ring): Ring => {
    const out: Ring = [];
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

type Box = { angle: number; cx: number; cz: number; halfU: number; halfV: number };

/** Minimum-area enclosing rectangle, by rotating calipers over hull edges.
 *  Its long axis is the one a corridor naturally runs down. */
function orientedBox(ring: Ring): Box {
  const h = hull(ring);
  let best: Box | undefined;

  for (let i = 0; i < h.length; i++) {
    const [x1, z1] = h[i];
    const [x2, z2] = h[(i + 1) % h.length];
    const angle = Math.atan2(z2 - z1, x2 - x1);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, z] of h) {
      const u = x * cos - z * sin;
      const v = x * sin + z * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }

    const halfU = (maxU - minU) / 2;
    const halfV = (maxV - minV) / 2;
    if (best && halfU * halfV >= best.halfU * best.halfV) continue;

    // centre back in world space
    const mu = (minU + maxU) / 2;
    const mv = (minV + maxV) / 2;
    const back = Math.cos(angle);
    const backSin = Math.sin(angle);
    best = {
      angle,
      cx: mu * back - mv * backSin,
      cz: mu * backSin + mv * back,
      halfU,
      halfV,
    };
  }

  const box = best ?? { angle: 0, cx: 0, cz: 0, halfU: 1, halfV: 1 };
  // keep u as the LONG axis so the corridor always runs the length
  return box.halfU >= box.halfV
    ? box
    : { ...box, angle: box.angle + Math.PI / 2, halfU: box.halfV, halfV: box.halfU };
}

// --- deterministic randomness -------------------------------------------

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length) % items.length];
}

// --- layout --------------------------------------------------------------

/** The bands of floor either side of the corridor, as [near, far] offsets
 *  across the building's short axis. A building too shallow for a central
 *  corridor gets one band with the corridor along an edge instead. */
function bandsFor(halfV: number): Array<[number, number]> {
  const usable = halfV - WALL;
  const half = CORRIDOR / 2;
  if (usable - half >= MIN_DEPTH) {
    const depth = Math.min(usable - half, MAX_DEPTH);
    return [
      [-half - depth, -half],
      [half, half + depth],
    ];
  }
  if (2 * usable - CORRIDOR >= MIN_DEPTH) {
    return [[-usable, Math.min(-usable + MAX_DEPTH, usable - CORRIDOR)]];
  }
  return [];
}

export function planFloor(building: CampusBuilding, floor: number): PlannedRoom[] {
  const ring = building.plan;
  const box = orientedBox(ring);
  const random = rng(seedOf(`${building.code}:${floor}`));
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const toWorld = (u: number, v: number): [number, number] => [
    box.cx + u * cos - v * sin,
    box.cz + u * sin + v * cos,
  ];

  // Is every part of this rect's boundary inside the real outline? Corners
  // plus edge midpoints, so a notch in a concave building can't slip between
  // the probes. Tested on the ROUNDED geometry the room will actually carry,
  // because rounding afterwards could nudge a corner back through a wall.
  const encloses = (room: PlannedRoom): boolean => {
    const corners = cornersOf(room);
    const probes = corners.flatMap((p, i) => {
      const q = corners[(i + 1) % corners.length];
      return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number]];
    });
    return probes.every((p) => containsPoint(ring, p));
  };

  const rooms: PlannedRoom[] = [];
  const startU = -box.halfU + WALL;
  const cells = Math.floor((2 * box.halfU - 2 * WALL) / CELL);

  /** One room, or undefined if it wouldn't sit wholly inside the building. */
  const roomAt = (from: number, span: number, v0: number, v1: number) => {
    // PARTY/2 off each end leaves a wall between neighbours — which is both
    // what a floor really looks like and what keeps two rooms from touching
    // once their coordinates are rounded to the nearest 100 mm.
    const u0 = startU + from * CELL + PARTY / 2;
    const u1 = startU + (from + span) * CELL - PARTY / 2;
    const [cx, cz] = toWorld((u0 + u1) / 2, (v0 + v1) / 2);
    const room: PlannedRoom = {
      code: "",
      floor,
      cx: r1(cx),
      cz: r1(cz),
      w: r1(u1 - u0),
      d: r1(v1 - v0 - PARTY),
      angle: box.angle,
      capacity: 0,
      features: [],
      kind: "meeting",
    };
    return encloses(room) ? room : undefined;
  };

  /** Split a run of usable cells into rooms of varying frontage. */
  const cut = (offset: number, length: number, v0: number, v1: number): void => {
    let at = 0;
    while (length - at >= 2) {
      const remaining = length - at;
      // 2–5 cells (3–7.5 m) of frontage, never leaving a 1-cell orphan
      let span = 2 + Math.floor(random() * 4);
      if (span > remaining) span = remaining;
      if (remaining - span === 1) span = remaining;

      const room = roomAt(offset + at, span, v0, v1);
      if (room) rooms.push(room);
      at += span;
    }
  };

  for (const [v0, v1] of bandsFor(box.halfV)) {
    // walk the band, gathering runs of consecutive cells that fit
    let run = 0;
    for (let i = 0; i <= cells; i++) {
      if (i < cells && roomAt(i, 1, v0, v1) !== undefined) {
        run++;
        continue;
      }
      if (run >= 2) cut(i - run, run, v0, v1);
      run = 0;
    }
  }

  // number along the corridor so consecutive room numbers are neighbours,
  // the way a real wayfinding scheme works
  rooms.sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  return rooms.map((room, index) => furnish(building, room, index, random));
}

function furnish(
  building: CampusBuilding,
  room: PlannedRoom,
  index: number,
  random: () => number,
): PlannedRoom {
  const area = room.w * room.d;
  const kind: RoomKind =
    room.floor === 0 && area > 55
      ? "lecture"
      : area > 42
        ? pick(random, ["tutorial", "computer-lab"] as const)
        : area > 22
          ? pick(random, ["tutorial", "study"] as const)
          : "meeting";

  // roughly 2 m² a seat in a flat room, tighter in raked seating
  const perSeat = kind === "lecture" ? 1.1 : kind === "computer-lab" ? 2.6 : 2.1;
  const capacity = Math.max(2, Math.min(120, Math.round(area / perSeat)));

  const features: string[] = [];
  if (kind !== "study" || random() < 0.6) features.push("whiteboard");
  if (kind === "lecture" || kind === "tutorial" || random() < 0.35) features.push("projector");
  if (random() < 0.3) features.push("videoconf");
  if (kind === "study" && random() < 0.5) features.push("quiet");
  if (room.floor === 0 || random() < 0.6) features.push("accessible");

  return {
    ...room,
    code: `${building.code} ${room.floor}.${String(index + 1).padStart(2, "0")}`,
    capacity,
    features,
    kind,
  };
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
