import { EventEmitter } from "node:events";

// One process, one bus: every open SSE connection subscribes here, and a
// booking is broadcast to all of them. This only works because the app runs
// on exactly one machine (see fly.toml) — a second machine would have its
// own bus and clients would miss events.

/** What every open tab hears when a room changes hands. Deliberately small:
 *  enough for a client to re-tint a building on the map, flip a slot on the
 *  grid, or decide the event is about a date it isn't showing. */
export type BookingEvent = {
  type: "booked" | "cancelled";
  roomId: number;
  roomCode: string;
  buildingSlug: string;
  buildingCode: string;
  date: string;
  startSlot: number;
  endSlot: number;
};

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(event: BookingEvent): void {
  bus.emit("booking", event);
}
