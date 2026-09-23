import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "./db";
import { isDesk } from "./floorplan";
import { publish } from "./events";
import { roomSlug } from "./links";
import { type Booking, type Building, type Room, bookings, buildings, rooms, users } from "./schema";
import {
  MAX_DAYS_AHEAD,
  MAX_SLOTS_PER_BOOKING,
  SLOTS,
  bookingPhase,
  currentSlot,
  daysBetween,
  isBookableDate,
  today,
} from "./slots";

// Reading and writing the one thing this app is for.
//
// A booking is a half-open run of half-hour slots on one date, so "do these
// clash" is `a.start < b.end && a.end > b.start` — no date library, no
// timezone arithmetic at comparison time. The rules live here rather than in
// the API route so the page, the route and the tests all agree about what a
// legal booking is.

export type BookingError =
  | "signed-out"
  | "no-room"
  | "bad-date"
  | "bad-range"
  | "too-long"
  | "past"
  | "clash";

export const BOOKING_ERRORS: Record<BookingError, string> = {
  "signed-out": "Sign in before you book a room.",
  "no-room": "That room doesn't exist.",
  "bad-date": `Pick a date between today and ${MAX_DAYS_AHEAD} days from now.`,
  "bad-range": "A booking has to finish after it starts, within opening hours.",
  "too-long": `Bookings run to ${MAX_SLOTS_PER_BOOKING / 2} hours at most.`,
  past: "That time has already been.",
  clash: "Someone booked that room while you were deciding.",
};

export function errorMessage(code: string | null | undefined): string | undefined {
  return code && code in BOOKING_ERRORS ? BOOKING_ERRORS[code as BookingError] : undefined;
}

// --- reads ---------------------------------------------------------------

export type RoomRow = Room & { buildingSlug: string; buildingCode: string; buildingName: string };

export function listBuildings(): Building[] {
  return db.select().from(buildings).orderBy(asc(buildings.name)).all();
}

export function buildingBySlug(slug: string): Building | undefined {
  return db.select().from(buildings).where(eq(buildings.slug, slug)).get();
}

/** The places a building offers right now: rooms first, then desks, floor
 *  by floor. A place that isn't listed (see the schema) is left out. */
export function roomsInBuilding(buildingId: number): Room[] {
  return db
    .select()
    .from(rooms)
    .where(and(eq(rooms.buildingId, buildingId), eq(rooms.listed, true)))
    .orderBy(asc(rooms.floor), asc(rooms.code))
    .all();
}

export function roomByCode(code: string): RoomRow | undefined {
  return db
    .select({
      ...roomColumns,
      buildingSlug: buildings.slug,
      buildingCode: buildings.code,
      buildingName: buildings.name,
    })
    .from(rooms)
    .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
    .where(eq(rooms.code, code))
    .get();
}

export function roomById(id: number): RoomRow | undefined {
  return db
    .select({
      ...roomColumns,
      buildingSlug: buildings.slug,
      buildingCode: buildings.code,
      buildingName: buildings.name,
    })
    .from(rooms)
    .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
    .where(eq(rooms.id, id))
    .get();
}

const roomColumns = {
  id: rooms.id,
  buildingId: rooms.buildingId,
  code: rooms.code,
  floor: rooms.floor,
  kind: rooms.kind,
  capacity: rooms.capacity,
  features: rooms.features,
  cx: rooms.cx,
  cz: rooms.cz,
  w: rooms.w,
  d: rooms.d,
  angle: rooms.angle,
  listed: rooms.listed,
};

export type BookingRow = Booking & { bookedBy: string; bookedByUniId: string };

/** Every live booking on one date for a set of rooms, with who holds it. */
export function bookingsOn(roomIds: number[], date: string): BookingRow[] {
  if (roomIds.length === 0) return [];
  return db
    .select({
      id: bookings.id,
      roomId: bookings.roomId,
      userId: bookings.userId,
      date: bookings.date,
      startSlot: bookings.startSlot,
      endSlot: bookings.endSlot,
      purpose: bookings.purpose,
      createdAt: bookings.createdAt,
      cancelledAt: bookings.cancelledAt,
      bookedBy: users.displayName,
      bookedByUniId: users.uniId,
    })
    .from(bookings)
    .innerJoin(users, eq(users.id, bookings.userId))
    .where(and(eq(bookings.date, date), isNull(bookings.cancelledAt), inArray(bookings.roomId, roomIds)))
    .orderBy(asc(bookings.startSlot))
    .all();
}

export type UserBooking = BookingRow & {
  roomCode: string;
  roomKind: string;
  buildingName: string;
  buildingSlug: string;
  buildingCode: string;
};

