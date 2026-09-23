import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";
import { ROUTES } from "./routes";

// Dark mode. The page follows the device's own light/dark setting until
// someone picks one, and then remembers the pick — in a cookie, so the
// server renders the chosen theme and nothing flashes the wrong colour on
// load. The switch is a plain form POST, so it works without JavaScript.
const baseUrl = inject("baseUrl");

async function page(path: string, cookie?: string): Promise<Document> {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  expect(res.status, path).toBe(200);
  return new JSDOM(await res.text()).window.document;
}

function choose(theme: string, next: string) {
  return fetch(new URL("/api/theme", baseUrl), {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ theme, next }),
    redirect: "manual",
  });
}

describe("dark mode", () => {
  it("follows the device until someone chooses", async () => {
    const doc = await page("/");
    expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
    const meta = doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content");
    expect(meta, "the page must say it can be drawn light or dark").toBe("light dark");
  });

  it.each(ROUTES)("offers a switch both ways on %s", async (route) => {
    const doc = await page(route);
    const form = doc.querySelector('header form[action="/api/theme"][method="post"]');
    expect(form, "no theme switch in the masthead").toBeTruthy();
    const values = [...(form?.querySelectorAll('button[name="theme"]') ?? [])].map((b) =>
      b.getAttribute("value"),
    );
    expect(values.sort()).toEqual(["dark", "light"]);
    for (const button of form?.querySelectorAll("button") ?? []) {
      expect(button.getAttribute("aria-label"), "an icon button needs a name").toMatch(/mode/i);
    }
  });

  it("renders the chosen theme from the cookie", async () => {
    for (const theme of ["dark", "light"]) {
      const doc = await page("/bookings/", `theme=${theme}`);
      expect(doc.documentElement.getAttribute("data-theme")).toBe(theme);
    }
    const junk = await page("/bookings/", "theme=purple");
    expect(junk.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("remembers a choice and goes back where it came from", async () => {
    const res = await choose("dark", "/b/marie-reay/?floor=0");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/b/marie-reay/?floor=0");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^theme=dark;/);
    expect(cookie).toMatch(/Max-Age=\d{7,}/i);
  });

  it("only ever sends you back into this app, and ignores a theme it doesn't have", async () => {
    const away = await choose("light", "https://example.com/");
    expect(away.headers.get("location")).toBe("/");
    const junk = await choose("purple", "/");
    expect(junk.status).toBe(303);
    expect(junk.headers.get("set-cookie")).toBeNull();
  });
});
