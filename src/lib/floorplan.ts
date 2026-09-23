import type { CampusBuilding, Ring } from "../data/campus";

// Floor layouts, invented but derived from each building's REAL OpenStreetMap
// footprint. The footprint is rotated onto its minimum-area bounding box, a
// corridor is run down the long axis, and the bands of floor either side of
// it are cut on a grid — then anything that doesn't sit wholly inside the
// real outline is dropped. So Marie Reay's floors are Marie Reay-shaped and
// Birch's are Birch-shaped, and nothing floats outside a wall.
//
// What goes in those bands is what a university floor actually is: a stair
// and lift core (the same on every storey, because it's a shaft), a run of
// six to a dozen meeting rooms and a lab or two around it, and the rest open
// study space: pods of four desks with room round them, each desk bookable
// on its own.
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
const AISLE = 1.8; // between two bands on the same side, in a deep building
const MIN_DEPTH = 3; // shallowest band worth having
const MAX_DEPTH = 8; // deeper than this and rooms stop reading as rooms
const CELL = 1.5; // layout grid step along the corridor
const PARTY = 0.25; // wall between neighbouring rooms
const CORE_CELLS = 4; // stairs, lifts and toilets: 6 m of frontage
const ROOM_SHARE = 0.6; // of a floor's frontage, at most, for enclosed rooms

/** A study bench: two rows of desks back to back, running across the band.
 *  Every gap here is at least 0.2 m, because coordinates are rounded to the
 *  nearest 100 mm and a thinner gap could round shut. */
const DESK_DEPTH = 0.7; // front to back, along the corridor
const DESK_WIDTH = 1.2; // side to side, across the band
const DESK_GAP = 0.2; // between neighbouring desks, and back to back
const BENCH = 2 * DESK_DEPTH + DESK_GAP;
const POD_ACROSS = 2; // desks a side: a pod is four desks, two facing two
const BENCH_PITCH = BENCH + 4.8; // chairs round a pod, and room to move between pods
const BENCH_END = 0.8; // clear of a room's wall or the core
const WALKWAY = 1.0; // along the corridor side of a study area
const BENCHES_PER_AREA = 8; // pods, then a new study area letter

export type Rect = {
  /** centre, in the same local metre grid as src/data/campus.ts */
  cx: number;
  cz: number;
  /** extent along the corridor, and across it */
  w: number;
  d: number;
  /** rotation of the corridor axis, radians */
  angle: number;
};

export type PlannedRoom = Rect & {
  code: string;
  floor: number;
  capacity: number;
  features: string[];
  kind: RoomKind;
};

/** What the layout plans now, plus the kinds an older layout planned —
 *  a room kept from that layout because someone still has it booked keeps
 *  its kind, and still needs a name. */
export type RoomKind = "meeting" | "computer-lab" | "desk" | "tutorial" | "study" | "lecture";

const KIND_LABEL: Record<RoomKind, string> = {
  meeting: "Meeting room",
  "computer-lab": "Computer lab",
  desk: "Study desk",
  tutorial: "Tutorial room",
  study: "Group study",
  lecture: "Lecture theatre",
};

export function labelFor(kind: RoomKind): string {
  return KIND_LABEL[kind] ?? "Room";
}

export function isDesk(kind: string): boolean {
  return kind === "desk";
}

/** "MRTC 1A-07" → "1A", the study area a desk is in; undefined for a room. */
export function deskArea(code: string): string | undefined {
  return code.match(/ ([0-9G][A-Z])-\d+$/)?.[1];
}

