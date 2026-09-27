import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { BUILDINGS } from "../src/data/campus";
import { DEMO_PASSWORD, DEMO_USERS } from "../src/lib/seed";
import { addDays, today } from "../src/lib/slots";

// The map is the whole app: you drill down inside it — campus, a building's
// levels, one level's rooms, then a room's day as a dialog in front of the
// map — rather than scrolling past it to a second copy of the page.
//
// Every stage is still a real URL that renders complete without JavaScript,
// so these drive the built server over HTTP and check what each stage has to
// offer: the links that take you one step further in, the way back out, and
// which stage the map is being asked to show.
const baseUrl = inject("baseUrl");

const date = addDays(today(), 2);
const building = BUILDINGS.find((b) => b.slug === "marie-reay");
if (!building) throw new Error("marie-reay is no longer in src/data/campus.ts");

async function page(path: string, cookie?: string): Promise<Document> {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  expect(res.status, path).toBe(200);
  return new JSDOM(await res.text(), { url: new URL(path, baseUrl).href }).window.document;
}

/** Every link on the page, as path + query, resolved against the page.
 *  Read off the attribute, because an SVG <a> (the floor plan's rooms) has
 *  no string `href` property to read. */
function hrefs(doc: Document, within: ParentNode = doc): string[] {
  return [...within.querySelectorAll("a[href]")].map((a) => {
    const url = new URL(a.getAttribute("href") ?? "", doc.URL);
    return url.pathname + url.search;
  });
}

function stageOf(doc: Document): string | null {
  return doc.querySelector("[data-stage]")?.getAttribute("data-stage") ?? null;
}

type ApiRoom = { id: number; slug: string; floor: number; code: string };

