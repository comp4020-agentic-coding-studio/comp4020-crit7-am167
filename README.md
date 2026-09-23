# ANU Room Booking

Find a free room at ANU Acton on a 3D map of the real campus, and book it
without leaving the map. Your booking is still there after a reload, a
redeploy, and everyone else's bookings.

This is a COMP4020 prototype, not an ANU service. Nothing in it books a real
room.

## Try it

1. **Sign in** as `u1000001` with the password `anu-acton`. Any uni ID shaped
   like `u1234567` works too: the first time one is used, it keeps whatever
   password you type.
2. **Pick a building.** Its storeys fan apart.
3. **Pick a level.** The camera swings overhead and the rooms show their
   numbers.
4. **Pick a room.** Its day opens in a dialog in front of the map. Choose a
   start and end time, and book.
5. **Reload**, or open **My bookings**. It's still there, and you can cancel it
   from either place.

The sign-in page lists three more demo people, `u1000002` to `u1000004`, on
the same password. Their roles (student, tutor, facilities) are labels only;
everyone books the same way.

A panel floats on the map, as a sidebar on a desktop and a sheet along the
bottom of a phone. It lists the same buildings, levels and rooms, and filters
the campus by seats and by what a room needs: a whiteboard, a projector, video
conferencing, quiet, or accessibility. Point at a row and the thing it names
lights up on the map. Rooms open 08:00 to 20:00 in half hours, and a booking
runs up to three hours, up to two weeks ahead.

## Why a map

The hard part of booking a room isn't the form. It's the question before it:
**where is there a free room near me, right now?** The systems I've used answer
that with a dropdown of building names and a table of results, so you already
have to know that Marie Reay has small rooms and Chifley doesn't, and nothing
shows you that Hancock is packed this afternoon.

So the map is the whole window, and you drill down inside it instead of
scrolling to a second copy of the page: campus, building, level, room. Each
step is a real URL, so the back button, a reload and a shared link all land
where you were.

Every building has its own colour, the same on the map, down the edge of its
rows and across its floor plan. Saturation, a filled bar and a percentage show
how free it is on the day you're looking at. **Hue says which building; fill
says how free**, so finding a room never depends on telling ten colours apart.

There's a dark mode. It follows your device until you pick one with the sun or
moon in the top bar, and then remembers. At night each building keeps its
colour, lifted so it still stands out on a dark map.

## What's real and what isn't

- **Real: the campus.** Every building footprint and storey count comes from
  OpenStreetMap: the ten bookable buildings (Hancock, Chifley, Hanna Neumann,
  Marie Reay, Copland, Menzies, Haydon-Allen, Birch, Peter Karmel,
  Engineering), 243 more drawn dim for context, and the roads, footpaths and
  Sullivans Creek. `scripts/fetch-campus.ts` bakes them into
  `src/data/campus.ts`, which is committed, so the build never touches the
  network. Heights are exaggerated about 2×, because at the scale a whole
  campus fits on a screen, true storey heights look like a car park.
- **Real: your bookings.** They live in SQLite, through Drizzle, and survive
  restarts and redeploys. The clash check and the insert happen in one
  transaction (`src/lib/booking.ts`), so two people clicking the same slot at
  the same moment can't both get it.
- **Invented: the rooms.** Floor layouts, room numbers, capacities and features.
  ANU's floor plans aren't open data, so `src/lib/floorplan.ts` runs a corridor
  down each building's real outline, cuts rooms either side, and keeps only
  what fits inside the real walls. Marie Reay's floors are Marie Reay-shaped,
  but no room here matches a real one.
- **Invented: everyone else.** 280 fictional people hold a fortnight of
  plausible bookings, seeded rolling forward so the campus is never empty
  when you open it.
- **Pretend: the sign-in.** There's no directory behind it. The mechanics are
  real, though: passwords are scrypt-hashed, session tokens are 32 random
  bytes, and the cookie is `httpOnly`. A prototype can fake the policy; faking
  the mechanics teaches the wrong habit.

## What good looks like here

- **The map is never the only way in.** The 3D canvas is an enhancement. Every
  building, level and room on it is also a link in the server-rendered panel,
  every form works without JavaScript, and each level has an SVG floor plan.
  With no WebGL, or with reduced motion turned on, the same pages lay out as
  ordinary lists: you lose the spectacle, not the app.
- **A phone is a first-class screen.** 390×844 is a marking viewport, not a
  fallback. One finger orbits and two pinch. The camera framing is solved from
  the geometry and the space the panel leaves, not tuned by hand, so every
  bookable building lands in frame on a phone and on a wide desktop, and
  building codes are drawn in screen space so they read at either size.
- **The map frames around what covers it.** The camera centres its subject in
  the space the panel and the dialog leave, rather than behind them.
- **Colour never carries meaning alone.** Taken slots are hatched as well as
  shaded, your own are inked, and every slot says what it is in text a screen
  reader reads out. The automated accessibility check can't see contrast, so
  that part is my judgement, not a test I pass.
- **It draws only when something changes.** No animation loop runs while
  nothing moves, which matters for a phone's battery.
- **Other people's bookings show up live.** A booking made anywhere re-tints
  the map in every open window; the panel's lists catch up on your next click.

## Left out on purpose

- **An admin side:** approvals, room management, opening hours. The brief asks
  for a slice wired end to end, and finding a room and taking it is the slice
  that annoys people.
- **Recurring bookings:** most of a timetabling system's complexity, and none
  of what makes finding a room hard.
- **Real ANU sign-in.** Single sign-on would be a week's work that proves
  nothing about the idea.
- **Search first.** Ranking rooms for "6 people, Thursday 2–4pm, whiteboard"
  was the alternative. The filters do a lighter version; the map won because
  seeing *where* is the part a list can't do.

## How it's checked

`pnpm check` runs a typecheck and the spec suite against the built server. The
course template supplies `spec/invariants.test.ts` and `spec/readme.test.ts`:
landmarks, headings, an axe-core accessibility floor on every route in
`spec/routes.ts`, and this file served whole at `/readme/`. Mine:

- `spec/booking.test.ts` drives the running app over HTTP. **A booking
  persists across a reload**; a room can't be double-booked; cancelling frees
  the slot; bookings in the past, too far ahead, too long or past closing are
  refused, and so is cancelling someone else's; a booking made in one client
  reaches another over the event stream.
- `spec/map.test.ts` holds the drill-down to its contract: each stage links to
  the next, a level that doesn't exist falls back to its building, and a room
  opens as a dialog in front of the map with a sign-in or a booking form and a
  way back to its level.
- `spec/campus.test.ts` holds the floor-plan generator to its contract: every
  room inside its building's real footprint, no two overlapping, the same
  layout every time.

What no test can tell me is whether the map is actually easier than a
dropdown, or whether a camera flight reads as "one step further in" rather
than motion for its own sake. That's the crit's call.

## Running it

```sh
pnpm install
pnpm dev           # localhost:4321
pnpm check         # typecheck + the spec suite, against the built server
```

The database is one SQLite file: `.data/app.db` locally, a Fly volume in
production. Migrations and the campus seed run at boot, so a fresh clone comes
up as a working campus. To refresh the map from OpenStreetMap, run
`node scripts/fetch-campus.ts` and commit what it writes to
`src/data/campus.ts`.

## Credits

Building footprints © OpenStreetMap contributors, licensed
[ODbL](https://www.openstreetmap.org/copyright). 3D by
[three.js](https://threejs.org/).
