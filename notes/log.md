# Process log

Raw material for `PROCESS.md` — terse entries as the work happens, not a
write-up. Newest last.

## Crit 7 — ANU Acton room booking

**Spec first, from the API not the prose.** Pulled the crit-7 spec off the
course API rather than reading the brief's prose. Five lines, one of them
("the core flow persists across a reload") directly testable, so it became a
test before it became a feature.

**Four decisions settled up front:** which slice (find/book/cancel), how login
works (uni ID + password), where room data comes from (real seeded ANU
buildings), what it looks like. Then overridden — asked for a clickable map of
ANU, then for three.js. That moved the centre of gravity from a grid to a map;
everything after follows from it.

**Refused to invent the campus.** Assumed real ANU geometry would be
unavailable. Ten minutes on Overpass found real footprints *and* storey counts
for every building wanted. `scripts/fetch-campus.ts` bakes them into a
committed module so the build never hits the network. Floor plans aren't open
data, so those are generated *from* the real outlines and README says so.

**Floorplan generator, test-first.** `spec/campus.test.ts` written before
`src/lib/floorplan.ts` existed. Immediately caught two real geometry bugs —
rooms overlapping, a room outside its building — sharing one cause: rounding
coordinates *after* testing containment. Fixed by testing the rounded rect and
adding a party wall between rooms.

**Seed was a design bug, not a data bug.** First spec run failed on a page
reading "Coming up (**1275**)". All ambient bookings belonged to the four demo
personas. Fixed with a cast of 280 fictional people, and separately gave each
building its own daily "pressure" — a campus at 88% free everywhere gives the
map nothing to say.

**Three things green tests could not see**, all found in Chrome:
1. First campus render was near-black and flat. Technically correct, visually
   worthless.
2. Then the camera blanked entirely. Instrumented the render loop instead of
   guessing: distance `7521`, past `camera.far`. Root cause — the scene
   container starts `hidden`, so the first layout measured 0×0 and the camera
   was fitted to that. Fixed by unhiding before constructing, ignoring resizes
   with no layout, clamping the solved distance.
3. **Clicking a building did nothing.** Hover worked, so it looked fine. Slabs
   carried `slug`; the click handler only followed `href`, which only room
   boxes had. The headline interaction was dead and no assertion could have
   caught it. Found by sweeping synthetic pointer events and asserting the URL
   changed.

**Camera framing is solved, not tuned.** Projects each building's bounding
sphere and grows the distance until everything fits, so the whole campus frames
correctly at 1920×1080 and at 390×844 without a hand-picked number per
viewport.

**Chunk-size warning treated as a question.** three.js is ~650 kB raw. The
answer was that code-splitting was already correct (~19 kB on first load, the
rest lazy behind a WebGL check), so the threshold moved to just past the real
figure with the reasoning written down rather than being switched off.

**Repainted bright.** Dark ops-console theme rejected; a vivid-poster take was
rejected too ("looks like some street hip thing" — the neo-brutalist tells:
thick black rules, hard offset shadows, shouting caps). Landed on warm paper
with ANU black and gold as anchors. New colour system in `src/lib/palette.ts`:
**hue means which building, fill means how free** — so the page can be
colourful without availability depending on telling ten hues apart. Hues dealt
by sorted position, not hashed, because a hash collides and hands two buildings
the same identity.

**Roads and paths.** Three OSM fetch problems in a row: `overpass-api.de` 406s
without `Accept` and `User-Agent`; the mirror in use was rate-limited;
`overpass.osm.ch` answered 200 with zero elements because it is a
Switzerland-only extract, and that emptiness got cached as "there are no
footpaths here". Script now rotates mirrors, sends the headers, and refuses to
cache an empty answer. Campus lanes (`service`) are fetched and drawn
separately from arterials (`primary`) because they should not look the same.
Footpaths get a casing — wider dark ribbon under a pale one — the way a paper
map makes a thin line readable.

**Ground markings flickered while panning.** Z-fighting: five coplanar layers
0.02–0.06 units apart, and `near = 1` against `far = 4000` throws away most of
the depth buffer on space the camera never occupies. Fixed by moving the near
plane to 6, and by taking the markings out of the depth argument entirely —
none writes depth, explicit `renderOrder` decides who covers whom, and they
still depth-*test* so buildings occlude them correctly.

**Everything inside the map.** Asked to stop making people scroll past the map
to reach the booking controls: drill down inside it — campus → a building's
storeys fanned apart → one storey from overhead → a room's dialog in front of
the map. Asked three questions before building (4 steps or 3, 3D or flat
floor, where the filters live) and took the recommended answer each time.

