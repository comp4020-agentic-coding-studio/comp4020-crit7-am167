import type BetterSqlite3 from "better-sqlite3";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { BUILDINGS } from "../data/campus";
import { isDesk, planFloor, rectsOverlap } from "./floorplan";
import { hashPassword } from "./password";
import { bookings, buildings, rooms, users } from "./schema";
import { MAX_SLOTS_PER_BOOKING, SLOTS, bookableDates, today } from "./slots";

// Reference data, planted at boot so a fresh volume is a working campus
// rather than an empty one. Every step is idempotent and cheap to re-run:
// the server calls this on every start, including in the spec suite, which
// boots against a throwaway database each time.
//
// Demo bookings are seeded rolling forward, a fortnight at a time, so the
// map shows a plausibly busy campus whenever someone opens it rather than
// the empty grid of a demo whose fixture dates have gone stale.

type DB = BetterSQLite3Database<Record<string, never>>;

/** The four people the sign-in page offers by name. Their password is
 *  published in README.md — the sign-in is a prototype, and pretending
 *  otherwise would just make the app harder to look at. */
export const DEMO_USERS = [
  { uniId: "u1000001", displayName: "Alex Nguyen", role: "student" },
  { uniId: "u1000002", displayName: "Priya Shah", role: "student" },
  { uniId: "u1000003", displayName: "Tom Whitlam", role: "tutor" },
  { uniId: "u1000004", displayName: "Jess Okafor", role: "facilities" },
] as const;

export const DEMO_PASSWORD = "anu-acton";

/** Everybody else on campus. A university's rooms are booked by hundreds of
 *  people, not four, and it matters here for a reason that isn't realism:
 *  if the ambient traffic belonged to the demo personas, signing in as one
 *  would open "My bookings" on a thousand rows. The cast holds the campus's
 *  background load; the four above start with a handful of their own. */
const CAST_SIZE = 280;

const GIVEN = [
  "Aisha", "Ben", "Chloe", "Daniel", "Eleni", "Farhan", "Grace", "Hugo", "Ingrid", "Jamal",
  "Kiri", "Liang", "Mei", "Noah", "Oscar", "Petra", "Quinn", "Rosa", "Sam", "Tara",
  "Umar", "Vera", "Wei", "Xanthe", "Yuki", "Zara", "Ana", "Bodhi", "Cara", "Dev",
  "Esme", "Finn", "Georgia", "Hana", "Isaac", "Jun", "Kate", "Leo", "Mila", "Nate",
];

const FAMILY = [
  "Adams", "Bianchi", "Chen", "Dlamini", "Edwards", "Ferreira", "Gupta", "Hoang", "Ivanov",
  "Jensen", "Kaur", "Lombardi", "Mwangi", "Nakamura", "O'Brien", "Petrov", "Quigley", "Rahman",
  "Silva", "Tran", "Ueda", "Vasquez", "Wong", "Yilmaz", "Zhang", "Ahmed", "Brooks", "Costa",
];

/** Who the cast are, derived rather than listed — deterministic, so a fresh
 *  volume and an old one agree about who booked what. */
function cast(): Array<{ uniId: string; displayName: string; role: string }> {
  const random = rng(seedOf("cast"));
  return Array.from({ length: CAST_SIZE }, (_, i) => ({
    uniId: `u1${String(100001 + i).padStart(6, "0")}`,
    displayName: `${GIVEN[Math.floor(random() * GIVEN.length)]} ${
      FAMILY[Math.floor(random() * FAMILY.length)]
    }`,
    role: random() < 0.12 ? "tutor" : random() < 0.04 ? "facilities" : "student",
  }));
}

const PURPOSES = [
  "COMP4020 studio",
  "Group project meeting",
  "Thesis supervision",
  "Reading group",
  "Lab session",
  "Tutorial",
  "Interview panel",
  "Quiet study",
  "Seminar",
  "Standup",
];

export function seed(db: DB, client: BetterSqlite3.Database): void {
  seedBuildings(db);
  seedUsers(db);
  const planned = reconcileRooms(db, client);
  seedBookings(db, client, planned);
}

function seedBuildings(db: DB): void {
  for (const building of BUILDINGS) {
    db.insert(buildings)
      .values({
        code: building.code,
        name: building.name,
        slug: building.slug,
        levels: building.levels,
        rings: JSON.stringify(building.rings),
        plan: JSON.stringify(building.plan),
        centreX: building.centre[0],
        centreZ: building.centre[1],
        radius: building.radius,
      })
      .onConflictDoUpdate({
        target: buildings.code,
        // geometry can change when scripts/fetch-campus.ts is re-run
        set: {
          name: sql`excluded.name`,
          slug: sql`excluded.slug`,
          levels: sql`excluded.levels`,
          rings: sql`excluded.rings`,
          plan: sql`excluded.plan`,
          centreX: sql`excluded.centre_x`,
          centreZ: sql`excluded.centre_z`,
          radius: sql`excluded.radius`,
        },
      })
      .run();
  }
}

