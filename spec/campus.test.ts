import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { BUILDINGS, SCENERY, type Ring } from "../src/data/campus";
import {
  type PlannedRoom,
  type Rect,
  containsPoint,
  cornersOf,
  planCores,
  planFloor,
} from "../src/lib/floorplan";
import { DEMO_USERS, seed } from "../src/lib/seed";
import { addDays, today } from "../src/lib/slots";

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

/** Every pair that could touch, skipping the ones too far apart to — a floor
 *  of desks is hundreds of places, and a SAT run on every pair of them is
 *  slow for nothing. */
function touchingPairs<A extends Rect, B extends Rect>(items: A[], others?: B[]): Array<[A, Rect]> {
  const pool: Rect[] = others ?? items;
  const out: Array<[A, Rect]> = [];
  items.forEach((a, i) => {
    pool.forEach((b, j) => {
      if (!others && j <= i) return;
      const reach = (Math.hypot(a.w, a.d) + Math.hypot(b.w, b.d)) / 2;
      if (Math.hypot(a.cx - b.cx, a.cz - b.cz) < reach) out.push([a, b]);
    });
  });
  return out;
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
  const floors = BUILDINGS.flatMap((building) =>
    Array.from({ length: building.levels }, (_, floor) => ({
      building,
      floor,
      places: planFloor(building, floor),
    })),
  );

  it("lays out places on every floor of every building", () => {
    for (const { building, floor, places } of floors) {
      expect(places.length, `${building.code} floor ${floor}`).toBeGreaterThan(0);
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

  // What a real teaching floor is: a stair and lift core, a few meeting rooms
  // and a lab, and the rest of it open study space full of desks.
  it("makes each floor mostly desks, with a few meeting rooms and labs", () => {
    const area = (list: PlannedRoom[]) => list.reduce((n, p) => n + p.w * p.d, 0);
    for (const { building, floor, places } of floors) {
      const where = `${building.code} floor ${floor}`;
      for (const place of places) {
        expect(["meeting", "computer-lab", "desk"], where).toContain(place.kind);
      }

      const desks = places.filter((p) => p.kind === "desk");
      const enclosed = places.filter((p) => p.kind !== "desk");
      expect(enclosed.some((p) => p.kind === "meeting"), `${where} has no meeting room`).toBe(true);
      expect(enclosed.length, `${where} is a warren of rooms`).toBeLessThanOrEqual(7);
      expect(desks.length, `${where} has too few desks`).toBeGreaterThan(enclosed.length * 3);
      // and the desks hold most of the floor, not a corner of it: a desk's
      // own top is about a third of the floor it takes, with chair and aisle
      expect(area(desks) * 3, `${where}: desks are a sideshow`).toBeGreaterThan(area(enclosed));
    }
  });

  it("gives every building at least one computer lab", () => {
    for (const building of BUILDINGS) {
      const labs = floors
        .filter((f) => f.building === building)
        .flatMap((f) => f.places)
        .filter((p) => p.kind === "computer-lab");
      expect(labs.length, `${building.code} has no lab`).toBeGreaterThan(0);
    }
  });

  it("keeps every place inside its building's real footprint", () => {
    for (const { building, places } of floors) {
      for (const room of places) {
        for (const corner of cornersOf(room)) {
          expect(
            containsPoint(building.plan as Ring, corner),
            `${room.code} corner [${corner}] is outside ${building.code}`,
          ).toBe(true);
        }
      }
    }
  });

  it("never overlaps two places on the same floor", () => {
    for (const { places } of floors) {
      for (const [a, b] of touchingPairs(places)) {
        const other = (b as PlannedRoom).code;
        expect(overlaps(cornersOf(a), cornersOf(b)), `${a.code} overlaps ${other}`).toBe(false);
      }
    }
  });

  it("stacks a stair and lift core up every floor, clear of every place", () => {
    for (const building of BUILDINGS) {
      const cores = planCores(building);
      expect(cores.length, `${building.code} has no core`).toBeGreaterThan(0);
      for (const core of cores) {
        for (const corner of cornersOf(core)) {
          expect(containsPoint(building.plan as Ring, corner), `${building.code} core`).toBe(true);
        }
      }
      for (const { places } of floors.filter((f) => f.building === building)) {
        for (const [a, core] of touchingPairs(places, cores)) {
          expect(overlaps(cornersOf(a), cornersOf(core)), `${a.code} is in the core`).toBe(false);
        }
      }
    }
  });

  it("numbers rooms like room numbers and desks by study area, uniquely", () => {
    const codes = new Set<string>();
    for (const { building, floor, places } of floors) {
      const level = floor === 0 ? "G" : String(floor);
      for (const place of places) {
        expect(place.code).toMatch(
          place.kind === "desk"
            ? new RegExp(`^${building.code} ${level}[A-Z]-\\d{2}$`)
            : new RegExp(`^${building.code} ${level}\\d{2}$`),
        );
        // and never in the old "MRTC 1.04" shape, so a room kept from the
        // previous layout can't share a code with a new one
        expect(place.code).not.toMatch(/\d\.\d{2}$/);
        expect(codes.has(place.code), `duplicate ${place.code}`).toBe(false);
        codes.add(place.code);
      }
    }
  });

  it("gives every place a plausible capacity and real features", () => {
    const known = new Set(["whiteboard", "projector", "videoconf", "quiet", "accessible"]);
    for (const { places } of floors) {
      for (const place of places) {
        if (place.kind === "desk") expect(place.capacity, place.code).toBe(1);
        else if (place.kind === "meeting") {
          expect(place.capacity, place.code).toBeGreaterThanOrEqual(3);
        } else expect(place.capacity, place.code).toBeGreaterThanOrEqual(10);
        expect(place.capacity).toBeLessThanOrEqual(60);
        for (const feature of place.features) expect(known).toContain(feature);
      }
    }
  });
});

// A layout change reaches a database that already has one: the deployed
// volume outlives every deploy. Booked places must survive it — someone
// holding MRTC 1.05 next Tuesday still has MRTC 1.05 next Tuesday — while
// everything else moves onto the new plan.
describe("moving a database onto a new layout", () => {
  const tomorrow = addDays(today(), 1);
  const mrtc = BUILDINGS.find((b) => b.code === "MRTC");
  if (!mrtc) throw new Error("MRTC is no longer in src/data/campus.ts");
  const levelOne = planFloor(mrtc, 1);
  const anchor = levelOne.find((p) => p.kind === "desk") ?? levelOne[0];
  // the old room is 7 m by 5 m, dropped over one of the new desks
  const footprint = cornersOf({ ...anchor, w: 7, d: 5 });
  const under = (place: PlannedRoom) => overlaps(cornersOf(place), footprint);

  function freshCampus() {
    const client = new Database(":memory:");
    client.pragma("foreign_keys = ON");
    const db = drizzle(client);
    migrate(db, { migrationsFolder: "./drizzle" });
    seed(db, client);
    return { client, db };
  }

  function userId(client: Database.Database, uniId: string): number {
    return (client.prepare("SELECT id FROM users WHERE uni_id = ?").get(uniId) as { id: number })
      .id;
  }

  /** An old-layout room, on a floor that already has the new plan. */
  function legacyRoom(client: Database.Database, code: string): number {
    const building = client.prepare("SELECT id FROM buildings WHERE code = 'MRTC'").get() as {
      id: number;
    };
    return Number(
      client
        .prepare(
          `INSERT INTO rooms (building_id, code, floor, kind, capacity, features, cx, cz, w, d, angle)
           VALUES (?, ?, 1, 'tutorial', 20, '["whiteboard"]', ?, ?, 7, 5, ?)`,
        )
        .run(building.id, code, anchor.cx, anchor.cz, anchor.angle).lastInsertRowid,
    );
  }

  function book(client: Database.Database, roomId: number, user: number, date: string): void {
    client
      .prepare(
        `INSERT INTO bookings (room_id, user_id, date, start_slot, end_slot, purpose)
         VALUES (?, ?, ?, 4, 6, 'Kept')`,
      )
      .run(roomId, user, date);
  }

  function row(client: Database.Database, code: string) {
    return client.prepare("SELECT id, listed FROM rooms WHERE code = ?").get(code) as
      | { id: number; listed: number }
      | undefined;
  }

  it("keeps a place with a booking still to come, and parks the new places under it", () => {
    const { client, db } = freshCampus();
    const persona = userId(client, DEMO_USERS[0].uniId);
    const extra = userId(client, "u1100001"); // one of the fictional cast
    // as on an old volume's first boot, every day's fixture traffic is due
    // to be replanted — and none of it may land on a room that's leaving
    client.prepare("DELETE FROM bookings").run();

    const kept = legacyRoom(client, "MRTC 1.05");
    book(client, kept, persona, tomorrow);
    const history = legacyRoom(client, "MRTC 1.06");
    book(client, history, persona, "2020-03-02");
    const fixture = legacyRoom(client, "MRTC 1.07");
    book(client, fixture, extra, tomorrow);
    const empty = legacyRoom(client, "MRTC 1.08");

    seed(db, client); // the next boot

    // the booked room is still there, still offered, and still booked — by
    // its one real booking, not by demo traffic that would keep it alive
    expect(row(client, "MRTC 1.05")).toEqual({ id: kept, listed: 1 });
    expect(client.prepare("SELECT count(*) AS n FROM bookings WHERE room_id = ?").get(kept)).toEqual({
      n: 1,
    });
    expect(
      client
        .prepare("SELECT count(*) AS n FROM bookings WHERE room_id = ? AND cancelled_at IS NULL")
        .get(kept),
    ).toEqual({ n: 1 });

    // a room with only history keeps its row, because the booking points at
    // it, but leaves the map
    expect(row(client, "MRTC 1.06")).toEqual({ id: history, listed: 0 });

    // the cast's traffic is a fixture, replanted on the new layout, so it
    // doesn't hold an old room in place; an old room nobody booked just goes
    expect(row(client, "MRTC 1.07")).toBeUndefined();
    expect(row(client, "MRTC 1.08")).toBeUndefined();
    expect(
      client
        .prepare("SELECT count(*) AS n FROM bookings WHERE room_id IN (?, ?)")
        .get(fixture, empty),
    ).toEqual({ n: 0 });

    // every new place is in the database; the ones under the kept room wait
    expect(levelOne.some(under), "the old room should sit on some new places").toBe(true);
    for (const place of levelOne) {
      expect(row(client, place.code)?.listed, place.code).toBe(under(place) ? 0 : 1);
    }
  });

  it("brings those places back once the old room's bookings are over", () => {
    const { client, db } = freshCampus();
    const persona = userId(client, DEMO_USERS[0].uniId);
    const kept = legacyRoom(client, "MRTC 1.05");
    book(client, kept, persona, tomorrow);
    seed(db, client);

    // time passes: the booking is history now
    client.prepare("UPDATE bookings SET date = '2020-03-02' WHERE room_id = ?").run(kept);
    seed(db, client);

    expect(row(client, "MRTC 1.05")?.listed).toBe(0);
    for (const place of levelOne) expect(row(client, place.code)?.listed, place.code).toBe(1);
  });
});