/** Someone's own bookings: what's under way, what's ahead, then what's been. */
export function bookingsForUser(userId: number): {
  now: UserBooking[];
  upcoming: UserBooking[];
  past: UserBooking[];
} {
  const rows = db
    .select({
      id: bookings.id,
      roomId: bookings.roomId,
      userId: bookings.userId,
      date: bookings.date,
      startSlot: bookings.startSlot,
      endSlot: bookings.endSlot,
      purpose: bookings.purpose,
      createdAt: bookings.createdAt,
      cancelledAt: bookings.cancelledAt,
      bookedBy: users.displayName,
      bookedByUniId: users.uniId,
      roomCode: rooms.code,
      roomKind: rooms.kind,
      buildingName: buildings.name,
      buildingSlug: buildings.slug,
      buildingCode: buildings.code,
    })
    .from(bookings)
    .innerJoin(users, eq(users.id, bookings.userId))
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
    .where(and(eq(bookings.userId, userId), isNull(bookings.cancelledAt)))
    .orderBy(asc(bookings.date), asc(bookings.startSlot))
    .all();

  const at = new Date();
  const phase = (b: UserBooking) => bookingPhase(b.date, b.startSlot, b.endSlot, at);
  return {
    now: rows.filter((b) => phase(b) === "now"),
    upcoming: rows.filter((b) => phase(b) === "upcoming"),
    past: rows.filter((b) => phase(b) === "past").reverse(),
  };
}

/** Slot-by-slot occupancy for one room on one date: the booking holding each
 *  slot, or undefined. */
export function occupancy(roomId: number, date: string): Array<BookingRow | undefined> {
  const slots: Array<BookingRow | undefined> = new Array(SLOTS).fill(undefined);
  for (const booking of bookingsOn([roomId], date)) {
    for (let s = booking.startSlot; s < booking.endSlot && s < SLOTS; s++) slots[s] = booking;
  }
  return slots;
}

/** How full each room is on a date, as booked slots out of the day. Feeds
 *  the colour of a room on the floorplan and of a building on the map. */
export function loadByRoom(roomIds: number[], date: string): Map<number, number> {
  const load = new Map<number, number>();
  for (const id of roomIds) load.set(id, 0);
  for (const booking of bookingsOn(roomIds, date)) {
    load.set(booking.roomId, (load.get(booking.roomId) ?? 0) + (booking.endSlot - booking.startSlot));
  }
  return load;
}

/** How free each level of a building is on a date: its rooms, and its free
 *  half hours out of every half hour those rooms have. Feeds the building
 *  stage of the map (the fanned storeys and the level list) and the level
 *  switcher on the floor stage. */
export function levelsOf(
  building: Building,
  date: string,
): Array<{ level: number; rooms: number; desks: number; free: number; capacity: number }> {
  const all = roomsInBuilding(building.id);
  const live = bookingsOn(
    all.map((room) => room.id),
    date,
  );
  return Array.from({ length: building.levels }, (_, level) => {
    const here = all.filter((room) => room.floor === level);
    const ids = new Set(here.map((room) => room.id));
    const desks = here.filter((room) => isDesk(room.kind)).length;
    const capacity = ids.size * SLOTS;
    const used = live
      .filter((booking) => ids.has(booking.roomId))
      .reduce((total, booking) => total + (booking.endSlot - booking.startSlot), 0);
    return { level, rooms: ids.size - desks, desks, free: capacity - used, capacity };
  });
}

/** Everything the campus map needs for one date, in two queries: how many
 *  rooms each building has that match the filter, how much of their day is
 *  still free, and when the next free half hour starts.
 *
 *  Filtering here rather than in the page keeps the map, the building list
 *  and the 3D scene showing the same campus. */
export type BuildingOverview = {
  building: Building;
  /** places matching the filter, and how many of those are desks */
  matching: number;
  desks: number;
  free: number;
  total: number;
  /** first slot with a matching room free, or undefined if there's none left */
  nextFree?: number;
  yours: number;
};

