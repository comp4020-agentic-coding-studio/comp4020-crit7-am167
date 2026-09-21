import type { APIRoute } from "astro";
import { setSessionCookie, signIn, signOut } from "../../lib/auth";
import { withQuery } from "../../lib/links";

// Sign in, or sign out. A plain form POST and a 303 back, so the whole flow
// works with JavaScript switched off.

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();

  if (form.get("action") === "sign-out") {
    signOut(cookies);
    return redirect("/", 303);
  }

  const next = String(form.get("next") ?? "/");
  const result = signIn(String(form.get("uniId") ?? ""), String(form.get("password") ?? ""));
  if (!result.ok) {
    return redirect(withQuery("/login/", { error: result.error, next }), 303);
  }

  setSessionCookie(cookies, result.token);
  // only ever bounce back into this app, never to a URL a visitor supplied
  return redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/", 303);
};
