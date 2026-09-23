import { sql } from "drizzle-orm";
import { index, int, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// The schema is the ground truth for the database. To change it: edit here,
// run `pnpm db:generate` to turn the diff into a migration under drizzle/,
// and commit both — the migration applies automatically when the server
// boots (see src/lib/db.ts), locally and deployed. Never edit the database
// by hand: state on the deployed volume outlives every deploy, and the
// migration trail is what keeps old state and new code compatible.

/** A campus building. Geometry is real (OpenStreetMap, baked into
 *  src/data/campus.ts); it lives in the database too so a page can render
 *  the map from one query rather than joining code to data at request time. */
export const buildings = sqliteTable(
  "buildings",
  {
    id: int().primaryKey({ autoIncrement: true }),
    code: text().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    levels: int().notNull(),
    /** every footprint ring, as JSON [[x,z],…][] in the local metre grid */
    rings: text().notNull(),
    /** the ring floors are laid out inside */
    plan: text().notNull(),
    centreX: real("centre_x").notNull(),
    centreZ: real("centre_z").notNull(),
    radius: real().notNull(),
  },
  (t) => [uniqueIndex("buildings_code").on(t.code), uniqueIndex("buildings_slug").on(t.slug)],
);

/** A bookable place: a room, or one desk in an open study area. Its
 *  rectangle is in the same metre grid as the building, rotated to the
 *  building's long axis — the 3D scene and the flat SVG floorplan both draw
 *  from these numbers. */
export const rooms = sqliteTable(
  "rooms",
  {
    id: int().primaryKey({ autoIncrement: true }),
    buildingId: int("building_id")
      .notNull()
      .references(() => buildings.id),
    code: text().notNull(),
    floor: int().notNull(),
    kind: text().notNull(),
    capacity: int().notNull(),
    /** JSON string[] — whiteboard, projector, videoconf, quiet, accessible */
    features: text().notNull(),
    cx: real().notNull(),
    cz: real().notNull(),
    w: real().notNull(),
    d: real().notNull(),
    angle: real().notNull(),
    /** Offered on the map and bookable. False for a room an older layout
     *  planned, kept only because bookings point at it, and for a new place
     *  still waiting for an old room with bookings to come to clear out of
     *  its way. See reconcileRooms in src/lib/seed.ts. */
    listed: int({ mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("rooms_code").on(t.code), index("rooms_building_floor").on(t.buildingId, t.floor)],
);

/** A person. The login is deliberately a pretend one — any well-formed uni
 *  ID registers itself on first sign-in — but the password is still stored
 *  as a real scrypt hash, because storing it any other way teaches the wrong
 *  lesson even in a prototype. See src/lib/auth.ts. */
export const users = sqliteTable(
  "users",
  {
    id: int().primaryKey({ autoIncrement: true }),
    uniId: text("uni_id").notNull(),
    displayName: text("display_name").notNull(),
    /** scrypt: salt:derivedKey, both hex */
    passwordHash: text("password_hash").notNull(),
    role: text().notNull().default("student"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("users_uni_id").on(t.uniId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** a 32-byte random token, hex */
    token: text().primaryKey(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/** A booking of one room for a run of half-hour slots on one day.
 *
 *  Slots are integers so overlap is plain arithmetic: 0 is 08:00–08:30 and
 *  23 is 19:30–20:00 (see src/lib/booking.ts). `endSlot` is exclusive.
 *  Cancelling sets `cancelledAt` rather than deleting, so the room's history
 *  survives and "who cancelled the room I wanted" stays answerable. */
export const bookings = sqliteTable(
  "bookings",
  {
    id: int().primaryKey({ autoIncrement: true }),
    roomId: int("room_id")
      .notNull()
      .references(() => rooms.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    /** YYYY-MM-DD, campus local time */
    date: text().notNull(),
    startSlot: int("start_slot").notNull(),
    endSlot: int("end_slot").notNull(),
    purpose: text().notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    cancelledAt: text("cancelled_at"),
  },
  (t) => [index("bookings_room_date").on(t.roomId, t.date), index("bookings_user").on(t.userId)],
);

export type Building = typeof buildings.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
