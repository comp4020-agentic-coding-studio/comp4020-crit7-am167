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
