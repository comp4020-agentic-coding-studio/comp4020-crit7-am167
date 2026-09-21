// The routes the invariants run against. When you add a page, add its route
// here, or the invariants stop covering it.
//
// The two dynamic ones name seeded records: `marie-reay` is a building
// src/data/campus.ts always carries, and `mrtc-0.01` is the first room
// src/lib/floorplan.ts lays out on its ground floor. If either stops
// existing, that's a change worth a failing test.
export const ROUTES = [
  "/",
  "/login/",
  "/bookings/",
  "/b/marie-reay/",
  "/b/marie-reay/mrtc-0.01/",
  "/readme/",
];