/** Bring each building's places into line with src/lib/floorplan.ts, on
 *  every boot — a fresh volume and one that's held an older layout for
 *  months both end up on the current plan, and nobody loses a booking.
 *
 *  A place the plan no longer has is dealt with by what points at it:
 *  - the cast's bookings are fixtures, not anyone's plans, so they go (and
 *    seedBookings replants them on the new layout);
 *  - with a real booking still to come, it stays exactly where it is,
 *    listed and bookable, and the new places under it wait;
 *  - with only past or cancelled bookings, the row stays so that history
 *    still has a room to name, but it leaves the map;
 *  - with nothing at all, it's deleted.
 *  Once a kept room's last booking is over, the next boot unlists it and
 *  the new places it was covering come back.
 *
 *  Returns every code the current plan has, campus-wide. */
function reconcileRooms(db: DB, client: BetterSqlite3.Database): Set<string> {
  const everyCode = new Set<string>();
  const castIds = db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.uniId,
        cast().map((u) => u.uniId),
      ),
    )
    .all()
    .map((u) => u.id);
  const from = today();

  const hasBooking = client.prepare("SELECT 1 FROM bookings WHERE room_id = ? LIMIT 1");
  const hasLiveBooking = client.prepare(
    "SELECT 1 FROM bookings WHERE room_id = ? AND cancelled_at IS NULL AND date >= ? LIMIT 1",
  );

  for (const source of BUILDINGS) {
    const building = db.select().from(buildings).where(eq(buildings.code, source.code)).get();
    if (!building) continue;

    const planned = Array.from({ length: source.levels }, (_, floor) =>
      planFloor(source, floor),
    ).flat();
    const plannedCodes = new Set(planned.map((place) => place.code));
    for (const code of plannedCodes) everyCode.add(code);
    const existing = db.select().from(rooms).where(eq(rooms.buildingId, building.id)).all();
    const byCode = new Map(existing.map((room) => [room.code, room]));
    const legacy = existing.filter((room) => !plannedCodes.has(room.code));

    client.transaction(() => {
      if (legacy.length > 0 && castIds.length > 0) {
        db.delete(bookings)
          .where(
            and(
              inArray(
                bookings.roomId,
                legacy.map((room) => room.id),
              ),
              inArray(bookings.userId, castIds),
            ),
          )
          .run();
      }

      const kept: typeof legacy = [];
      for (const room of legacy) {
        if (!hasBooking.get(room.id)) {
          db.delete(rooms).where(eq(rooms.id, room.id)).run();
          continue;
        }
        const live = hasLiveBooking.get(room.id, from) !== undefined;
        if (live) kept.push(room);
        if (room.listed !== live) {
          db.update(rooms).set({ listed: live }).where(eq(rooms.id, room.id)).run();
        }
      }

      for (const place of planned) {
        const values = {
          buildingId: building.id,
          code: place.code,
          floor: place.floor,
          kind: place.kind,
          capacity: place.capacity,
          features: JSON.stringify(place.features),
          cx: place.cx,
          cz: place.cz,
          w: place.w,
          d: place.d,
          angle: place.angle,
          listed: !kept.some((room) => room.floor === place.floor && rectsOverlap(room, place)),
        };
        const current = byCode.get(place.code);
        if (!current) {
          db.insert(rooms).values(values).run();
        } else if (
          (Object.keys(values) as Array<keyof typeof values>).some((key) => current[key] !== values[key])
        ) {
          db.update(rooms).set(values).where(eq(rooms.id, current.id)).run();
        }
      }
    })();
  }
  return everyCode;
}

function seedUsers(db: DB): void {
  const existing = new Set(db.select({ uniId: users.uniId }).from(users).all().map((u) => u.uniId));
  const missing = [...DEMO_USERS, ...cast()].filter((person) => !existing.has(person.uniId));
  if (missing.length === 0) return;

  // scrypt is deliberately slow, which is the point of it — and a reason to
  // call it once rather than 284 times on a cold boot. Every seeded person
  // shares one published password, so they share its hash too. A real
  // directory would never do this; a fixture whose password is printed in
  // the README loses nothing by it.
  const shared = hashPassword(DEMO_PASSWORD);

  db.insert(users)
    .values(
      missing.map((person) => ({
        uniId: person.uniId,
        displayName: person.displayName,
        role: person.role,
        passwordHash: shared,
      })),
    )
    .run();
}

/** Plant a fortnight of plausible traffic, one day at a time, skipping any
 *  day the demo people have already been booked into. Real bookings made by
 *  real visitors never trigger a reseed and are never touched.
 *
 *  Only places in the current plan get fixture traffic: a room kept from an
 *  older layout is on its way out, and a demo booking there would keep it
 *  on the map as if someone real had booked it. */
