import { describe, expect, it } from "vitest";
import { BUILDINGS, SCENERY, type Ring } from "../src/data/campus";
import { containsPoint, cornersOf, planFloor } from "../src/lib/floorplan";

// The campus geometry is real (OpenStreetMap footprints, baked into
// src/data/campus.ts by scripts/fetch-campus.ts); the floor layouts inside it
// are invented but derived from that real outline. These check the contract
// both halves have to keep, because a room that floats outside its building
// or overlaps its neighbour is visible the moment anyone looks at the map.

/** Axis-aligned overlap test on two rotated rects, via the separating-axis
 *  theorem — the rooms are rotated to their building's long axis, so a plain
 *  bbox comparison would report overlaps that aren't there. */
function overlaps(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      // outward normal of this edge
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const projectOnto = (p: Array<[number, number]>) => p.map(([x, y]) => x * nx + y * ny);
      const pa = projectOnto(a);
      const pb = projectOnto(b);
      // a hair of tolerance so rooms sharing a wall don't read as overlapping
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6) return false;
      if (Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  }
  return true;
}

describe("campus data", () => {
  it("has the bookable buildings, each with a usable footprint", () => {
    expect(BUILDINGS.length).toBeGreaterThanOrEqual(8);
    for (const building of BUILDINGS) {
      expect(building.plan.length, `${building.code} plan ring`).toBeGreaterThanOrEqual(3);
      expect(building.levels, `${building.code} levels`).toBeGreaterThanOrEqual(1);
      expect(building.rings, `${building.code} rings`).toContainEqual(building.plan);
    }
  });

  it("gives every building a unique code and slug", () => {
    expect(new Set(BUILDINGS.map((b) => b.code)).size).toBe(BUILDINGS.length);
    expect(new Set(BUILDINGS.map((b) => b.slug)).size).toBe(BUILDINGS.length);
    for (const building of BUILDINGS) {
      expect(building.slug, `${building.code} slug`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("draws the rest of campus as context", () => {
    expect(SCENERY.length).toBeGreaterThan(50);
  });
});

describe("floorplan", () => {
  it("lays out rooms on every floor of every building", () => {
    for (const building of BUILDINGS) {
      for (let floor = 0; floor < building.levels; floor++) {
        const rooms = planFloor(building, floor);
        expect(rooms.length, `${building.code} floor ${floor}`).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic — the same building and floor plan identically", () => {
    for (const building of BUILDINGS.slice(0, 3)) {
      expect(planFloor(building, 1)).toEqual(planFloor(building, 1));
    }
  });

  it("gives each floor a different layout", () => {
    const tall = BUILDINGS.find((b) => b.levels >= 3);
    expect(tall, "need a building with 3+ levels to test this").toBeDefined();
    if (!tall) return;
    expect(planFloor(tall, 0)).not.toEqual(planFloor(tall, 1));
  });

  it("keeps every room inside its building's real footprint", () => {
    for (const building of BUILDINGS) {
      for (let floor = 0; floor < building.levels; floor++) {
        for (const room of planFloor(building, floor)) {
          for (const corner of cornersOf(room)) {
            expect(
              containsPoint(building.plan as Ring, corner),
              `${room.code} corner [${corner}] is outside ${building.code}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("never overlaps two rooms on the same floor", () => {
    for (const building of BUILDINGS) {
      for (let floor = 0; floor < building.levels; floor++) {
        const rooms = planFloor(building, floor);
        for (let i = 0; i < rooms.length; i++) {
          for (let j = i + 1; j < rooms.length; j++) {
            expect(
              overlaps(cornersOf(rooms[i]), cornersOf(rooms[j])),
              `${rooms[i].code} overlaps ${rooms[j].code}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("numbers rooms the way a room number reads, uniquely per building", () => {
    for (const building of BUILDINGS) {
      const codes = new Set<string>();
      for (let floor = 0; floor < building.levels; floor++) {
        for (const room of planFloor(building, floor)) {
          expect(room.code).toMatch(new RegExp(`^${building.code} ${floor}\\.\\d{2}$`));
          expect(codes.has(room.code), `duplicate ${room.code}`).toBe(false);
          codes.add(room.code);
        }
      }
    }
  });

  it("gives every room a plausible capacity and real features", () => {
    const known = new Set(["whiteboard", "projector", "videoconf", "quiet", "accessible"]);
    for (const building of BUILDINGS) {
      for (const room of planFloor(building, 1)) {
        expect(room.capacity).toBeGreaterThanOrEqual(2);
        expect(room.capacity).toBeLessThanOrEqual(120);
        for (const feature of room.features) expect(known).toContain(feature);
      }
    }
  });
});
