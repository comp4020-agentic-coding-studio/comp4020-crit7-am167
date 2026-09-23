import type { APIRoute } from "astro";
import { currentUser } from "../../../lib/auth";
import { cancelBooking } from "../../../lib/booking";
import { safeNext, withQuery } from "../../../lib/links";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const user = currentUser(cookies);
  const bookingId = Number(form.get("bookingId"));

  const result = cancelBooking(bookingId, user?.id);
  const target = safeNext(String(form.get("next") ?? ""), "/bookings/");
  return redirect(result.ok ? target : withQuery(target, { error: result.error }), 303);
};
