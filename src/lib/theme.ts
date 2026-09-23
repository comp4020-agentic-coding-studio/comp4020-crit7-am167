import type { AstroCookies } from "astro";

// Light or dark. Nobody has to choose: with no cookie the page follows the
// device's own setting (prefers-color-scheme, in src/styles.css). Choosing
// one pins it in a cookie, so the server renders `data-theme` on <html> and
// the first paint is already the right colour — a script-only switch would
// flash the device's theme on every page load before correcting itself.

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "theme";
/** a preference, not a session: a year */
export const THEME_MAX_AGE = 365 * 86_400;

export function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

/** The theme someone has chosen, or undefined to follow their device. */
export function chosenTheme(cookies: AstroCookies): Theme | undefined {
  const value = cookies.get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : undefined;
}

export function setThemeCookie(cookies: AstroCookies, theme: Theme): void {
  // not httpOnly: the switch's script writes the same cookie itself, so
  // flipping the theme doesn't have to reload the page (or the map)
  cookies.set(THEME_COOKIE, theme, {
    path: "/",
    sameSite: "lax",
    secure: import.meta.env.PROD,
    maxAge: THEME_MAX_AGE,
  });
}
