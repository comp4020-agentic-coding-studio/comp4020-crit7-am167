import type { APIRoute } from "astro";
import { bookingsOn, roomsJson } from "../../lib/booking";
import { SLOTS, isBookableDate } from "../../lib/slots";

// The rooms in a building, as JSON. Add `date` and each room also reports
// which half-hour slots are still free.
//
// Two readers: the 3D floor view, when it needs a floor the current page
// didn't render markup for, and the spec suite — which uses it to pick a
// room that's genuinely free rather than hard-coding a slot the seeded
// campus might already have taken.

export const GET: APIRoute = ({ url }) => {
  const slug = url.searchParams.get("building");
  if (!slug) return new Response("name a building", { status: 400 });

  const rooms = roomsJson(slug);
  if (!rooms) return new Response("no such building", { status: 404 });

  const date = url.searchParams.get("date");
  const withFree =
    date && isBookableDate(date)
      ? (() => {
          const live = bookingsOn(
            rooms.map((room) => room.id),
            date,
          );
          return rooms.map((room) => {
            const taken = new Array<boolean>(SLOTS).fill(false);
            for (const booking of live.filter((b) => b.roomId === room.id)) {
              for (let s = booking.startSlot; s < booking.endSlot && s < SLOTS; s++) taken[s] = true;
            }
            return {
              ...room,
              free: taken.flatMap((busy, slot) => (busy ? [] : [slot])),
            };
          });
        })()
      : rooms;

  return new Response(JSON.stringify(withFree), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
