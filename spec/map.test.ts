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

    const here = rooms.filter((room) => room.floor === floor);
    expect(here.length).toBeGreaterThan(0);
    const links = hrefs(doc);
    for (const room of here) {
      expect(links, room.code).toContain(`/b/${building.slug}/${room.slug}/?date=${date}`);
    }
    // and nothing from another level is offered as if it were on this one
    for (const room of rooms.filter((r) => r.floor !== floor)) {
      expect(links, room.code).not.toContain(`/b/${building.slug}/${room.slug}/?date=${date}`);
    }
    // the way back up is there too
    expect(links).toContain(`/b/${building.slug}/?date=${date}`);
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
      const signIn = [...(dialog?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])].find(
        (a) => new URL(a.href).pathname === "/login/",
      );
      expect(signIn, "no sign-in link in the dialog").toBeTruthy();
      const next = new URL(signIn?.href ?? baseUrl).searchParams.get("next") ?? "";
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