/** "MRTC 1A-07" → "07", "MRTC 104" → "104": what's painted on the thing. */
export function shortCode(code: string): string {
  const tail = code.split(" ").pop() ?? code;
  return tail.includes("-") ? tail.slice(tail.indexOf("-") + 1) : tail;
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

/** A rect's four world-space corners, clockwise from its near-left. */
export function cornersOf(room: Rect): Array<[number, number]> {
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

/** Do two rotated rects overlap? Separating-axis theorem, with a hair of
 *  tolerance so two rects sharing an edge don't count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  const reach = (Math.hypot(a.w, a.d) + Math.hypot(b.w, b.d)) / 2;
  if (Math.hypot(a.cx - b.cx, a.cz - b.cz) >= reach) return false;
  const pa = cornersOf(a);
  const pb = cornersOf(b);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const along = (p: Array<[number, number]>) => p.map(([x, y]) => x * nx + y * ny);
      const ia = along(pa);
      const ib = along(pb);
      if (Math.max(...ia) <= Math.min(...ib) + 1e-6) return false;
      if (Math.max(...ib) <= Math.min(...ia) + 1e-6) return false;
    }
  }
  return true;
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

// --- the frame every floor of a building shares --------------------------

/** The bands of floor either side of the corridor, as [near, far] offsets
 *  across the building's short axis. A deep building gets more than one
 *  band a side, with an aisle between them, so its floor is used out to the
 *  windows rather than stopping 8 m from the corridor. A building too
 *  shallow for a central corridor gets one band with the corridor along an
 *  edge instead. */
function bandsFor(halfV: number): Array<[number, number]> {
  const usable = halfV - WALL;
  const half = CORRIDOR / 2;
  if (usable - half >= MIN_DEPTH) {
    const bands: Array<[number, number]> = [];
    for (const side of [-1, 1]) {
      // two deep at most: past that, a real floor turns to offices and
      // plant rooms, not more desks
      for (let near = half, n = 0; n < 2 && usable - near >= MIN_DEPTH; n++) {
        const depth = Math.min(usable - near, MAX_DEPTH);
        bands.push(side < 0 ? [-(near + depth), -near] : [near, near + depth]);
        near += depth + AISLE;
      }
    }
    return bands;
  }
  if (2 * usable - CORRIDOR >= MIN_DEPTH) {
    return [[-usable, Math.min(-usable + MAX_DEPTH, usable - CORRIDOR)]];
  }
  return [];
}

type Frame = {
  angle: number;
  bands: Array<[number, number]>;
  cells: number;
  /** u at the start of cell i */
  uAt: (cell: number) => number;
  /** a rect from corridor-frame bounds, or undefined if it isn't wholly
   *  inside the real outline */
  rect: (u0: number, u1: number, v0: number, v1: number) => Rect | undefined;
  /** fits[band][cell]: a one-cell room there would be inside the walls */
  fits: boolean[][];
};

function frameOf(building: CampusBuilding): Frame {
  const ring = building.plan;
  const box = orientedBox(ring);
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const startU = -box.halfU + WALL;
  const cells = Math.max(0, Math.floor((2 * box.halfU - 2 * WALL) / CELL));
  const uAt = (cell: number) => startU + cell * CELL;

  // Is every part of this rect's boundary inside the real outline? Corners
  // plus edge midpoints, so a notch in a concave building can't slip between
  // the probes. Tested on the ROUNDED geometry the rect will actually carry,
  // because rounding afterwards could nudge a corner back through a wall.
  const rect = (u0: number, u1: number, v0: number, v1: number): Rect | undefined => {
    const u = (u0 + u1) / 2;
    const v = (v0 + v1) / 2;
    const out: Rect = {
      cx: r1(box.cx + u * cos - v * sin),
      cz: r1(box.cz + u * sin + v * cos),
      w: r1(u1 - u0),
      d: r1(v1 - v0),
      angle: box.angle,
    };
    const corners = cornersOf(out);
    const probes = corners.flatMap((p, i) => {
      const q = corners[(i + 1) % corners.length];
      return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number]];
    });
    return probes.every((p) => containsPoint(ring, p)) ? out : undefined;
  };

  const bands = bandsFor(box.halfV);
  const fits = bands.map(([v0, v1]) =>
    Array.from({ length: cells }, (_, i) => walled(rect, uAt, i, 1, v0, v1) !== undefined),
  );
  return { angle: box.angle, bands, cells, uAt, rect, fits };
}

/** A walled space spanning cells [from, from + span) of a band. PARTY/2 off
 *  each end and each side leaves a wall between neighbours — which is both
 *  what a floor looks like and what keeps two rooms from touching once
 *  their coordinates are rounded to the nearest 100 mm. */
function walled(
  rect: Frame["rect"],
  uAt: Frame["uAt"],
  from: number,
  span: number,
  v0: number,
  v1: number,
): Rect | undefined {
  return rect(uAt(from) + PARTY / 2, uAt(from + span) - PARTY / 2, v0 + PARTY / 2, v1 - PARTY / 2);
}

type Slot = { band: number; from: number; span: number };

/** Where the stair and lift cores go: the middle of the building, or a
 *  third of the way in from each end if it's long enough to want two —
 *  nobody should be 50 m from a fire stair. Floor-independent, because a
 *  lift shaft goes all the way up. */