function seedBookings(db: DB, client: BetterSqlite3.Database, planned: Set<string>): void {
  const personas = db
    .select()
    .from(users)
    .where(
      inArray(
        users.uniId,
        DEMO_USERS.map((u) => u.uniId),
      ),
    )
    .all();
  const people = db
    .select()
    .from(users)
    .where(
      inArray(
        users.uniId,
        cast().map((u) => u.uniId),
      ),
    )
    .all();
  if (people.length === 0) return;

  const all = db
    .select({ id: rooms.id, code: rooms.code, buildingId: rooms.buildingId, kind: rooms.kind })
    .from(rooms)
    .where(eq(rooms.listed, true))
    .all()
    .filter((room) => planned.has(room.code));
  if (all.length === 0) return;
  const ids = all.map((r) => r.id);
  const heldOn = client.prepare(
    "SELECT room_id, start_slot, end_slot FROM bookings WHERE date = ? AND cancelled_at IS NULL",
  );

  const insert = client.prepare(
    `INSERT INTO bookings (room_id, user_id, date, start_slot, end_slot, purpose)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const date of bookableDates()) {
    const already = db
      .select({ n: sql<number>`count(*)` })
      .from(bookings)
      .where(
        and(
          eq(bookings.date, date),
          inArray(
            bookings.userId,
            people.map((p) => p.id),
          ),
        ),
      )
      .get();
    if ((already?.n ?? 0) > 0) continue;


    // Real bookings may already be on this day — made before this boot got
    // round to seeding it, or held on a room kept from an older layout —
    // and the fixture traffic has to fit round them, never on top.
    const real = heldOn.all(date) as Array<{ room_id: number; start_slot: number; end_slot: number }>;
    const clear = (b: { roomId: number; startSlot: number; endSlot: number }) =>
      !real.some((r) => r.room_id === b.roomId && r.start_slot < b.endSlot && r.end_slot > b.startSlot);

    const random = rng(seedOf(`bookings:${date}`));
    const rows = planDay(date, all, random).filter(clear).map((b) => [
      b.roomId,
      people[Math.floor(random() * people.length) % people.length].id,
      date,
      b.startSlot,
      b.endSlot,
      PURPOSES[Math.floor(random() * PURPOSES.length) % PURPOSES.length],
    ]);

    // and a couple for each named persona, so signing in at the crit opens
    // a "My bookings" page with something on it — and so the map has rooms
    // tinted as yours to look at
    const held = new Set(rows.map((row) => `${row[0]}:${row[3]}`));
    for (const persona of personas) {
      if (random() > 0.45) continue;
      const roomId = ids[Math.floor(random() * ids.length) % ids.length];
      const startSlot = 2 + Math.floor(random() * 16);
      const endSlot = startSlot + 1 + Math.floor(random() * 3);
      const clashes = rows.some(
        (row) => row[0] === roomId && (row[3] as number) < endSlot && (row[4] as number) > startSlot,
      );
      if (clashes || !clear({ roomId, startSlot, endSlot })) continue;
      if (endSlot > SLOTS || held.has(`${roomId}:${startSlot}`)) continue;
      rows.push([
        roomId,
        persona.id,
        date,
        startSlot,
        endSlot,
        PURPOSES[Math.floor(random() * PURPOSES.length) % PURPOSES.length],
      ]);
    }

    client.transaction(() => {
      for (const row of rows) insert.run(row);
    })();
  }
}

/** One day of non-overlapping bookings, shaped like a real campus: busiest
 *  between 10 and 4, quiet at the edges, dead at the weekend — and, most
 *  importantly for a map you're meant to read, uneven between buildings.
 *
 *  A campus where every building sits at 88% free gives the map nothing to
 *  say. Each building gets its own pressure for the day, so some are
 *  heaving and some are empty and choosing where to go is a real decision. */
function planDay(
  date: string,
  allRooms: Array<{ id: number; buildingId: number; kind: string }>,
  random: () => number,
): Array<{ roomId: number; startSlot: number; endSlot: number }> {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;

  const pressure = new Map<number, number>();
  for (const room of allRooms) {
    if (!pressure.has(room.buildingId)) {
      const base = rng(seedOf(`pressure:${date}:${room.buildingId}`))();
      pressure.set(room.buildingId, weekend ? base * 0.18 : 0.2 + base * 0.75);
    }
  }

  const out: Array<{ roomId: number; startSlot: number; endSlot: number }> = [];
  for (const room of allRooms) {
    // most desks are walked up to rather than booked, so a desk is taken
    // less often, and for a block or two rather than a whole day of meetings
    const desk = isDesk(room.kind);
    const busy = (pressure.get(room.buildingId) ?? 0.4) * (desk ? 0.6 : 1);
    if (random() > busy) continue;

    // the teaching day clusters between 10:00 and 16:00 — slots 4 to 16
    let slot = Math.floor(random() * 5);
    const blocks = desk ? 1 + Math.floor(random() * 2) : 2 + Math.floor(random() * 3);
    for (let i = 0; i < blocks; i++) {
      slot += Math.floor(random() * 3);
      const length = 1 + Math.floor(random() * MAX_SLOTS_PER_BOOKING);
      if (slot + length > SLOTS) break;
      out.push({ roomId: room.id, startSlot: slot, endSlot: slot + length });
      slot += length;
    }
  }
  return out;
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
