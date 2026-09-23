// The routes the invariants run against. When you add a page, add its route
// here, or the invariants stop covering it.
//
// The dynamic ones name seeded records: `marie-reay` is a building
// src/data/campus.ts always carries, `mrtc-g01` is the first room
// src/lib/floorplan.ts lays out on its ground floor, and `mrtc-ga-01` the
// first desk in that floor's first study area. If any stops existing, that's
// a change worth a failing test. The building page is two stages of the map —
// its levels, and one level's rooms and desks — so both are here.
export const ROUTES = [
  "/",
  "/login/",
  "/bookings/",
  "/b/marie-reay/",
  "/b/marie-reay/?floor=0",
  "/b/marie-reay/mrtc-g01/",
  "/b/marie-reay/mrtc-ga-01/",
  "/readme/",
];
