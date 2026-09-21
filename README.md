# Book — ANU Acton room booking

Find and book a room at ANU, starting from a map of the actual campus. Pick a
building out of a 3D Acton, drop into its floors, and take a half hour in a
room that's free. Sign in with any ANU-style uni ID; your bookings survive a
reload, a redeploy, and everyone else's.

This is a COMP4020 prototype, not an ANU service. Nothing in it books a real
room.

## Why room booking

Because the thing that makes finding a room hard isn't the booking form, it's
the question underneath it: **where is there a free room near me, right now?**
The systems I've used answer that with a dropdown of building names and a
results table, which means you already have to know that Marie Reay has small
rooms and Chifley doesn't, and you can't tell at a glance that the whole of
Hancock is heaving this afternoon.

So the map is the app. Every building carries its own colour — the same one on
the map, on its card, down the side of its grid rows and across its floor
plan — and how free it is on the date you're looking at shows as how saturated
that colour is, plus a filled bar and a number. One glance tells you where to
walk. Everything below the map is the same information as a list, because a map
is a terrible way to read a timetable and a good way to choose a place.

Splitting it that way is deliberate: **hue means which building, fill means how
free it is.** Nobody has to tell ten colours apart to answer "is there a room" —
that question is answered by a proportion and a percentage, which survive any
kind of colour vision.

## What's real and what isn't

Being straight about this matters more than the demo looking convincing.

**Real.** Every building footprint and storey count comes from
OpenStreetMap — Hancock, Chifley, Hanna Neumann, Marie Reay, Copland, Menzies,
Haydon-Allen, Birch, Peter Karmel, Engineering, plus ~240 more drawn dim for
context. `scripts/fetch-campus.ts` pulls them once and bakes them into
`src/data/campus.ts`, which is committed, so the build never touches the
network. Building heights are exaggerated about 2× — at the scale a whole
campus fits on a screen, true storey heights read as a car park.

**Invented.** Floor layouts, room numbers, capacities and features. ANU's real
floor plans aren't open data. `src/lib/floorplan.ts` takes each building's real
outline, runs a corridor down its long axis, cuts rooms either side on a grid
and discards anything that falls outside the real walls — so Marie Reay's floors
are Marie Reay-shaped and Birch's are Birch-shaped, but no room in here
corresponds to a real one. It's deterministic: the same building always plans
the same way.

**Invented.** Every booking, and everybody holding one. 280 fictional people
carry a fortnight of plausible traffic, reseeded rolling forward so the campus
is never empty whenever you open it.

**Pretend, and says so.** The sign-in. Any well-formed uni ID (`u1234567`)
works, and the first time one is used it keeps whatever password you type.
There's no directory behind it. What *isn't* pretend: passwords are scrypt-
hashed, session tokens are 32 random bytes, and the cookie is `httpOnly`. A
prototype can fake the policy; faking the mechanics teaches the wrong habit.

### Signing in at a glance

Everyone already on this campus uses the password **`anu-acton`**. The four the
sign-in page names:

| Uni ID     | Who            | Role       |
| ---------- | -------------- | ---------- |
| `u1000001` | Alex Nguyen    | student    |
| `u1000002` | Priya Shah     | student    |
| `u1000003` | Tom Whitlam    | tutor      |
| `u1000004` | Jess Okafor    | facilities |

Or type any uni ID you like and pick your own password.

## What good looks like here

**The 3D is never the only way.** The canvas is enhancement, built by script or
not at all. Every building and every room on it is also a real link in the
server-rendered page, every form works with JavaScript off (POST, then a 303
back), and the floor plan is an SVG with labelled links whether or not WebGL
ever loads. Turn the canvas off — no WebGL, `prefers-reduced-motion`, a slow
network — and you lose the spectacle, not the app.

**It has to work on a phone.** 390×844 is a full marking viewport for this
course, not a fallback. The camera framing is *solved* against the campus
geometry and the current aspect ratio rather than hand-tuned, so every bookable
building lands inside the frame on a wide desktop canvas and on a narrow phone
one. Labels are drawn in screen space so a building code is as legible at either
size.

**Colour never carries meaning alone.** Taken slots are hatched as well as
filled, a slot you hold is inked rather than tinted, and every cell says what
it is in text a screen reader reads out. Availability is a bar and a number
before it is a colour. The automated accessibility check runs without a browser
and can't see contrast at all, so this part is a judgement call I have to make
rather than a test I can pass.

**It renders on demand.** There's no unconditional animation loop. A frame is
drawn when something changes — a camera flight, a hover, a booking arriving over
the live stream — and then it stops. That's a battery decision on a phone and a
cost decision on a machine that's billed for being awake.

**Double-booking is impossible, not unlikely.** The clash check and the insert
happen inside one SQLite transaction (`src/lib/booking.ts`). Two people clicking
the same slot at the same instant can't both get it.

### What I chose not to build

- **An admin side.** No approvals, no room management, no opening-hours editor.
  The brief asks for a slice wired end to end, and "find a room and take it" is
  the slice that's actually annoying.
- **Recurring bookings**, which are most of the complexity of a real timetabling
  system and none of what makes finding a room hard.
- **Real authentication.** An SSO integration would be a week of work that
  proves nothing about the idea.
- **A search-first interface.** I considered leading with "6 people, Thursday
  2–4pm, whiteboard" and ranking results. The filters do a weaker version of
  that. The map won because seeing *where* is the part a list can't do.

### What's enforced, and what isn't

`spec/invariants.test.ts` and `spec/readme.test.ts` ship with the course
template: a nav landmark, one `<h1>`, a language, a title, a mobile viewport,
alt text, an axe-core accessibility floor on every route in `spec/routes.ts`,
and this file being served whole at `/readme/`.

Mine are `spec/campus.test.ts` and `spec/booking.test.ts`. The campus one holds
the floor-plan generator to its contract — every room inside its building's real
footprint, no two rooms overlapping, deterministic, room numbers that read like
room numbers. The booking one drives the running app over HTTP and asserts the
week's spec line directly: **a booking persists across a reload**, a room can't
be double-booked, cancelling frees the slot, you can't book yesterday or three
weeks out, you can't cancel someone else's booking, and a booking made in one
client reaches another over the event stream. They pick a room and a free slot
by asking the app, so seeded traffic can't make them flaky.

What no test here can tell me: whether the map is actually easier than a
dropdown. That's the crit's call.

## Running it

```sh
pnpm install
pnpm dev           # localhost:4321
pnpm check         # typecheck + the spec suite, against the built server
```

The database is one SQLite file — `.data/app.db` locally, a Fly volume in
production. Migrations and the campus seed both run at boot, so a fresh clone
and a fresh volume both come up as a working campus.

To refresh the geometry from OpenStreetMap, `node scripts/fetch-campus.ts`, then
commit what it writes to `src/data/campus.ts`.

## Credits

Building footprints © OpenStreetMap contributors, licensed
[ODbL](https://www.openstreetmap.org/copyright). 3D by
[three.js](https://threejs.org/).
