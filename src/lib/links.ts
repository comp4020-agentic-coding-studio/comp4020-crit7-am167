// URL shapes, in one place, so a page, an API route and a test can't
// disagree about where a room lives.

/** "MRTC 2.01" → "mrtc-2.01" */
export function roomSlug(code: string): string {
  return code.toLowerCase().replace(/\s+/g, "-");
}

export function buildingUrl(slug: string, params: Record<string, string | number> = {}): string {
  return withQuery(`/b/${slug}/`, params);
}

export function roomUrl(
  buildingSlug: string,
  code: string,
  params: Record<string, string | number> = {},
): string {
  return withQuery(`/b/${buildingSlug}/${roomSlug(code)}/`, params);
}

export function withQuery(path: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== undefined && value !== null) query.set(key, String(value));
  }
  const q = query.toString();
  return q ? `${path}?${q}` : path;
}

/** The date strip's arrows submit `day=` alongside the select's `date=`
 *  (buttons, not links, so a crawler doesn't walk every day of every page).
 *  Returns this page's own URL for that day, to redirect to, or null. */
export function dayRedirect(url: URL): string | null {
  const day = url.searchParams.get("day");
  if (day === null) return null;
  const params = new URLSearchParams(url.search);
  params.delete("day");
  params.set("date", day);
  return `${url.pathname}?${params.toString()}`;
}

/** Where to send someone after a form: back into this app, or `fallback`.
 *  A leading `/` isn't enough on its own — browsers read `//host` and
 *  `/\host` as another site, which would make every `next=` an open
 *  redirect. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