function coreSlots(frame: Frame): Slot[] {
  const length = frame.cells * CELL;
  const targets = length > 80 ? [0.3, 0.7] : [0.5];
  const out: Slot[] = [];
  for (const target of targets) {
    const centre = Math.round(frame.cells * target - CORE_CELLS / 2);
    search: for (let step = 0; step < frame.cells; step++) {
      for (const from of [centre + step, centre - step]) {
        for (let band = 0; band < frame.bands.length; band++) {
          if (from < 0 || from + CORE_CELLS > frame.cells) continue;
          if (out.some((s) => s.band === band && from < s.from + s.span + 2 && s.from < from + CORE_CELLS + 2)) continue;
          const [v0, v1] = frame.bands[band];
          const cellsFit = frame.fits[band].slice(from, from + CORE_CELLS).every(Boolean);
          if (cellsFit && walled(frame.rect, frame.uAt, from, CORE_CELLS, v0, v1)) {
            out.push({ band, from, span: CORE_CELLS });
            break search;
          }
        }
      }
    }
  }
  return out;
}

/** The stair, lift and toilet cores: not bookable, drawn so a floor reads
 *  as a floor. The same on every storey. */
export function planCores(building: CampusBuilding): Rect[] {
  const frame = frameOf(building);
  return coreSlots(frame).flatMap(({ band, from, span }) => {
    const [v0, v1] = frame.bands[band];
    const rect = walled(frame.rect, frame.uAt, from, span, v0, v1);
    return rect ? [rect] : [];
  });
}

// --- one floor -----------------------------------------------------------