- **This overturned an assumption the earlier agent had built in, not just
  the layout.** The first design took for granted that people would want a
  way to book *outside* the map: the campus page's lede told them to "scroll
  past the map, where the same thing is a list", README.md said "Everything
  below the map is the same information as a list", and the building and
  room pages put the floor plan, day grid and booking form in a scroll
  underneath the canvas. My challenge was direct: "I dont like having to
  scroll down to access the room management stuff, I would like to keep
  everything inside that map". So the parallel below-the-map route is gone.
  What's left of it lives *inside* the map: a floating panel whose lists stay
  as the keyboard and screen-reader route, not a second place to book from.
  The only time the page lays out as scrolling lists now is when there's no
  map to put them in (no WebGL, reduced motion).

- Kept every stage a real URL (`/`, `/b/x/`, `/b/x/?floor=N`, `/b/x/room/`)
  rather than making it client state: back button, reload, shared links and
  the no-JS path all keep working, and the spec's reload line stays true for
  free. `spec/map.test.ts` written first, against `data-stage` and the links
  each stage must offer; red for the right reason before any markup changed.
- The scene frames around what covers it. A floating panel and a docked
  dialog would hide half the campus if the camera fitted the whole canvas, so
  `[data-occludes]` elements are measured and the projection is shifted with
  `setViewOffset`. A folded panel's head (small, in a corner) is deliberately
  ignored, or it would cost the map a third of the screen.
- Stage changes animate with the camera — slabs fanning, colours shifting,
  the storeys above fading out — as tweens on the flight's own progress. A
  ResizeObserver on the overlays fired once on attach and restarted the
  flight mid-fan; fixed by ignoring no-change reports and letting a reframe
  *steer* a flight in progress instead of restarting it.
- Room numbers are painted on the tiles, and the overhead camera looks along
  the building's corridor axis — turned a quarter on a tall phone screen, with
  the text turned back so it still reads left to right.
- Live vs fallback layout is `:has()` on the persisted scene container, not a
  class set by script: the router re-renders everything around the container
  each navigation and a class would flash off in between. The mount now shows
  the container *before* three.js loads, so the page doesn't lay out as a list
  and then rearrange under the visitor.
- Found in Chrome, not by tests: fog tuned for the old canvas washed the
  phone view out (now scales with camera distance); the room close-up zoomed
  so far on desktop you lost the floor (now capped at ~2× the floor view);
  the panel's `<h2>` title behind a dialog inherited the small-caps section
  style; "21 of 24 half hours free" at 18:45 counted slots already gone.
- Fixed in passing: the date strip only wired its auto-submit on first load,
  so after any router navigation changing the date did nothing; the live
  event handler nudged a building *busier* on a cancellation too.
- **Adversarial review** (fresh Sonnet agent, no shared context, told to be
  hostile, driving Chrome at 1440×900 and 390×844). Three findings, each
  re-checked by hand before acting:
  1. *Real, high.* Signing in from a room's dialog left the map stuck on
     "Loading the campus…" for the rest of the session. The sign-in page has
     no map, so the router drops the persisted container; on the way back the
     mount saw a live scene and updated it — drawing into the old, detached
     canvas. It had been latent since the first version (any trip through My
     bookings or About did it too); the dialog's sign-in link just made it the
     common path. Fixed by remembering which container the scene was built on
     and rebuilding when it changes, and by releasing the WebGL context and
     event stream on landing somewhere without a map.
  2. *Not reproduced.* "7 of 10 buildings unreachable on a phone": the list
     scrolls inside its sheet (353 px window onto 1142 px; Menzies scrolls
     into view). The reviewer measured it unscrolled. The kernel of truth — a
     phone shows no scrollbar, so nothing says there's more — got scroll
     shadows at whichever edge has more list beyond it.
  3. *Real, medium.* The level list's day strips draw "already been" slots
     on today's date with no legend entry for them; added, matching the
     dialog's legend.
  Not covered by the reviewer before it was asked to wrap up: keyboard-only
  pass, clash/past-slot error states, back/forward, mid-stage resize.
