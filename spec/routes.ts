// The routes the invariants run against. When you add a page, add its route
// here, or the invariants stop covering it.
//
// The dynamic ones name seeded records: `marie-reay` is a building
// src/data/campus.ts always carries, and `mrtc-0.01` is the first room
// src/lib/floorplan.ts lays out on its ground floor. If either stops
// existing, that's a change worth a failing test. The building page is two
// stages of the map — its levels, and one level's rooms — so both are here.
export const ROUTES = [
  "/",
  "/login/",
  "/bookings/",
  "/b/marie-reay/",
  "/b/marie-reay/?floor=0",
  "/b/marie-reay/mrtc-0.01/",
  "/readme/",
];