export function planFloor(building: CampusBuilding, floor: number): PlannedRoom[] {
  const frame = frameOf(building);
  if (frame.bands.length === 0 || frame.cells === 0) return [];
  const random = rng(seedOf(`${building.code}:${floor}`));
  const level = floor === 0 ? "G" : String(floor);

  // what's already spoken for: outside the walls, or the core
  const taken = frame.fits.map((row) => row.map((fits) => !fits));
  const cores = coreSlots(frame);
  for (const core of cores) {
    for (let i = core.from; i < core.from + core.span; i++) taken[core.band][i] = true;
  }
  const coreCentres = cores.map((c) => c.from + c.span / 2);

  // --- the enclosed rooms, clustered round the core ---------------------

  // a floor usually has a lab, often two; meeting rooms run six to a dozen
  const labs = 1 + (random() < 0.5 ? 1 : 0) + (random() < 0.3 ? 1 : 0);
  const meetings = 6 + Math.floor(random() * 7);
  const wanted: Array<"computer-lab" | "meeting"> = [
    ...Array<"computer-lab">(labs).fill("computer-lab"),
    ...Array<"meeting">(meetings).fill("meeting"),
  ];

  // rooms get at most this much of the floor, so even a small building keeps
  // some study space; the first meeting room always goes in
  let budget = taken.flat().filter((t) => !t).length * ROOM_SHARE;

  const enclosed: Array<{ kind: "computer-lab" | "meeting"; u: number; band: number; rect: Rect }> = [];
  for (const kind of wanted) {
    let best: { slot: Slot; rect: Rect; score: number } | undefined;
    for (let band = 0; band < frame.bands.length; band++) {
      const [v0, v1] = frame.bands[band];
      const depth = v1 - v0;
      if (kind === "computer-lab" && depth < 4.5) continue;
      // a lab is about 60 m², a meeting room about 20
      const target = kind === "computer-lab" ? 60 : 20;
      const span = Math.max(2, Math.min(7, Math.round(target / depth / CELL)));
      const first = kind === "meeting" && !enclosed.some((room) => room.kind === "meeting");
      if (span > budget && !first) continue;
      // rooms open off the main corridor, not off an aisle between desks
      const offCorridor = Math.min(Math.abs(v0), Math.abs(v1)) > CORRIDOR ? 3 : 0;
      for (let from = 0; from + span <= frame.cells; from++) {
        if (taken[band].slice(from, from + span).some(Boolean)) continue;
        const centre = from + span / 2;
        const near = Math.min(...coreCentres.map((c) => Math.abs(c - centre)), frame.cells);
        // hug a wall that's already there (the core, another room) so the
        // rooms make one block and the study space stays in one piece
        const snug =
          (from > 0 && taken[band][from - 1] && frame.fits[band][from - 1]) ||
          (from + span < frame.cells && taken[band][from + span] && frame.fits[band][from + span]);
        const score = near - (snug ? 4 : 0) + offCorridor + random() * 3;
        if (best && score >= best.score) continue;
        const rect = walled(frame.rect, frame.uAt, from, span, v0, v1);
        if (rect) best = { slot: { band, from, span }, rect, score };
      }
    }
    if (!best) continue;
    const { slot, rect } = best;
    for (let i = slot.from; i < slot.from + slot.span; i++) taken[slot.band][i] = true;
    budget -= slot.span;
    enclosed.push({ kind, u: frame.uAt(slot.from + slot.span / 2), band: slot.band, rect });
  }

  // number along the corridor so consecutive room numbers are neighbours,
  // the way a real wayfinding scheme works
  enclosed.sort((a, b) => a.u - b.u || a.band - b.band);
  const rooms: PlannedRoom[] = enclosed.map((room, index) =>
    furnishRoom(room.kind, room.rect, `${building.code} ${level}${pad(index + 1)}`, floor, random),
  );

  // --- everything left is open study space, with pods of desks in it ---

  type Area = { u: number; band: number; desks: Array<{ rect: Rect; aisle: boolean }> };
  const areas: Area[] = [];
  for (let band = 0; band < frame.bands.length; band++) {
    const [v0, v1] = frame.bands[band];
    // the walkway runs along the corridor side; desks start at the far wall
    const corridorSide = Math.abs(v0) < Math.abs(v1) ? v0 : v1;
    const inward = corridorSide === v0 ? -1 : 1; // from the far wall toward the corridor
    const farWall = corridorSide === v0 ? v1 : v0;
    const usable = v1 - v0 - WALKWAY - 0.1;
    const perBench = Math.min(
      POD_ACROSS,
      Math.floor((usable + DESK_GAP) / (DESK_WIDTH + DESK_GAP)),
    );
    if (perBench < 1) continue;
    // the pod sits in the middle of the band, with open floor round it
    const inset = 0.1 + (usable - (perBench * (DESK_WIDTH + DESK_GAP) - DESK_GAP)) / 2;

    for (let from = 0; from < frame.cells; ) {
      if (taken[band][from]) {
        from++;
        continue;
      }
      let to = from;
      while (to < frame.cells && !taken[band][to]) to++;

      const uA = frame.uAt(from) + BENCH_END;
      const uB = frame.uAt(to) - BENCH_END;
      const benches = uB - uA >= BENCH ? Math.floor((uB - uA - BENCH) / BENCH_PITCH) + 1 : 0;
      const slack = uB - uA - (BENCH + (benches - 1) * BENCH_PITCH);

      let area: Area | undefined;
      for (let b = 0; b < benches; b++) {
        if (b % BENCHES_PER_AREA === 0) {
          area = { u: uA + slack / 2 + b * BENCH_PITCH, band, desks: [] };
          areas.push(area);
        }
        const u0 = uA + slack / 2 + b * BENCH_PITCH;
        for (const side of [0, 1]) {
          const du = u0 + side * (DESK_DEPTH + DESK_GAP);
          // from the walkway in, so desk 01 is the one you reach first
          for (let k = perBench - 1; k >= 0; k--) {
            const vNear = farWall + inward * (inset + k * (DESK_WIDTH + DESK_GAP));
            const vFar = vNear + inward * DESK_WIDTH;
            const rect = frame.rect(du, du + DESK_DEPTH, Math.min(vNear, vFar), Math.max(vNear, vFar));
            if (rect) area?.desks.push({ rect, aisle: k === perBench - 1 });
          }
        }
      }
      from = to;
    }
  }

  const desks: PlannedRoom[] = [];
  const lettered = areas.filter((a) => a.desks.length > 0).sort((a, b) => a.u - b.u || a.band - b.band);
  lettered.slice(0, 26).forEach((area, index) => {
    const letter = String.fromCharCode(65 + index);
    const quiet = random() < 0.4;
    area.desks.slice(0, 99).forEach(({ rect, aisle }, n) => {
      desks.push({
        ...rect,
        code: `${building.code} ${level}${letter}-${pad(n + 1)}`,
        floor,
        kind: "desk",
        capacity: 1,
        // the desk at the walkway end of a bench is the one a wheelchair
        // can pull straight up to
        features: [...(quiet ? ["quiet"] : []), ...(aisle ? ["accessible"] : [])],
      });
    });
  });

  return [...rooms, ...desks];
}

function furnishRoom(
  kind: "computer-lab" | "meeting",
  rect: Rect,
  code: string,
  floor: number,
  random: () => number,
): PlannedRoom {
  const area = rect.w * rect.d;
  // a meeting room's seats are its table, not its floor area: some have a
  // big table and room round it, some are packed
  const capacity =
    kind === "computer-lab"
      ? Math.max(10, Math.min(48, Math.round(area / 2.6)))
      : Math.max(3, Math.min(14, Math.round(area / (2.2 + random() * 2.2))));

  const features = ["whiteboard"];
  if (kind === "computer-lab" || random() < 0.5) features.push("projector");
  if (kind === "meeting" && random() < 0.5) features.push("videoconf");
  if (floor === 0 || random() < 0.7) features.push("accessible");

  return { ...rect, code, floor, kind, capacity, features };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