- **Final check in Chrome, against a preview build at 1920×1080 and 390×844**,
  measuring each overlay's bounds against the window rather than trusting
  scrollbars. Caught one clip the reviewer missed: on a desktop the room
  dialog ran to 1130 px in a 1080 px window with no scroll. A `<dialog>` ships
  with `height: fit-content`, which beats top + bottom anchoring, so it grew
  to its content and the map frame's `overflow: hidden` cropped "who has it"
  off silently. `height: auto` on the docked dialog; now it scrolls, and the
  last section is reachable at both sizes. Also: signed in on a phone the
  masthead wrapped to three rows; the account now shares the brand's row.

**Renamed, and Reset view means the campus.** The masthead's "Book · ANU
Acton" became **ANU Room Booking** with a mark, at the user's request for "the
anu logo". Drew an original mark in ANU black and gold (a shield holding an
open book) rather than copying the University's crest: it's a trademark, the
app will be public, and the app says it isn't an ANU service. The user can
swap in the real file if they want it. The longer name pushed a signed-in
phone masthead back to three rows, so under 560 px the name shows as initials,
with the full name kept for screen readers. Page titles follow the new name.

The user reported "Reset view" not going back to the campus. It re-framed
whatever stage you were on, which inside a building is the building. It now
means the whole campus from anywhere: a real navigation out to `/` with the
date kept, or, already on the campus, just the camera going back.

Asked whether the bookings are in the database or hardcoded: they're in
SQLite through Drizzle. `createBooking` checks for a clash and inserts in one
transaction, and the seed only ever adds demo bookings for dates that don't
have any yet, never deleting, so a real booking survives restarts.

**Ground floor is GF.** The user flagged the level numbering. It was 0-based
already (Australian convention: ground, then 1, 2, 3), but the 3D tags hung
in the gap above each storey's roof, and from the camera's angle the storey
above covers that gap. So every tag read one storey high: the ground floor
looked unlabelled and "L0" looked like the first floor up. Tags are now
pinned half way up their own storey, on the building's front corner, and
re-placed every frame so they ride the fan and follow an orbit. Then the
label itself: "the tag shows as L0, should be GF". `src/lib/levels.ts` now
names levels in one place: GF, L1, L2 on tags and chips, "ground floor" /
"level 2" in text. Storey numbers in the data and room codes (0.01) are
unchanged.

**Rewrote the About page (README.md).** Asked to "rewrite the about section".
The old README had grown with the app to 1,786 words and put the design
argument before any way to use it. Rewrote it reader-first (~1,350 words):
what it is, a five-step "Try it" with the demo sign-in, then why a map, what's
real vs invented, what good looks like, what was left out, how it's checked.
Checked every claim against the code before writing it, which turned up
drift the old text had: the seat and feature filters existed but were only
mentioned in passing, the booking limits (08:00–20:00, three hours, two weeks
ahead) weren't stated, "~240" context buildings is exactly 243, and live
updates re-tint the map but not the panel's lists, so the README now says
so. Roles on the demo accounts are labels only; said so rather than implying
they do something.

- **Adversarial review** (fresh Sonnet agent, no shared context, told to be
  hostile, checking claims against the code and a preview build, and walking
  the "Try it" steps in Chrome). No accuracy errors and no overclaiming; it
  verified each number and both cancel paths. Content it said the rewrite
  dropped: one-finger orbit / two-finger pinch on a phone, and building codes
  drawn in screen space. Both restored. Also tightened the colour paragraph
  it found clunky. Kept the demo roster as IDs only, not the old table: IDs
  and the password are all anyone needs to sign in.
- Found in Chrome at 390×844, not by tests or the reviewer: the demo password
  wrapped at its hyphen, "anu-" on one line and "acton" on the next, which is
  the one string a reader has to type exactly. Inline code in `.prose` is now
  `nowrap` (code blocks keep their newlines); the longest inline span in the
  README is ~233 px against a 361 px column.

**Dark mode.** Asked "can we add a dark mode?". Follows the device
(prefers-color-scheme) until someone picks, then remembers the pick in a
`theme` cookie so the server renders `data-theme` on `<html>` and the first
paint is already right — a script-only switch flashes the device theme on
every load. The switch is a form POST to `/api/theme` (works with JS off);
with JS it writes the same cookie itself and re-themes in place, so the map
isn't reloaded. Both buttons (moon, sun) are always in the masthead and CSS
shows whichever isn't on screen — that way it's right even with no cookie and
a dark device, which the server can't know about.
- Tests first (`spec/theme.test.ts`): follows device with no cookie, a switch
  both ways on every route, cookie → `data-theme`, POST sets a year-long
  cookie and 303s back, no open redirect, junk themes ignored. All 11 failed
  before the implementation.
