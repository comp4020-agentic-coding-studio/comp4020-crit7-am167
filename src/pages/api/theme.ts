import type { APIRoute } from "astro";
import { isTheme, setThemeCookie } from "../../lib/theme";

// Pick light or dark. A plain form POST and a 303 back to the page it came
// from, so the switch works with JavaScript off; with it on, the masthead's
// script sets the same cookie itself and never gets here.

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const theme = form.get("theme");
  if (isTheme(theme)) setThemeCookie(cookies, theme);

  const next = String(form.get("next") ?? "/");
  // only ever bounce back into this app, never to a URL a visitor supplied
  return redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/", 303);
};
