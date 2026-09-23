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
