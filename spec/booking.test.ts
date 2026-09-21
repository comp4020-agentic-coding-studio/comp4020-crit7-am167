import { beforeAll, describe, expect, inject, it } from "vitest";
import { DEMO_PASSWORD, DEMO_USERS } from "../src/lib/seed";
import { MAX_DAYS_AHEAD, MAX_SLOTS_PER_BOOKING, SLOTS, addDays, today } from "../src/lib/slots";

// The week's spec, as contracts, driven over HTTP against the built server:
//
//   "the core flow persists across a reload — create something, and it's
//    still there"
//
// plus the rules that make a booking system a booking system rather than a
// list of wishes: a room can't be double-booked, a cancelled room frees up,
// and you can't book yesterday. These test what the app must DO, not how
// it's built, so they survive a change of approach.
const baseUrl = inject("baseUrl");

// Astro checks form POSTs carry a same-origin Origin header (CSRF
// protection); browsers send it automatically, a bare fetch doesn't.
function post(path: string, body: Record<string, string>, cookie?: string) {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

function get(path: string, cookie?: string) {
  return fetch(new URL(path, baseUrl), {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

/** The session cookie from a Set-Cookie header, ready to send back. */
function sessionCookie(res: Response): string | undefined {
  const match = res.headers.get("set-cookie")?.match(/(?:^|,\s*)(session=[^;]+)/);
  return match?.[1];
}

async function signIn(uniId: string, password = DEMO_PASSWORD): Promise<string> {
  const res = await post("/api/session", { uniId, password });
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`sign-in failed for ${uniId}: ${res.status}`);
  return cookie;
}

const date = addDays(today(), 3);

// The room these tests work in, and which of its half hours are open. Both
// come from the app rather than from a hard-coded seeded room code: the
// campus is seeded with plausible traffic, so a fixed slot would be a coin
// toss, and a fixed room code would break the day the floorplan generator
// changes.
let roomId: string;
let roomSlug: string;
let buildingSlug: string;
let free: number[] = [];

/** The start of `count` consecutive free slots, and claim them so a later
 *  test doesn't pick the same ones. Throws rather than silently testing
 *  nothing: a suite with no room to work in isn't passing, it's blind. */
function claim(count: number): number {
  for (const start of free) {
    if (start + count > SLOTS) continue;
    let ok = true;
    for (let i = 1; i < count; i++) if (!free.includes(start + i)) ok = false;
    if (!ok) continue;
    free = free.filter((slot) => slot < start || slot >= start + count);
    return start;
  }
  throw new Error(`no ${count} consecutive free slots left in ${roomSlug} on ${date}`);
}

/** A free slot to aim a validation test at, without claiming it. */
function anyFree(): number {
  const slot = free[0];
  if (slot === undefined) throw new Error("no free slots left");
  return slot;
}

describe("booking", () => {
  let alex: string;
  let priya: string;

  beforeAll(async () => {
    alex = await signIn(DEMO_USERS[0].uniId);
    priya = await signIn(DEMO_USERS[1].uniId);

    const res = await get(`/api/rooms?building=marie-reay&date=${date}`);
    expect(res.status).toBe(200);
    const rooms = (await res.json()) as Array<{
      id: number;
      slug: string;
      building: string;
      free: number[];
    }>;
    expect(rooms.length).toBeGreaterThan(0);

    const room = [...rooms].sort((a, b) => b.free.length - a.free.length)[0];
    expect(room.free.length, "the whole building is booked solid").toBeGreaterThan(14);
    roomId = String(room.id);
    roomSlug = room.slug;
    buildingSlug = room.building;
    free = room.free;
  });

  describe("signing in", () => {
    it("issues a session for a known person and the right password", async () => {
      const res = await post("/api/session", {
        uniId: DEMO_USERS[2].uniId,
        password: DEMO_PASSWORD,
      });
      expect(res.status).toBe(303);
      expect(sessionCookie(res)).toBeTruthy();
    });

    it("refuses a known person with the wrong password", async () => {
      const res = await post("/api/session", {
        uniId: DEMO_USERS[2].uniId,
        password: "not-the-password",
      });
      expect(sessionCookie(res)).toBeFalsy();
    });

    it("refuses an id that isn't shaped like a uni ID", async () => {
      const res = await post("/api/session", { uniId: "nope", password: "whatever" });
      expect(sessionCookie(res)).toBeFalsy();
    });

    it("registers a uni ID nobody has used before", async () => {
      const fresh = `u9${String(Date.now()).slice(-6)}`;
      const res = await post("/api/session", { uniId: fresh, password: "a-new-password" });
      expect(sessionCookie(res), "a new uni ID should sign itself up").toBeTruthy();

      const wrong = await post("/api/session", { uniId: fresh, password: "guessing" });
      expect(sessionCookie(wrong), "and then keep that password").toBeFalsy();
    });

    it("shows who you are once you're signed in", async () => {
      const page = await get("/bookings/", alex);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(DEMO_USERS[0].displayName);
    });

    it("still serves the signed-out pages, rather than redirecting away", async () => {
      // the invariants fetch every route signed-out and require a 200
      for (const route of ["/bookings/", "/login/", "/", `/b/${buildingSlug}/`]) {
        expect((await get(route)).status, route).toBe(200);
      }
    });
  });

  describe("making a booking", () => {
    /** the slots the persistence test claimed, which the clash test reuses */
    let mine = 0;

    it("persists across a reload", async () => {
      const purpose = `spec probe ${process.hrtime.bigint()}`;
      mine = claim(2);

      const res = await post(
        "/api/bookings",
        { roomId, date, startSlot: String(mine), endSlot: String(mine + 2), purpose },
        alex,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).not.toMatch(/error=/);

      // a completely fresh request, the way a reload is
      const page = await get(`/b/${buildingSlug}/${roomSlug}/?date=${date}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(purpose);

      // and it's on the booker's own list
      const list = await get("/bookings/", alex);
      expect(await list.text()).toContain(purpose);
    });

    it("refuses to double-book a room somebody else already has", async () => {
      // deliberately overlapping the booking the previous test made
      const res = await post(
        "/api/bookings",
        {
          roomId,
          date,
          startSlot: String(mine + 1),
          endSlot: String(mine + 2),
          purpose: "should not land",
        },
        priya,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toMatch(/error=clash/);

      const page = await get(`/b/${buildingSlug}/${roomSlug}/?date=${date}`);
      expect(await page.text()).not.toContain("should not land");
    });

    it("refuses a booking that ends before it starts", async () => {
      const slot = anyFree();
      const res = await post(
        "/api/bookings",
        { roomId, date, startSlot: String(slot), endSlot: String(slot), purpose: "zero length" },
        alex,
      );
      expect(res.headers.get("location")).toMatch(/error=/);
    });

    it("refuses a booking longer than the limit", async () => {
      const res = await post(
        "/api/bookings",
        {
          roomId,
          date,
          startSlot: "0",
          endSlot: String(MAX_SLOTS_PER_BOOKING + 1),
          purpose: "all day",
        },
        alex,
      );
      expect(res.headers.get("location")).toMatch(/error=too-long/);
    });

    it("refuses a booking that runs past closing time", async () => {
      const res = await post(
        "/api/bookings",
        { roomId, date, startSlot: String(SLOTS - 1), endSlot: String(SLOTS + 1), purpose: "late" },
        alex,
      );
      expect(res.headers.get("location")).toMatch(/error=/);
    });

    it("refuses a date in the past and one too far ahead", async () => {
      for (const bad of [addDays(today(), -1), addDays(today(), MAX_DAYS_AHEAD + 1)]) {
        const res = await post(
          "/api/bookings",
          { roomId, date: bad, startSlot: "2", endSlot: "4", purpose: "time travel" },
          alex,
        );
        expect(res.headers.get("location"), bad).toMatch(/error=bad-date/);
      }
    });

    it("refuses anyone who isn't signed in", async () => {
      const slot = anyFree();
      const res = await post("/api/bookings", {
        roomId,
        date,
        startSlot: String(slot),
        endSlot: String(slot + 1),
        purpose: "anonymous",
      });
      expect(res.status).toBe(303);
      const page = await get(`/b/${buildingSlug}/${roomSlug}/?date=${date}`);
      expect(await page.text()).not.toContain("anonymous");
    });
  });

  describe("cancelling", () => {
    it("frees the slot for somebody else", async () => {
      const purpose = `to cancel ${process.hrtime.bigint()}`;
      const at = claim(2);
      const made = await post(
        "/api/bookings",
        { roomId, date, startSlot: String(at), endSlot: String(at + 2), purpose },
        alex,
      );
      expect(made.headers.get("location")).not.toMatch(/error=/);

      const list = await get("/bookings/", alex);
      const bookingId = findCancelId(await list.text(), purpose);
      expect(bookingId, "no cancel control for the booking just made").toBeTruthy();

      const res = await post("/api/bookings/cancel", { bookingId: String(bookingId) }, alex);
      expect(res.status).toBe(303);

      const after = await get(`/b/${buildingSlug}/${roomSlug}/?date=${date}`);
      expect(await after.text()).not.toContain(purpose);

      // and now somebody else can have it
      const retry = await post(
        "/api/bookings",
        {
          roomId,
          date,
          startSlot: String(at),
          endSlot: String(at + 2),
          purpose: `re-booked ${purpose}`,
        },
        priya,
      );
      expect(retry.headers.get("location")).not.toMatch(/error=/);
    });

    it("won't let you cancel someone else's booking", async () => {
      const purpose = `alex keeps this ${process.hrtime.bigint()}`;
      const at = claim(1);
      await post(
        "/api/bookings",
        { roomId, date, startSlot: String(at), endSlot: String(at + 1), purpose },
        alex,
      );

      const list = await get("/bookings/", alex);
      const bookingId = findCancelId(await list.text(), purpose);
      expect(bookingId).toBeTruthy();

      await post("/api/bookings/cancel", { bookingId: String(bookingId) }, priya);

      const page = await get(`/b/${buildingSlug}/${roomSlug}/?date=${date}`);
      expect(await page.text()).toContain(purpose);
    });
  });

  describe("live updates", () => {
    it(
      "tells other clients about a new booking over the event stream",
      { timeout: 20_000 },
      async () => {
        const controller = new AbortController();
        const stream = await fetch(new URL("/api/events", baseUrl), { signal: controller.signal });
        const reader = stream.body?.getReader();
        expect(reader).toBeTruthy();
        if (!reader) return;

        const heard = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes(`"roomId":${roomId}`) && buffer.includes('"booked"')) return true;
          }
          return false;
        })();

        // let the stream open before the write it's meant to hear about
        await new Promise((resolve) => setTimeout(resolve, 250));
        const at = claim(1);
        const made = await post(
          "/api/bookings",
          {
            roomId,
            date,
            startSlot: String(at),
            endSlot: String(at + 1),
            purpose: `sse probe ${process.hrtime.bigint()}`,
          },
          alex,
        );
        expect(made.headers.get("location")).not.toMatch(/error=/);

        expect(await heard).toBe(true);
        controller.abort();
      },
    );
  });
});

/** The booking id on the cancel form sitting next to a given purpose. */
function findCancelId(html: string, purpose: string): string | undefined {
  const at = html.indexOf(purpose);
  if (at < 0) return undefined;
  // the cancel control follows the label within the same list row
  const window = html.slice(at, at + 1500);
  return window.match(/name="bookingId"\s+value="(\d+)"/)?.[1];
}