describe("drilling down inside the map", () => {
  let rooms: ApiRoom[] = [];

  beforeAll(async () => {
    const res = await fetch(new URL(`/api/rooms?building=${building.slug}`, baseUrl));
    rooms = (await res.json()) as ApiRoom[];
    expect(rooms.length).toBeGreaterThan(0);
  });

  it("starts on the whole campus, with every building one click in", async () => {
    const doc = await page(`/?date=${date}`);
    expect(stageOf(doc)).toBe("campus");
    expect(doc.querySelector("[data-scene]"), "the campus page has no map").toBeTruthy();
    for (const b of BUILDINGS) {
      expect(hrefs(doc), b.slug).toContain(`/b/${b.slug}/?date=${date}`);
    }
  });

  it("opens a building on its levels, each one a step further in", async () => {
    const doc = await page(`/b/${building.slug}/?date=${date}`);
    expect(stageOf(doc)).toBe("building");
    expect(doc.querySelector("[data-scene]")).toBeTruthy();
    for (let level = 0; level < building.levels; level++) {
      expect(hrefs(doc), `level ${level}`).toContain(
        `/b/${building.slug}/?date=${date}&floor=${level}`,
      );
    }
  });

  it("drops into one level's rooms, each of which opens", async () => {
    const floor = 1;
    const doc = await page(`/b/${building.slug}/?date=${date}&floor=${floor}`);
    expect(stageOf(doc)).toBe("floor");
    expect(doc.querySelector("[data-scene]")).toBeTruthy();

    // Each place is a button in a GET form, not a link: a link per room and
    // desk is thousands of pages to a crawler. The form carries the date.
    const form = doc.querySelector<HTMLFormElement>('form[method="get"][data-places]');
    expect(form, "no form of places").toBeTruthy();
    expect(form?.getAttribute("action")).toBe(`/b/${building.slug}/`);
    expect(form?.querySelector<HTMLInputElement>('input[name="date"]')?.value).toBe(date);
    const offered = [...(form?.querySelectorAll<HTMLButtonElement>('button[name="room"]') ?? [])]
      .map((b) => b.value);

    const here = rooms.filter((room) => room.floor === floor);
    expect(here.length).toBeGreaterThan(0);
    for (const room of here) expect(offered, room.code).toContain(room.slug);
    // and nothing from another level is offered as if it were on this one
    for (const room of rooms.filter((r) => r.floor !== floor)) {
      expect(offered, room.code).not.toContain(room.slug);
    }
    const links = hrefs(doc);
    expect(links.filter((l) => l.startsWith(`/b/${building.slug}/`) && l.split("/").length > 4))
      .toEqual([]);
    // the way back up is there too
    expect(links).toContain(`/b/${building.slug}/?date=${date}`);

    // picking one lands on that room's own URL, on the same day
    const room = here[0];
    const res = await fetch(
      new URL(`/b/${building.slug}/?date=${date}&room=${room.slug}`, baseUrl),
      { redirect: "manual" },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/b/${building.slug}/${room.slug}/?date=${date}`);
  });

  it("treats a level that doesn't exist as the building, not as a guess", async () => {
    const doc = await page(`/b/${building.slug}/?date=${date}&floor=99`);
    expect(stageOf(doc)).toBe("building");
  });

  describe("a room", () => {
    let room: ApiRoom;
    let doc: Document;
    let dialog: HTMLDialogElement | null;

    beforeAll(async () => {
      room = rooms.find((r) => r.floor === 0) ?? rooms[0];
      doc = await page(`/b/${building.slug}/${room.slug}/?date=${date}`);
      dialog = doc.querySelector("dialog[open]");
    });

    it("opens as a dialog in front of the map, not instead of it", () => {
      expect(stageOf(doc)).toBe("room");
      expect(dialog, "no open dialog on the room page").toBeTruthy();
      const scene = doc.querySelector("[data-scene]");
      expect(scene, "the map is gone behind the room").toBeTruthy();
      expect(dialog?.contains(scene ?? null)).toBe(false);
    });

    it("names the room as the page's heading, inside the dialog", () => {
      const h1 = doc.querySelector("h1");
      expect(h1?.textContent).toContain(room.code);
      expect(dialog?.contains(h1)).toBe(true);
    });

    it("closes back to the level the room is on, on the same date", () => {
      expect(hrefs(doc, dialog ?? doc)).toContain(
        `/b/${building.slug}/?date=${date}&floor=${room.floor}`,
      );
    });

    it("asks a visitor to sign in from inside the dialog", () => {
      // A GET form, not a link, so a crawler doesn't fetch a sign-in page
      // per page; submitting it lands on the same /login/?next= URL.
      const signIn = dialog?.querySelector<HTMLFormElement>('form[method="get"][action="/login/"]');
      expect(signIn, "no sign-in form in the dialog").toBeTruthy();
      const next = signIn?.querySelector<HTMLInputElement>('[name="next"]')?.value ?? "";
      expect(next).toContain(`/b/${building.slug}/${room.slug}/`);
    });

    it("lets someone signed in book it without leaving the dialog", async () => {
      const res = await fetch(new URL("/api/session", baseUrl), {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ uniId: DEMO_USERS[0].uniId, password: DEMO_PASSWORD }),
        redirect: "manual",
      });
      const cookie = res.headers.get("set-cookie")?.match(/(?:^|,\s*)(session=[^;]+)/)?.[1];
      expect(cookie).toBeTruthy();

      const signedIn = await page(`/b/${building.slug}/${room.slug}/?date=${date}`, cookie);
      const form = signedIn.querySelector<HTMLFormElement>(
        'dialog[open] form[action="/api/bookings"]',
      );
      expect(form, "no booking form in the dialog").toBeTruthy();
      expect(form?.querySelector<HTMLInputElement>('[name="roomId"]')?.value).toBe(
        String(room.id),
      );
    });
  });
});

// A link checker follows every <a href>, so each link the pages print is a
// page it must fetch. Links that step to another day (or carry the current
// page into a sign-in URL) multiply every page by every date, and CI's live
// link check runs out of time long before it gets through them. Those moves
// are form submissions instead; what's left as links has to stay small.
describe("what a link crawler sees", () => {
  it("reaches a few pages per building, at today's date, and no rooms", async () => {
    // the campus, each building's stages, and the app's own pages: no page
    // per room or desk
    const limit = 12 * BUILDINGS.length + 20;
    const seen = new Set(["/"]);
    const queue = ["/"];
    while (queue.length > 0 && seen.size <= limit) {
      const batch = queue.splice(0, 16);
      await Promise.all(
        batch.map(async (path) => {
          const res = await fetch(new URL(path, baseUrl));
          if (!(res.headers.get("content-type") ?? "").includes("html")) return;
          const doc = new JSDOM(await res.text(), { url: new URL(path, baseUrl).href }).window
            .document;
          for (const href of hrefs(doc)) {
            if (href.startsWith("/_astro/") || seen.has(href)) continue;
            seen.add(href);
            queue.push(href);
          }
        }),
      );
    }
    expect(seen.size, `the crawl passed ${limit} pages`).toBeLessThanOrEqual(limit);
    const dates = new Set([...seen].map((p) => new URL(p, baseUrl).searchParams.get("date")));
    dates.delete(null);
    expect([...dates], "links step to other days").toEqual([today()]);
    expect([...seen].filter((p) => p.startsWith("/login/?"))).toEqual([]);
    expect([...seen].filter((p) => new URL(p, baseUrl).searchParams.has("start"))).toEqual([]);
    expect([...seen].filter((p) => /^\/b\/[^/]+\/[^/?]+\//.test(p))).toEqual([]);
  });

  it("steps a day with the arrows, landing on that day's own URL", async () => {
    const doc = await page(`/b/${building.slug}/?date=${date}&floor=0`);
    const days = [...doc.querySelectorAll<HTMLButtonElement>('form.datestrip button[name="day"]')];
    expect(days.map((b) => b.value)).toEqual([addDays(date, -1), addDays(date, 1)]);

    const res = await fetch(
      new URL(`/b/${building.slug}/?floor=0&date=${date}&day=${addDays(date, 1)}`, baseUrl),
      { redirect: "manual" },
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location") ?? "", baseUrl);
    expect(to.pathname).toBe(`/b/${building.slug}/`);
    expect(to.searchParams.get("date")).toBe(addDays(date, 1));
    expect(to.searchParams.get("floor")).toBe("0");
    expect(to.searchParams.has("day")).toBe(false);
  });
});