- Every colour in `styles.css` is now a `light-dark(day, night)` token, so
  there's one palette definition rather than a light block and two copies of
  a dark one (media query + attribute). Hard-coded colours (links, notices,
  past-slot hatch, meter track, masthead glass, scene HUD, code blocks, floor
  plan shell) became tokens.
- Building hues: the darker ones sink on a dark card (indigo 1.86:1), so each
  swatch in `palette.ts` got a lifted night twin, ≥5:1 on the dark card, all
  taking black ink. Emitted inline as `light-dark()`, so one style attribute
  serves both themes.
- The 3D scene got a night palette and rebuilds on a fresh canvas when the
  theme changes (a force-lost context can't be revived on the same canvas).
  That exposed a leak: the Reset view listener lived on the persisted
  container and outlived its scene; `dispose()` now removes it.
- Found in Chrome, not by tests: (1) both switch icons showed in light mode —
  `.btn`'s `display` beat the hide rule on specificity. (2) Signed in at
  390×844 the masthead went to three rows, which the phone layout exists to
  prevent; the switch now rides at the end of the nav row. (3) Night rooms on
  a floor all looked the same lavender: the day lighting runs ~4× hot in
  linear space, which bleaches stone nicely but clips the lifted night hues
  to one pastel, erasing busy vs free. Night lights are dimmer, so a colour
  renders near its hex; busy rooms now visibly sink.
- Started a fresh Sonnet adversarial review, then stopped it: the user said
  "no need for an adversarial review for this". Checked by tests plus the
  Chrome pass at 1440×900 and 390×844 in both themes instead.
- README gets three sentences on dark mode under "Why a map", next to the
  colour paragraph it qualifies.
- User asked for the login's uni ID to have the `u` pre-filled and to cap the
  length. The field is now a fixed `u` prefix joined to a digits-only box
  (`inputmode=numeric`, `maxlength=7`, `pattern=[0-9]{7}`), with a visible
  hint. A small delegated script cleans up pastes and autofills, e.g.
  `U1000003`, which `maxlength` alone would cut to `u100000`. The server
  accepts `1234567` or `u1234567` (`normaliseUniId`), so the flow still
  works with JS off and for the existing tests.
- Passwords are capped at 256 chars (`MAX_PASSWORD`) on both sides, with their
  own `long-password` error, so no one can make the server scrypt a huge
  form body.
- Security pass as requested. SQL injection: all queries go through Drizzle
  parameters, and the only raw SQL is static seed text or Drizzle's
  `sql` template, which binds its values. XSS: Astro escapes every
  interpolation, the error text is looked up from a fixed map, and a
  test now proves a `"><script>` in `next`/`error` can't break out of its
  attribute. Found and fixed an **open redirect**: the `next` check (starts
  with `/`, not `//`) let `/\evil.example` through, and browsers read that
  as `//evil.example`. It was copied in four places (login, session, theme,
  cancel), which now share `safeNext()` in `src/lib/links.ts`.
- TDD: 7 new sign-in contracts in `spec/booking.test.ts` went red first, then
  the code made them pass. Checked in Chrome at 390×844 / 1440×900 / 1920×1080;
  split the focus ring so it wraps the `u` and the digits as one box.
- User, at 08:14 with a booking running 08:00–11:00: "the top booking should
  be in a seperate 'in progress' or active state". My bookings now has a
  "Happening now" section above "Coming up". The phase of each booking
  (past / now / upcoming) comes from one pure `bookingPhase()` in
  `src/lib/slots.ts`, driven by the Canberra clock, which replaces the
  inline past check in `bookingsForUser`. Row markup was repeated in two
  sections and would have been in a third, so it moved into
  `BookingItem.astro`; a past row still drops its link and Cancel.
- The first draft had an "In progress · until 11:00" pill with a pulsing
  dot. The user struck it: "that in progress icon is redundant, simply
  being inside happening now is enough". Removed; the row keeps a full
  outline in its building's colour.
- User asked what happens once a booking elapses: it moves to "Already been"
  on the next render. So an open tab doesn't stay stale, the page carries
  `data-refresh-in` (seconds until the next start or end today, from
  `secondsUntilSlot()`), and a script re-renders it in place through the
  ClientRouter at that moment. Checked in Chrome by forcing a 1s timer.
- TDD: a unit contract for `bookingPhase` pinned at 08:14 AEST, plus an
  HTTP contract that a booking already started is listed under Happening
  now, before Coming up. That one skips when the campus is shut. Both
  went red first. Checked at 390×844 / 1440×900 / 1920×1080 against a
  throwaway DB.
- Asked whether Cancel on a booking already under way should end it early
  (keep the used half hours, free only the rest). The user decided: cancelling
  a booking that has already started should cancel the whole booking. So
  it stays as it was: one cancel, whole booking.
- User, on the floor layouts: "need to make the floor plans more realistic,
  the floors are usually a few meeting rooms and lab rooms, and mostly
  desks/study spaces … you may need to update the database too to not remove
  booked places". This overturns the earlier generator's assumption that a
  floor is a corridor lined with tutorial rooms and lecture theatres.
- `src/lib/floorplan.ts` rewritten. Each building gets a stair and lift core,
  one of them or one near each end past 80 m, stacked the same on every
  storey. Each floor gets 2–4 meeting rooms and sometimes a computer lab
  clustered round it: one guaranteed lab floor per building, rooms held to
  30% of the frontage. Everything else is benches of individually bookable
  desks in lettered study areas. Deep buildings get a second band per side
  across an aisle, capped at two, because the first screenshot showed
  Marie Reay's floor half empty. New codes, `MRTC 104` for a room and
  `MRTC 1A-07` for desk 07 in area A, deliberately never take the old
  `1.04` shape, so a kept old room can't collide with a new code.
- Assumption: desks are bookable one by one, like rooms. That fits
  "booked places" and the existing one-booking-per-place model.
- DB: `rooms.listed` added (migration 0001). `seedRooms` only ran on an empty
  building, so an existing volume would never have picked up a new layout.
  It's replaced by `reconcileRooms`, which runs every boot. Old places:
  fixture (cast) bookings are deleted and replanted. A real upcoming booking
  keeps the room listed where it is, and new places under it are unlisted
  until it's over. Past-only bookings keep the row, unlisted, for history.
  No bookings at all means the row is deleted. Queries, and `createBooking`,
  ignore unlisted places.
- Rehearsed on a copy of the real local `.data/app.db`: all 27 real
  upcoming bookings kept on their original rooms, 26 old rooms kept, 8
  hidden, 311 new places waiting. The first run showed the seeder planting
  demo traffic on the kept old rooms, which would have kept them alive, so
  seeding is now limited to planned codes. A regression check went red (21
  bookings on the kept room instead of 1) before the fix, then green.
- Also made seeding skip slots that clash with existing real bookings (it
  never checked before), and gave desks lighter traffic.
- UI: the floor panel keeps day-strip rows for rooms, and puts desks in one
  folding `<details>` per study area ("28 of 30 free now") opening to a grid
  of desk chips with a free-time bar. Colour sits in the bar, not the chip
  background, so text contrast holds. The 3D scene draws desks as low tiles
  with shared geometry, and cores as stone blocks marked "Lifts". The SVG
  plan draws cores, and uses one rotated `<g>` per floor instead of a
  rotate() on every rect. The seat filter is now any/2/6/12/24, since 50
  matched nothing once lecture theatres went. Level and campus copy says
  rooms and desks.
- Page weight: Birch L1 (670 desks) was 549 KB of uncompressed HTML, now 428
  KB after the SVG trim, desk titles dropped and a rounded scene state.
  The rest is just how many desks there are. The server sends no gzip,
  which is left as a separate call.
- TDD: new contracts in `spec/campus.test.ts` went red first. They cover:
  mostly desks, at least one meeting room, at most seven rooms, a lab per
  building, cores clear of places, the new code shapes, desk capacity 1, and
  two in-memory-DB reconcile cases. `spec/routes.ts` now walks `mrtc-g01`
  and a desk page `mrtc-ga-01`.
- User said no adversarial review for this change. Checked in Chrome at
  1440×900 (Marie Reay L1, Birch L1, a desk's dialog), 390×844 (floor, then
  the panel opened on a study area) and 1920×1080 (Hanna Neumann L2).
  Fixed the dialog saying "book this room" on a desk.
- User, after the merge: "i think you've dramtically overguessed the number
  of desks. you can roughly triple thr number of labs/meeting rooms and cut
  number of desks and study spaces by like 1/5 (20% the current amount)".
  That overturns my reading of "mostly desks/study spaces" as benches filling
  every free metre. The baseline was 10,552 desks and 116 rooms (97 meeting
  rooms, 19 labs).
- TDD: replaced the "mostly desks" contract with two new ones. Every floor
  gets ≥3 meeting rooms, ≤21 rooms and some study space, and the campus gets
  300–420 rooms and 1,700–2,500 desks. Both went red (116 rooms, and a floor
  with 2 meeting rooms), then green.
- Generator: 6–12 meeting rooms and 1–3 labs a floor, with rooms allowed up
  to 60% of the frontage (was 30%). Desks are now pods of four (two facing
  two) centred in the band, spaced 6.4 m apart instead of full-depth
  benches every 3.4 m. The result is 356 rooms (295 meeting rooms, 61 labs,
  3.1×) and 2,284 desks (21.6%).

**Reflection drafted.** `reflections/crit-7.md` answers both standing
prompts, drafted from this log and then edited down by the user (210
words): the breakthrough was keeping every stage inside the map; the change
was stating intent precisely and checking the rendered page, since each gap
got filled with a plausible guess.

**CI deploy kept timing out: the site was too big to crawl.** The repo was
public and the Fly deploy had gone through, but both `checks` runs got
cancelled at the 10-minute job limit inside "Check internal links on the
live site". Linkinator follows every `<a href>`, and the pages printed about
2,640 room pages × 15 dates (the date strip's ◀/▶ links) × about 24 free
half-hour links per room (`?start=`) × 2 (a `/login/?next=<this page>` link
on every page): tens of thousands of URLs. Rather than widen the
course-supplied `--skip` pattern, the moves that multiplied pages are now
GET-form submissions that land on the same URLs:
- date arrows are `<button name="day">`, which the page 303-redirects to
  its own `?date=` URL (`dayRedirect` in `src/lib/links.ts`);
- free slot cells are `<button name="start">` in a GET form to `…#book`;
- every Sign in is a GET form with a hidden `next`.
TDD: `spec/map.test.ts` gained a crawl test (from `/`, every link is at
today's date, with no `start=` or `login?next=`, bounded by room count). It
went red at 1,228 URLs, then green at about 2,700 (one per room). The
dialog's sign-in test now expects the form. Checked in Chrome at 1440×900 and
390×844. The next-day, slot and sign-in buttons land on
`?floor=1&date=…`, `?date=…&start=17#book` and `/login/?next=…` as before.

**The crawl test was too slow for CI.** Run 36300680653 failed on `668a7a8`.
The new crawl test fetched every room page, which took about 35 s locally
and passed the 60 s timeout on the runner, so `deploy` was skipped. It now
counts every link but fetches only one room page per building, since room
pages all print the same links. The suite is back to about 3 s. A mutation
check (putting back the old `?start=` slot links) still turns it red.

**The live link check still timed out after `eff928e`: room and desk links.**
`check` passed and the deploy went out, but linkinator ran out of time
again. Timed against the live site, it managed about 1.5 pages/s, and every
room and desk on a floor (356 + 2,284) was still its own `<a href>`: about
30 minutes of crawling. Options put to the user: (A) narrow the CI
`--skip` to leave out room pages, or (B) stop room and desk entries being
links. The user chose B, so the course's check stays as it is.
- A level's room rows and desk tiles are `<button name="room">` in one GET
  form (`data-places`) to the building URL, which 303-redirects `?room=` to
  the room's own URL. This still works with JS off and by keyboard.
- The fallback SVG plan's shapes are `<g data-room>`, opened by a click
  handler (`navigate`). The SVG is one `role="img"`, and the list is the
  keyboard/screen-reader way in.
TDD: the floor test now expects the form and the redirect, and no room
links. The crawl test expects no room pages and at most 12 per building.
Both went red (the crawl found 1,313), then green. Locally, linkinator now
scans 52 links in 0.23 s. Checked in Chrome at 1440×900 / 390×844: rows and
desk tiles look unchanged, and the row, desk and plan clicks each open the
right room.

**Reverted the crawlability changes; fixed the link check instead.** The course
convenor said not to change the app for this: linkinator's `--recurse` treats
every distinct query string as a new page, so a query-string site never runs
out of pages, and the workflow is ours to fix. That reverses the earlier
assumption that the check was fixed and the app had to fit it (the user had
picked option B for that reason). The user: "revert those changes and update
the work flow itself".
- `git revert` of `2638a1d`, `eff928e`, `668a7a8` (app, styles, `spec/map.test.ts`).
  This log is kept as it was, as the record of what happened.
- `.github/workflows/checks.yml`: linkinator gets a second `--skip "\?"`, as
  the convenor suggested. Path links are still crawled and still fail the build
  if broken.
- PROCESS.md gets a paragraph on the change and why.