export function campusOverview(
  date: string,
  filter: { minCapacity?: number; feature?: string } = {},
  userId?: number,
): BuildingOverview[] {
  const all = db.select().from(rooms).where(eq(rooms.listed, true)).all();
  const matches = all.filter(
    (room) =>
      (!filter.minCapacity || room.capacity >= filter.minCapacity) &&
      (!filter.feature || (JSON.parse(room.features) as string[]).includes(filter.feature)),
  );

  const byBuilding = new Map<number, Room[]>();
  for (const room of matches) {
    byBuilding.set(room.buildingId, [...(byBuilding.get(room.buildingId) ?? []), room]);
  }

  const live = bookingsOn(
    matches.map((room) => room.id),
    date,
  );
  const heldBy = new Map<number, BookingRow[]>();
  for (const booking of live) {
    heldBy.set(booking.roomId, [...(heldBy.get(booking.roomId) ?? []), booking]);
  }

  return listBuildings().map((building) => {
    const mine = byBuilding.get(building.id) ?? [];
    const total = mine.length * SLOTS;
    let used = 0;
    let yours = 0;
    const freeAt = new Array<boolean>(SLOTS).fill(false);

    for (const room of mine) {
      const held = heldBy.get(room.id) ?? [];
      const taken = new Array<boolean>(SLOTS).fill(false);
      for (const booking of held) {
        if (userId !== undefined && booking.userId === userId) yours++;
        for (let s = booking.startSlot; s < booking.endSlot && s < SLOTS; s++) taken[s] = true;
      }
      for (let s = 0; s < SLOTS; s++) {
        if (taken[s]) used++;
        else freeAt[s] = true;
      }
    }

    const from = date === today() ? Math.max(0, currentSlot()) : 0;
    const nextFree = freeAt.findIndex((free, slot) => free && slot >= from);

    return {
      building,
      matching: mine.length,
      desks: mine.filter((room) => isDesk(room.kind)).length,
      free: total - used,
      total,
      nextFree: nextFree === -1 ? undefined : nextFree,
      yours,
    };
  });
}

// --- the write -----------------------------------------------------------

export type CreateResult = { ok: true; booking: Booking } | { ok: false; error: BookingError };

export function createBooking(input: {
  userId: number | undefined;
  roomId: number;
  date: string;
  startSlot: number;
  endSlot: number;
  purpose: string;
}): CreateResult {
  const { userId, roomId, date, startSlot, endSlot } = input;
  if (!userId) return { ok: false, error: "signed-out" };

  // an unlisted place is off the map, so it can't be booked either
  const room = roomById(roomId);
  if (!room?.listed) return { ok: false, error: "no-room" };
  if (!isBookableDate(date)) return { ok: false, error: "bad-date" };

  if (
    !Number.isInteger(startSlot) ||
    !Number.isInteger(endSlot) ||
    startSlot < 0 ||
    endSlot > SLOTS ||
    endSlot <= startSlot
  ) {
    return { ok: false, error: "bad-range" };
  }
  if (endSlot - startSlot > MAX_SLOTS_PER_BOOKING) return { ok: false, error: "too-long" };
  if (daysBetween(today(), date) === 0 && endSlot <= currentSlot()) {
    return { ok: false, error: "past" };
  }

  const purpose = input.purpose.trim().slice(0, 120) || "Booked";

  // The clash check and the insert have to be one atomic step, or two people
  // clicking the same slot at the same moment both see it free and both get
  // it. SQLite gives us exactly one writer, so a transaction is all it takes.
  const write = sqlite.transaction((): CreateResult => {
    const clash = db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.roomId, roomId),
          eq(bookings.date, date),
          isNull(bookings.cancelledAt),
          sql`${bookings.startSlot} < ${endSlot}`,
          sql`${bookings.endSlot} > ${startSlot}`,
        ),
      )
      .get();
    if (clash) return { ok: false, error: "clash" };

    const booking = db
      .insert(bookings)
      .values({ roomId, userId, date, startSlot, endSlot, purpose })
      .returning()
      .get();
    return { ok: true, booking };
  });

  const result = write();
  if (result.ok) {
    publish({
      type: "booked",
      roomId,
      roomCode: room.code,
      buildingSlug: room.buildingSlug,
      buildingCode: room.buildingCode,
      date,
      startSlot,
      endSlot,
    });
  }
  return result;
}

export type CancelResult = { ok: true } | { ok: false; error: "signed-out" | "not-yours" };

/** Cancelling marks the row rather than deleting it, so a room's history
 *  survives and the machine that held it stays answerable. */
export function cancelBooking(bookingId: number, userId: number | undefined): CancelResult {
  if (!userId) return { ok: false, error: "signed-out" };

  const booking = db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking || booking.userId !== userId || booking.cancelledAt) {
    return { ok: false, error: "not-yours" };
  }

  db.update(bookings)
    .set({ cancelledAt: new Date().toISOString() })
    .where(eq(bookings.id, bookingId))
    .run();

  const room = roomById(booking.roomId);
  if (room) {
    publish({
      type: "cancelled",
      roomId: room.id,
      roomCode: room.code,
      buildingSlug: room.buildingSlug,
      buildingCode: room.buildingCode,
      date: booking.date,
      startSlot: booking.startSlot,
      endSlot: booking.endSlot,
    });
  }
  return { ok: true };
}

/** Rooms in a building, as the JSON the map and the spec suite read. */
export function roomsJson(buildingSlug: string) {
  const building = buildingBySlug(buildingSlug);
  if (!building) return undefined;
  return roomsInBuilding(building.id).map((room) => ({
    id: room.id,
    code: room.code,
    slug: roomSlug(room.code),
    building: building.slug,
    floor: room.floor,
    kind: room.kind,
    capacity: room.capacity,
    features: JSON.parse(room.features) as string[],
  }));
}
