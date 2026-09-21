import type { APIRoute } from "astro";
import { currentUser } from "../../../lib/auth";
import { createBooking, roomById } from "../../../lib/booking";
import { roomUrl, withQuery } from "../../../lib/links";

// Make a booking. Succeeds or fails, then 303s back to the room it was
// about with either a confirmation or a reason — which is what makes the
// form work without any client-side JavaScript.

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const user = currentUser(cookies);

  const roomId = Number(form.get("roomId"));
  const date = String(form.get("date") ?? "");
  const startSlot = Number(form.get("startSlot"));
  const endSlot = Number(form.get("endSlot"));

  const room = Number.isFinite(roomId) ? roomById(roomId) : undefined;
  const back = (params: Record<string, string | number>) =>
    room
      ? roomUrl(room.buildingSlug, room.code, { date, ...params })
      : withQuery("/", { date, ...params });

  const result = createBooking({
    userId: user?.id,
    roomId,
    date,
    startSlot,
    endSlot,
    purpose: String(form.get("purpose") ?? ""),
  });

  return redirect(
    result.ok ? back({ booked: result.booking.id }) : back({ error: result.error }),
    303,
  );
};
