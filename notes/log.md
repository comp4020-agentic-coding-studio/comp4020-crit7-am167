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
