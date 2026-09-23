import { navigate } from "astro:transitions/client";
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Shape,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Material, Object3D } from "three";
import { BUILDINGS, LANES, PATHS, ROADS, SCENERY, WATER, type Ring } from "../data/campus";
import { swatchFor } from "../lib/palette";

// ANU Acton, extruded — and the whole app's stage.
//
// Real OpenStreetMap footprints pushed up by their real storey count, tinted
// by how free each building's rooms are. You drill down without leaving it:
//
//   campus    every bookable building; click one
//   building  its storeys fan apart, each tinted by how free it is; click one
//   floor     the camera swings overhead onto that storey, the ones above it
//             fade away, and its rooms are tiles with their numbers on; click
//             one
//   room      the room lifts and the camera closes in on it, while the page
//             opens the room's dialog over the map
//
// Each step is a real navigation to a real URL; the scene just flies between
// them (see CampusScene.astro for why the canvas survives the navigation).
//
// Three decisions worth knowing about:
//
// 1. IT RENDERS ON DEMAND. There is no unconditional requestAnimationFrame
//    loop — a frame is drawn when something changes (a camera flight, a
//    hover, a live booking) and then the loop stops. That keeps a phone's
//    battery and a Fly machine's CPU out of it, and it means a screenshot
//    tool isn't racing a canvas that repaints forever.
//
// 2. IT FRAMES AROUND WHAT COVERS IT. The panel and a room's dialog float on
//    top of the canvas, so fitting the campus to the whole canvas would hide
//    half of it behind them. Anything marked `data-occludes` is measured, and
//    the camera's projection is shifted (setViewOffset) so the subject is
//    centred and fitted in whatever is left uncovered.
//
// 3. IT IS NEVER THE ONLY WAY. Every building, level and room here is also a
//    link in the server-rendered page. This file can fail to load and nothing
//    is lost but the spectacle.

export type SceneState = {
  mode: "campus" | "building" | "floor";
  date: string;
  focus: string | null;
  /** the level being looked down on, or -1 */
  floor: number;
  /** the room whose dialog is open, if any */
  selected: string | null;
  buildings: Array<{ slug: string; free: number; matching: number; yours: number }>;
  levels: Array<{ level: number; rooms: number; free: number }>;
  rooms: Array<{
    code: string;
    slug: string;
    cx: number;
    cz: number;
    w: number;
    d: number;
    angle: number;
    capacity: number;
    free: number;
    yours: boolean;
  }>;
};

// Daylight, on paper. The campus is lit rather than glowing: buildings you
// can book carry their own identity colour (src/lib/palette.ts), everything
// else is warm stone, and how free a building is shows as how saturated its
// colour is rather than as a different hue.
const COLOUR = {
  ground: 0xf2ede2,
  scenery: 0xd2c9b4,
  sceneryEdge: 0x9a9080,
  /* arterials around campus — the widest, darkest tarmac */
  road: 0xa89c82,
  /* service loops inside campus — narrower, and warmer so they read as
     "the road behind Chifley" rather than as part of Barry Drive */
  lane: 0xbcb096,
  /* footpaths: pale concrete, but with enough contrast to trace by eye */
  path: 0xfdfaf2,
  pathEdge: 0xcdc2aa,
  water: 0x7fbdd6,
  /* what a fully-booked building fades towards */
  spent: 0xcfc7b5,
  mine: 0x1b1813,
};

/** A real storey is about 3.6 m. At the scale a whole campus fits on a
 *  screen that reads as a car park, so height is exaggerated — this map is
 *  for finding a building, not measuring one, and README.md says so. */
const STOREY = 8;
/** world up, reused rather than reallocated per frame */
const UP = /* @__PURE__ */ (() => new Vector3(0, 1, 0))();
/** Room tiles are seen from above, so they're low: a plan, not a model. */
const ROOM_HEIGHT = 2.4;
/** how far the open room rises off the floor */
const ROOM_LIFT = 1.6;
/** hover lifts a surface towards this rather than making it glow */
const WHITE = /* @__PURE__ */ (() => new Color(0xffffff))();
/** and whatever isn't the subject recedes towards the ground */
const PAPER = /* @__PURE__ */ (() => new Color(COLOUR.ground))();

/** How far the storeys drift apart once you're inside a building. */
const FAN = 11;
/** Looking down on a floor: nearly overhead, but not quite, so the room
 *  tiles keep a sliver of side and read as things standing on a floor. */
const OVERHEAD = 1.36;
/** a building seen from outside, fanned open */
const FANNED = 0.5;

export function createScene(canvas: HTMLCanvasElement, container: HTMLElement) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  // a phone doesn't need 3× the pixels to look sharp, and it does need the
  // battery — this is the single biggest cost lever in the file
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(COLOUR.ground);
  // the haze starts just past whatever the camera is looking at (see
  // applyCamera), so a phone pulled far back to fit the campus up its tall
  // screen isn't looking at it through fog
  const fog = new Fog(COLOUR.ground, 1000, 3000);
  scene.fog = fog;

  // A near plane of 1 against a far plane of 4000 throws away almost all
  // the depth buffer on space the camera never occupies — which showed up
  // as the ground markings flickering against each other while panning,
  // because 0.02 of world separation stopped being resolvable out at 800
  // units. The camera is clamped to 28 units away at closest, so 6 is
  // conservative and buys back several bits of precision everywhere.
  const camera = new PerspectiveCamera(42, 1, 6, 4000);

  // --- lights ------------------------------------------------------------
  scene.add(new HemisphereLight(0xffffff, 0xd8cfbc, 2.6));
  const sun = new DirectionalLight(0xfff6e2, 2.2);
  sun.position.set(-380, 560, -220);
  scene.add(sun);
  const bounce = new DirectionalLight(0xdfe7f2, 0.85);
  bounce.position.set(340, 190, 420);
  scene.add(bounce);

  // --- static ground -----------------------------------------------------
  const world = new Group();
  scene.add(world);

  const ground = new Mesh(
    new PlaneGeometry(4000, 4000),
    new MeshBasicMaterial({ color: COLOUR.ground }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.4;
  world.add(ground);

  // Ground markings, drawn bottom-up so the thing that should win a
  // crossing is drawn last. DoubleSide because a ribbon's winding follows
  // however the way was drawn in OSM, and a back-facing road is an
  // invisible one.
  //
  // Footpaths get a casing — a slightly wider, darker ribbon underneath a
  // pale one — which is how paper maps make a thin line readable without
  // making it thick. A flat 3 px line on warm paper just disappears.
  //
  // These five layers are all flat on the same ground and only millimetres
  // apart, which is a recipe for z-fighting — and it flickered while
  // panning. The fix is to stop them arguing about depth at all: none of
  // them WRITES depth, and an explicit renderOrder decides who covers whom,
  // so it is a painter's algorithm among the markings. They still TEST
  // depth, so a building in front still hides the road behind it.
  ground.renderOrder = -1;
  const markings: Array<readonly [Ring[], number, number, number, number]> = [
    [PATHS, 4.4, COLOUR.pathEdge, -0.34, 0],
    [PATHS, 2.8, COLOUR.path, -0.32, 0],
    [LANES, 6.5, COLOUR.lane, -0.26, 0],
    [ROADS, 13, COLOUR.road, -0.2, 60],
    [WATER, 14, COLOUR.water, -0.12, 220],
  ];
  const markingMaterials: MeshBasicMaterial[] = [];
  markings.forEach(([lines, width, colour, y, taper], layer) => {
    const merged = mergeRibbons(lines, width, y, taper);
    if (!merged) return;
    const mesh = new Mesh(
      merged,
      new MeshBasicMaterial({
        color: colour,
        side: DoubleSide,
        transparent: true,
        depthWrite: false,
        // and a depth bias on top, so the markings never fight the ground
        // plane itself either
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -(layer + 2),
      }),
    );
    mesh.renderOrder = layer + 1;
    markingMaterials.push(mesh.material as MeshBasicMaterial);
    world.add(mesh);
  });

  // every other building on campus, as one mesh — 240 draw calls would be
  // silly for something nobody can click
  const sceneryGeometry = mergeExtrusions(
    SCENERY.map((b) => ({ ring: b.ring, height: Math.min(b.levels, 8) * STOREY })),
  );
  const sceneryMaterial = new MeshStandardMaterial({
    color: COLOUR.scenery,
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });
  const sceneryEdgeMaterial = new LineBasicMaterial({
    color: COLOUR.sceneryEdge,
    transparent: true,
    opacity: 0.5,
  });
  if (sceneryGeometry) {
    world.add(new Mesh(sceneryGeometry, sceneryMaterial));
    world.add(new LineSegments(new EdgesGeometry(sceneryGeometry, 25), sceneryEdgeMaterial));
  }

  // --- the bookable buildings -------------------------------------------
  type BuildingParts = {
    slug: string;
    code: string;
    name: string;
    levels: number;
    centre: Vector3;
    radius: number;
    /** the outline its floors are laid out in, for framing a floor */
    plan: Ring;
    group: Group;
    /** one slab per storey, so they can fan apart */
    slabs: Mesh[];
    edges: LineSegments[];
    label: Sprite;
  };

  const parts = new Map<string, BuildingParts>();
  const allSlabs: Object3D[] = [];

  for (const building of BUILDINGS) {
    const group = new Group();
    const slabs: Mesh[] = [];
    const edges: LineSegments[] = [];

    for (let level = 0; level < building.levels; level++) {
      const geometry = mergeExtrusions(
        building.rings.map((ring) => ({ ring, height: STOREY * 0.94 })),
      );
      if (!geometry) continue;
      const material = new MeshStandardMaterial({
        color: new Color(swatchFor(building.code).hex),
        roughness: 0.68,
        metalness: 0,
        transparent: true,
        opacity: 1,
      });
      // `base` is the colour the slab is animating through; hover is laid
      // over it each frame rather than written into it
      material.userData.base = material.color.clone();
      const slab = new Mesh(geometry, material);
      slab.position.y = level * STOREY;
      slab.userData = { kind: "slab", slug: building.slug, level };
      group.add(slab);
      slabs.push(slab);
      allSlabs.push(slab);

      const outline = new LineSegments(
        new EdgesGeometry(geometry, 25),
        new LineBasicMaterial({ color: 0x1b1813, transparent: true, opacity: 0.28 }),
      );
      outline.position.y = slab.position.y;
      group.add(outline);
      edges.push(outline);
    }

    const label = makeLabel(building.code);
    label.position.set(building.centre[0], building.levels * STOREY + 26, building.centre[1]);
    group.add(label);

    world.add(group);
    parts.set(building.slug, {
      slug: building.slug,
      code: building.code,
      name: building.name,
      levels: building.levels,
      centre: new Vector3(building.centre[0], 0, building.centre[1]),
      radius: building.radius,
      plan: building.plan,
      group,
      slabs,
      edges,
      label,
    });
  }

  // --- things built and torn down as the stage changes -------------------
  /** "L2 · 63%" tags on the fanned storeys */
  const levelTags = new Group();
  world.add(levelTags);
  /** the rooms on the floor being looked down on */
  const roomGroup = new Group();
  world.add(roomGroup);
  let roomMeshes: Mesh[] = [];
  /** what the room tiles were built from, so a hover or a selection doesn't
   *  rebuild (and re-fade) the whole floor */
  let roomsBuiltFor = "";

  /** the top of a storey's slab once the building has fanned open */
  const plateTop = (level: number) => level * (STOREY + FAN) + STOREY * 0.94;

  // --- what covers the canvas --------------------------------------------
  type Insets = { left: number; right: number; bottom: number };
  let insetNow: Insets = { left: 0, right: 0, bottom: 0 };
  let insetGoal: Insets = { left: 0, right: 0, bottom: 0 };
  let insetFrom: Insets = { ...insetNow };

  /** How much of the canvas the panel and dialog hide, edge by edge.
   *
   *  A tall thing against the left or right edge (a sidebar, a docked
   *  dialog) pushes that edge in; something spanning the width along the
   *  bottom (a phone's sheet) pushes the bottom up. Something small in a
   *  corner — a folded panel — is framed around rather than away from, or
   *  a panel's head alone would cost the map a third of the screen. */
  function measureInsets(): Insets {
    const c = canvas.getBoundingClientRect();
    const out: Insets = { left: 0, right: 0, bottom: 0 };
    if (c.width < 50 || c.height < 50) return out;
    for (const el of document.querySelectorAll<HTMLElement>("[data-occludes]")) {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, c.right) - Math.max(r.left, c.left);
      const h = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
      if (w <= 0 || h <= 0) continue;
      if (w >= c.width * 0.7) {
        out.bottom = Math.max(out.bottom, c.bottom - Math.max(r.top, c.top));
      } else if (h >= c.height * 0.45) {
        if (r.left + r.width / 2 < c.left + c.width / 2) {
          out.left = Math.max(out.left, r.right - c.left);
        } else {
          out.right = Math.max(out.right, c.right - r.left);
        }
      }
    }
    // never leave the map less than a sliver to be framed in
    const spareX = c.width * 0.35;
    const over = out.left + out.right - (c.width - spareX);
    if (over > 0) {
      const scale = (c.width - spareX) / (out.left + out.right);
      out.left *= scale;
      out.right *= scale;
    }
    out.bottom = Math.min(out.bottom, c.height * 0.8);
    return out;
  }

  /** Shift the projection so the camera's aim lands in the middle of what
   *  the overlays leave showing. */
  function applyOffset(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 1 || height < 1) return;
    const visibleW = width - insetNow.left - insetNow.right;
    const visibleH = height - insetNow.bottom;
    const cx = insetNow.left + visibleW / 2;
    const cy = visibleH / 2;
    camera.setViewOffset(width, height, width / 2 - cx, height / 2 - cy, width, height);
  }

  // --- camera rig --------------------------------------------------------
  // Framing is computed, not guessed. ANU Acton is a long thin site —
  // Menzies sits half a kilometre south of Birch — and the space left for
  // the map is wide and short on a desktop but tall and narrow on a phone.
  // A hand-tuned distance fits one of those and crops a building off the
  // other. So: point the camera down whichever axis puts the subject's long
  // side across the visible area's long side, then solve for the distance
  // at which all of it lands inside the frustum.
  //
  // Each building as a bounding sphere: its footprint radius, plus half its
  // extruded height, plus room for the label floating above the roof.
  const spots = BUILDINGS.map((b) => ({
    at: new Vector3(b.centre[0], (b.levels * STOREY) / 2, b.centre[1]),
    radius: Math.hypot(b.radius, (b.levels * STOREY) / 2) + 30,
  }));
  const campusCentre = new Vector3(
    (Math.min(...spots.map((s) => s.at.x)) + Math.max(...spots.map((s) => s.at.x))) / 2,
    0,
    (Math.min(...spots.map((s) => s.at.z)) + Math.max(...spots.map((s) => s.at.z))) / 2,
  );
  const extentX = Math.max(...spots.map((s) => Math.abs(s.at.x - campusCentre.x)));
  const extentZ = Math.max(...spots.map((s) => Math.abs(s.at.z - campusCentre.z)));

  const ELEVATION = 0.72;
  /** Comfortably inside camera.far, so a bad fit can never blank the view. */
  const MAX_DISTANCE = 2600;

  type Sphere = { at: Vector3; radius: number };

  /** The width and height left for the map once the overlays are out. */
  function visible(insets: Insets = insetGoal): { width: number; height: number } {
    return {
      width: Math.max(1, canvas.clientWidth - insets.left - insets.right),
      height: Math.max(1, canvas.clientHeight - insets.bottom),
    };
  }

  /** The distance at which every one of these spheres lands inside the
   *  visible part of the frustum, looking at `target` from
   *  `azimuth`/`elevation`.
   *
   *  Solved by actually projecting, rather than measuring extents on the
   *  target plane: under perspective, something NEARER the camera than the
   *  centre subtends more angle, so a flat estimate lets it fall off the
   *  edge. Each pass grows the distance by however much the worst sphere
   *  overflows, which converges in a handful of iterations. */
  function solveDistance(
    spheres: Sphere[],
    target: Vector3,
    azimuth: number,
    elevation: number,
  ): number {
    const height = canvas.clientHeight;
    const room = visible();
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    // the half-angles of the visible part, not of the whole canvas
    const vHalf = (tan * room.height) / Math.max(1, height);
    const hHalf = (tan * room.width) / Math.max(1, height);
    if (!Number.isFinite(hHalf) || hHalf <= 0 || spheres.length === 0) return MAX_DISTANCE / 2;

    const offset = new Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );

    let distance = 30;
    for (let pass = 0; pass < 24; pass++) {
      const eye = target.clone().addScaledVector(offset, distance);
      const forward = target.clone().sub(eye).normalize();
      const right = new Vector3().crossVectors(forward, UP).normalize();
      const up = new Vector3().crossVectors(right, forward).normalize();

      let overflow = 0;
      for (const sphere of spheres) {
        const rel = sphere.at.clone().sub(eye);
        const depth = rel.dot(forward);
        if (depth <= sphere.radius) {
          overflow = Math.max(overflow, 2);
          continue;
        }
        const x = Math.abs(rel.dot(right)) + sphere.radius;
        const y = Math.abs(rel.dot(up)) + sphere.radius;
        overflow = Math.max(overflow, x / (depth * hHalf), y / (depth * vHalf));
      }

      if (overflow <= 1.002) break;
      distance *= Math.min(2, overflow);
    }
    // A distance beyond the far plane renders nothing at all, and an empty
    // canvas is a far worse failure than a slightly tight crop.
    return Math.min(distance, MAX_DISTANCE);
  }

  /** Azimuth and distance that fit the whole campus in the visible area. */
  function fitCampus(): { azimuth: number; distance: number } {
    const room = visible();
    const wide = room.width >= room.height;
    // put the longer ground axis along the longer screen axis
    const alongZ = extentZ > extentX;
    const azimuth = alongZ === wide ? -Math.PI / 2 : 0;
    const distance = solveDistance(spots, campusCentre, azimuth, ELEVATION);
    return { azimuth, distance: Math.min(distance * 1.04, MAX_DISTANCE) };
  }

  /** Which way to look down on a floor: along the building's own axis, so
   *  its corridor runs across a wide screen or up a tall one, and the room
   *  numbers painted on the tiles read the right way up. Returns the
   *  azimuth, and how far that turns the tiles' text from their long axis. */
  function overhead(state: SceneState): { azimuth: number; turn: number } {
    const angle = state.rooms[0]?.angle ?? 0;
    const room = visible();
    const turn = room.height > room.width * 1.05 ? Math.PI / 2 : 0;
    return { azimuth: -angle + turn, turn };
  }

  const initial = fitCampus();
  const view = {
    target: campusCentre.clone(),
    distance: initial.distance,
    azimuth: initial.azimuth,
    elevation: ELEVATION,
  };
  const goal = { ...view, target: view.target.clone() };
  let tweenUntil = 0;
  let tweenFrom = { ...view, target: view.target.clone() };
  let tweenStart = 0;

  function applyCamera(): void {
    const r = Math.max(28, view.distance);
    const e = clamp(view.elevation, 0.22, 1.45);
    camera.position.set(
      view.target.x + r * Math.cos(e) * Math.sin(view.azimuth),
      view.target.y + r * Math.sin(e),
      view.target.z + r * Math.cos(e) * Math.cos(view.azimuth),
    );
    camera.lookAt(view.target);
    fog.near = r * 1.1;
    fog.far = r * 3.2;
  }

  /** Fly the camera somewhere. With `steer`, a flight already under way
   *  just changes where it's heading instead of starting over — a panel
   *  settling mid-flight mustn't restart the storeys fanning apart. */
  function flyTo(
    target: Vector3,
    distance: number,
    elevation: number,
    ms = 900,
    azimuth = view.azimuth,
    steer = false,
  ): void {
    goal.target = target.clone();
    goal.distance = distance;
    goal.elevation = elevation;
    // take the short way round, so a reset never spins the campus
    goal.azimuth = view.azimuth + wrapAngle(azimuth - view.azimuth);
    if (!(steer && performance.now() < tweenUntil)) {
      tweenFrom = { ...view, target: view.target.clone() };
      insetFrom = { ...insetNow };
      tweenStart = performance.now();
      tweenUntil = tweenStart + ms;
    }
    request();
  }

  // --- animation ----------------------------------------------------------
  // Everything that changes between stages — storeys fanning apart, colours
  // shifting, the floors above fading out — rides the camera's flight rather
  // than snapping, so a click reads as one continuous move. Each is a
  // function of the flight's eased progress, rebuilt whenever the stage is
  // repainted (starting from wherever the last flight left things).
  let tweens: Array<(t: number) => void> = [];

  function tweenNumber(from: number, to: number, apply: (v: number) => void, animate: boolean) {
    if (!animate || from === to) {
      apply(to);
      return;
    }
    apply(from);
    tweens.push((t) => apply(lerp(from, to, t)));
  }

  function tweenColour(target: Color, to: Color, animate: boolean) {
    if (!animate) {
      target.copy(to);
      return;
    }
    const from = target.clone();
    tweens.push((t) => target.lerpColors(from, to, t));
  }

  // --- render on demand --------------------------------------------------
  let queued = false;
  let running = false;
  let drawn = false;

  let disposed = false;

  function request(): void {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    queued = false;
    running = false;
    if (disposed) return;

    if (now < tweenUntil) {
      const t = ease((now - tweenStart) / (tweenUntil - tweenStart));
      view.target.lerpVectors(tweenFrom.target, goal.target, t);
      view.distance = lerp(tweenFrom.distance, goal.distance, t);
      view.elevation = lerp(tweenFrom.elevation, goal.elevation, t);
      view.azimuth = lerp(tweenFrom.azimuth, goal.azimuth, t);
      insetNow = {
        left: lerp(insetFrom.left, insetGoal.left, t),
        right: lerp(insetFrom.right, insetGoal.right, t),
        bottom: lerp(insetFrom.bottom, insetGoal.bottom, t),
      };
      for (const tween of tweens) tween(t);
      running = true;
    } else if (tweenUntil !== 0) {
      view.target.copy(goal.target);
      view.distance = goal.distance;
      view.elevation = goal.elevation;
      view.azimuth = goal.azimuth;
      insetNow = { ...insetGoal };
      for (const tween of tweens) tween(1);
      tweens = [];
      tweenUntil = 0;
    }

    applyOffset();
    applyCamera();
    paintHighlight();
    renderer.render(scene, camera);
    if (!drawn) {
      drawn = true;
      container.dataset.ready = "";
    }
    if (running) request();
  }

  // --- sizing ------------------------------------------------------------
  function resize(): void {
    // The container is hidden until the scene is ready, and a hidden
    // element measures 0×0. Fitting the camera to that produced a distance
    // past the far plane and a black canvas, so: no layout, no decisions.
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width < 50 || height < 50) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // a phone turned on its side wants the floor turned with it, and the
    // numbers on its tiles turned back
    if (current?.mode === "floor") buildRooms(current, false);
    reframe(0);
  }

  /** set once the visitor drags or zooms, so a resize or a panel folding
   *  stops overriding where they put the camera */
  let touched = false;
  /** the state the scene is currently showing */
  let current: SceneState | undefined;

  /** Re-measure what covers the canvas and settle the camera into what's
   *  left — refitting it too, unless the visitor has taken over. */
  function reframe(ms: number): void {
    insetGoal = measureInsets();
    if (!current) {
      insetNow = { ...insetGoal };
      const fit = fitCampus();
      view.distance = fit.distance;
      view.azimuth = fit.azimuth;
      request();
      return;
    }
    if (touched) flyTo(view.target, view.distance, view.elevation, ms, view.azimuth, true);
    else frameFor(current, ms, true);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  // the panel folding and unfolding, or a dialog growing, changes what the
  // map has to work with without resizing the map itself
  const overlays = new ResizeObserver(() => {
    // it reports once on being attached, which isn't a change
    const next = measureInsets();
    const same = (["left", "right", "bottom"] as const).every(
      (edge) => Math.abs(next[edge] - insetGoal[edge]) < 1,
    );
    if (!same) reframe(350);
  });
  const onOverlays = () => reframe(450);
  window.addEventListener("map:overlays", onOverlays);

  // --- interaction -------------------------------------------------------
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const hud = container.querySelector<HTMLElement>("[data-scene-hud]");
  let hovered: Object3D | undefined;
  /** what a list row under the pointer (or focus) points at on the map:
   *  "building:<slug>", "level:<n>" or "room:<slug>" */
  let listHover: string | undefined;

  function pickables(): Object3D[] {
    if (current?.mode === "floor") return roomMeshes;
    if (current?.mode === "building") {
      // the fanned storeys, plus the other buildings, still clickable
      // through their fade as a way to hop straight across
      return allSlabs.filter((slab) => slab.visible);
    }
    return allSlabs;
  }

  function pickAt(event: PointerEvent | MouseEvent): Object3D | undefined {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickables(), false)[0]?.object;
  }

  /** Where clicking this goes. Built here from the state being painted,
   *  because a building's link depends on the date on screen. */
  function hrefFor(object: Object3D | undefined): string | undefined {
    const data = object?.userData as
      | { kind?: string; slug?: string; level?: number; href?: string }
      | undefined;
    if (!data || !current) return undefined;
    if (data.href) return data.href;
    if (data.kind !== "slab" || !data.slug) return undefined;
    const date = `?date=${current.date}`;
    if (current.mode === "building" && data.slug === current.focus) {
      return `/b/${data.slug}/${date}&floor=${data.level}`;
    }
    return `/b/${data.slug}/${date}`;
  }

  function describe(object: Object3D | undefined): string {
    const data = object?.userData as
      | { kind?: string; slug?: string; level?: number; label?: string }
      | undefined;
    if (!data) return "";
    if (data.label) return data.label;
    const building = data.slug ? parts.get(data.slug) : undefined;
    if (!building) return "";
    if (current?.mode === "building" && data.slug === current.focus) {
      const level = current.levels.find((entry) => entry.level === data.level);
      if (!level) return `Level ${data.level}`;
      return `Level ${level.level} · ${level.rooms} room${level.rooms === 1 ? "" : "s"} · ${Math.round(level.free * 100)}% free`;
    }
    const info = current?.buildings.find((entry) => entry.slug === building.slug);
    return info && current?.mode === "campus"
      ? `${building.code} — ${building.name} · ${Math.round(info.free * 100)}% free`
      : `${building.code} — ${building.name}`;
  }

  function showHud(object: Object3D | undefined): void {
    if (!hud) return;
    hud.textContent = describe(object);
    hud.hidden = !hud.textContent;
  }

  // one finger (or a mouse) orbits; two pinch; a tap that didn't move is a
  // selection
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = 0;
  let pinch: { gap: number; distance: number } | undefined;

  const gapBetween = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  let throttled = 0;
  canvas.addEventListener("pointermove", (event) => {
    const held = pointers.get(event.pointerId);
    if (held) {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      held.x = event.clientX;
      held.y = event.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pinch && pointers.size >= 2) {
        const gap = gapBetween();
        if (gap > 0) view.distance = clamp((pinch.distance * pinch.gap) / gap, 30, 3200);
      } else if (pointers.size === 1) {
        view.azimuth -= dx * 0.005;
        view.elevation = clamp(view.elevation + dy * 0.005, 0.22, 1.45);
      }
      touched = true;
      tweenUntil = 0;
      request();
      return;
    }

    const now = performance.now();
    if (now - throttled < 40) return;
    throttled = now;
    const hit = pickAt(event);
    if (hit === hovered) return;
    hovered = hit;
    canvas.style.cursor = hit ? "pointer" : "grab";
    showHud(hit);
    request();
  });

  canvas.addEventListener("pointerleave", () => {
    if (pointers.size > 0) return;
    hovered = undefined;
    showHud(undefined);
    request();
  });

  canvas.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) moved = 0;
    if (pointers.size === 2) {
      pinch = { gap: gapBetween(), distance: view.distance };
      moved += 100; // a pinch is never a tap
    }
    // capture can refuse a pointer the browser doesn't consider active
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // dragging still works without it; only the edges get sloppier
    }
    canvas.style.cursor = "grabbing";
  });

  function release(event: PointerEvent): boolean {
    const had = pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = undefined;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // nothing was captured; nothing to release
    }
    canvas.style.cursor = "grab";
    return had;
  }

  canvas.addEventListener("pointercancel", (event) => {
    release(event);
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!release(event) || pointers.size > 0 || moved > 6) return;
    const href = hrefFor(pickAt(event));
    if (href) void navigate(href);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.distance = clamp(view.distance * (1 + Math.sign(event.deltaY) * 0.12), 30, 3200);
      touched = true;
      tweenUntil = 0;
      request();
    },
    { passive: false },
  );

  // "Reset view" means the whole campus, from anywhere: inside a building it
  // goes back out to the campus stage (a real navigation, keeping the date);
  // on the campus it just puts the camera back.
  container.querySelector("[data-scene-reset]")?.addEventListener("click", () => {
    if (current && current.mode !== "campus") {
      void navigate(`/?date=${current.date}`);
      return;
    }
    touched = false;
    if (current) frameFor(current, 650);
  });

  // A row in the panel lights up the thing it names on the map, so the list
  // and the map read as one view of the same place.
  const hoverFrom = (target: EventTarget | null) =>
    (target instanceof Element ? target.closest("[data-map-hover]") : null)?.getAttribute(
      "data-map-hover",
    ) ?? undefined;
  const onListIn = (event: Event) => {
    const next = hoverFrom(event.target);
    if (next === listHover) return;
    listHover = next;
    request();
  };
  const onListOut = (event: Event) => {
    const next = hoverFrom((event as PointerEvent | FocusEvent).relatedTarget);
    if (next === listHover) return;
    listHover = next;
    request();
  };
  document.addEventListener("pointerover", onListIn);
  document.addEventListener("pointerout", onListOut);
  document.addEventListener("focusin", onListIn);
  document.addEventListener("focusout", onListOut);

  // --- painting ----------------------------------------------------------

  /** Colour, fade and position for every storey of every building, for the
   *  stage being shown. With `animate`, each change rides the next flight. */
  function paint(state: SceneState, animate: boolean): void {
    tweens = [];
    const byslug = new Map(state.buildings.map((b) => [b.slug, b]));
    const levels = new Map(state.levels.map((entry) => [entry.level, entry]));
    const inside = state.mode !== "campus";

    // Inside a building, the rest of campus is context, not competition —
    // it stays visible enough to say where you are and no more. The ground
    // recedes with it, or the path network is busier than the building you
    // came here to look at.
    tweenNumber(sceneryMaterial.opacity, inside ? 0.18 : 1, (v) => (sceneryMaterial.opacity = v), animate);
    tweenNumber(
      sceneryEdgeMaterial.opacity,
      inside ? 0.08 : 0.55,
      (v) => (sceneryEdgeMaterial.opacity = v),
      animate,
    );
    for (const material of markingMaterials) {
      tweenNumber(material.opacity, inside ? 0.3 : 1, (v) => (material.opacity = v), animate);
    }

    for (const building of parts.values()) {
      const focused = inside && state.focus === building.slug;
      const dimmed = inside && !focused;
      const identity = new Color(swatchFor(building.code).hex);

      // The building keeps its own identity colour; how free it is decides
      // how much of that colour survives. A busy building fades towards
      // stone, a free one is fully itself. The floor is at 0.42, not 0: a
      // fully-booked building still has to be recognisably ITS colour, or
      // the identity the lists teach you stops matching the map.
      const tinted = (free: number) =>
        new Color(COLOUR.spent).lerp(identity, 0.42 + free ** 1.6 * 0.58);
      const campusColour = tinted(byslug.get(building.slug)?.free ?? 0.5);

      building.slabs.forEach((slab, level) => {
        const material = slab.material as MeshStandardMaterial;
        let colour = campusColour;
        let opacity = 1;
        let edge = 0.22;
        let y = level * STOREY;

        if (dimmed) {
          // On a light ground, "dim" cannot mean "transparent" alone — a
          // pale thing on pale paper just disappears — so the rest of
          // campus goes see-through only enough to sit behind the subject.
          opacity = 0.16;
          edge = 0.05;
        } else if (state.mode === "building") {
          // each storey tinted by how free ITS rooms are, fanned apart so
          // you can see which one you want
          const entry = levels.get(level);
          colour = entry && entry.rooms > 0 ? tinted(entry.free) : new Color(COLOUR.spent);
          y = level * (STOREY + FAN);
          edge = 0.4;
        } else if (state.mode === "floor") {
          // the chosen storey is the floor the rooms stand on: pale, so the
          // tiles are what your eye lands on. The ones above it get out of
          // the way entirely; the ones below are just the building.
          y = level * (STOREY + FAN);
          colour =
            level === state.floor
              ? new Color(0xffffff).lerp(identity, 0.14)
              : new Color(COLOUR.ground).lerp(identity, 0.12);
          opacity = level > state.floor ? 0 : 1;
          edge = level > state.floor ? 0 : level === state.floor ? 0.5 : 0.14;
        }

        tweenColour(material.userData.base as Color, colour, animate);
        const outline = building.edges[level];
        tweenNumber(
          material.opacity,
          opacity,
          (v) => {
            material.opacity = v;
            material.depthWrite = v > 0.99;
            slab.visible = v > 0.005;
            if (outline) outline.visible = slab.visible;
          },
          animate,
        );
        tweenNumber(
          slab.position.y,
          y,
          (v) => {
            slab.position.y = v;
            if (outline) outline.position.y = v;
          },
          animate,
        );
        if (outline) {
          const lines = outline.material as LineBasicMaterial;
          tweenNumber(lines.opacity, edge, (v) => (lines.opacity = v), animate);
        }
      });

      const fanned = state.mode !== "campus" && focused;
      const top = building.levels * (fanned ? STOREY + FAN : STOREY);
      const label = building.label;
      const labelMaterial = label.material as SpriteMaterial;
      label.visible = state.mode === "campus" || (state.mode === "building" && focused);
      tweenNumber(label.position.y, top + 26, (v) => (label.position.y = v), animate);
      labelMaterial.opacity = dimmed ? 0.18 : 0.95;
    }

    buildLevelTags(state);
  }

  /** "L2 · 63%" hung on each fanned storey of the building you're in. */
  function buildLevelTags(state: SceneState): void {
    for (const child of [...levelTags.children]) {
      levelTags.remove(child);
      disposeDeep(child);
    }
    if (state.mode !== "building" || !state.focus) return;
    const building = parts.get(state.focus);
    if (!building) return;
    for (const entry of state.levels) {
      const text =
        entry.rooms === 0 ? `L${entry.level}` : `L${entry.level} · ${Math.round(entry.free * 100)}%`;
      const tag = makeLabel(text, 0.03);
      // just above the storey's roof, in the gap the fan opens, so it
      // reads as sitting on that floor rather than floating between two
      tag.position.set(building.centre.x, plateTop(entry.level) + 2.5, building.centre.z);
      levelTags.add(tag);
    }
  }

  /** Hover, in daylight: the thing under the pointer — or named by the list
   *  row under it — lifts towards white rather than glowing, because
   *  nothing else in this scene emits light. Laid over the animated base
   *  colour every frame, so it never fights a flight in progress. */
  function paintHighlight(): void {
    const data = hovered?.userData as { kind?: string; slug?: string; level?: number } | undefined;
    const mode = current?.mode;

    for (const building of parts.values()) {
      const focused = mode !== "campus" && current?.focus === building.slug;
      building.slabs.forEach((slab, level) => {
        const material = slab.material as MeshStandardMaterial;
        material.color.copy(material.userData.base as Color);
        const onThis = data?.kind === "slab" && data.slug === building.slug;
        const lit =
          mode === "campus"
            ? onThis || listHover === `building:${building.slug}`
            : mode === "building" && focused
              ? (onThis && data?.level === level) || listHover === `level:${level}`
              : !focused && onThis;
        if (lit) material.color.lerp(WHITE, 0.32);
      });
    }

    // with a room's dialog open, the rest of the floor steps back a little
    // so the one you're reading about is the one you see
    const selected = current?.selected;
    for (const mesh of roomMeshes) {
      const material = mesh.material as MeshStandardMaterial;
      material.color.copy(material.userData.base as Color);
      const lit = mesh === hovered || listHover === `room:${mesh.userData.slug as string}`;
      if (lit) material.color.lerp(WHITE, 0.34);
      else if (selected && mesh.userData.slug !== selected) material.color.lerp(PAPER, 0.4);
    }
  }

  /** The tiles for the floor being looked down on. Rebuilt only when what
   *  they show changes; a selection just lifts one. */
  function buildRooms(state: SceneState, animate: boolean): void {
    const parent = state.focus ? parts.get(state.focus) : undefined;
    const { turn } = overhead(state);
    const signature =
      state.mode === "floor" && parent
        ? JSON.stringify([state.focus, state.floor, state.date, turn, state.rooms])
        : "";

    if (signature !== roomsBuiltFor) {
      roomsBuiltFor = signature;
      for (const child of [...roomGroup.children]) {
        roomGroup.remove(child);
        disposeDeep(child);
      }
      roomMeshes = [];
      if (!signature || !parent) return;

      const identity = new Color(swatchFor(parent.code).hex);
      const y = plateTop(state.floor);

      for (const room of state.rooms) {
        // A room keeps its building's colour and loses saturation as it
        // fills up; a room you hold is inked, which no hue in the palette is.
        const tint = room.yours
          ? new Color(COLOUR.mine)
          : new Color(COLOUR.spent).lerp(identity, 0.45 + room.free ** 1.5 * 0.55);
        const material = new MeshStandardMaterial({
          color: tint,
          roughness: 0.55,
          metalness: 0,
          transparent: true,
          opacity: animate ? 0 : 1,
        });
        material.userData.base = tint.clone();

        const mesh = new Mesh(new BoxGeometry(room.w, ROOM_HEIGHT, room.d), material);
        mesh.position.set(room.cx, y + ROOM_HEIGHT / 2, room.cz);
        mesh.rotation.y = -room.angle;
        mesh.userData = {
          kind: "room",
          slug: room.slug,
          href: `/b/${state.focus}/${room.slug}/?date=${state.date}`,
          label: `${room.code} — ${room.capacity} seats — ${Math.round(room.free * 24) / 2} h free`,
        };

        const number = room.code.split(" ").pop() ?? room.code;
        const tag = roomTag(number, `${room.capacity} seats`, room.w, room.d, turn, luminance(tint) > 0.2);
        tag.position.y = ROOM_HEIGHT / 2 + 0.05;
        mesh.add(tag);

        // drawn only on the room whose dialog is open
        const ring = new LineSegments(
          new EdgesGeometry(mesh.geometry),
          new LineBasicMaterial({ color: COLOUR.mine, transparent: true, opacity: 0.9 }),
        );
        ring.visible = false;
        ring.userData.ring = true;
        mesh.add(ring);

        roomGroup.add(mesh);
        roomMeshes.push(mesh);
      }

      if (animate) {
        tweens.push((t) => {
          for (const mesh of roomMeshes) {
            (mesh.material as MeshStandardMaterial).opacity = t;
            mesh.traverse((child) => {
              const m = (child as Mesh).material as MeshBasicMaterial | undefined;
              if (child !== mesh && m && !child.userData.ring) m.opacity = t;
            });
          }
        });
      }
    }

    // the open room stands up off the floor and gets an inked edge
    const y = plateTop(state.floor) + ROOM_HEIGHT / 2;
    for (const mesh of roomMeshes) {
      const chosen = mesh.userData.slug === state.selected;
      for (const child of mesh.children) if (child.userData.ring) child.visible = chosen;
      tweenNumber(mesh.position.y, y + (chosen ? ROOM_LIFT : 0), (v) => (mesh.position.y = v), animate);
    }
  }

  function frameFor(state: SceneState, ms = 900, steer = false): void {
    const building = state.focus ? parts.get(state.focus) : undefined;

    if (state.mode === "floor" && building) {
      const { azimuth } = overhead(state);
      const y = plateTop(state.floor);
      // the whole storey: every corner of its real outline in frame
      const outline = building.plan.map(([x, z]) => ({ at: new Vector3(x, y, z), radius: 2 }));
      const middle = new Vector3(building.centre.x, y, building.centre.z);
      const whole = solveDistance(outline, middle, azimuth, OVERHEAD) * 1.03;
      const chosen = state.rooms.find((room) => room.slug === state.selected);
      if (chosen) {
        // Close in on the open room, but only so far: its neighbours stay
        // in shot, so you can see where on the floor it is and pick the
        // next one along without closing anything.
        const at = new Vector3(chosen.cx, y, chosen.cz);
        const radius = Math.max(16, Math.hypot(chosen.w, chosen.d) * 2);
        const near = solveDistance([{ at, radius }], at, azimuth, OVERHEAD);
        flyTo(at, Math.max(near, whole * 0.55), OVERHEAD, ms, azimuth, steer);
        return;
      }
      flyTo(middle, whole, OVERHEAD, ms, azimuth, steer);
      return;
    }

    if (state.mode === "building" && building) {
      // A fanned building is much taller than it is wide — five storeys
      // pulled apart is nearly 100 m of scene — so the distance is solved
      // against the whole fan rather than guessed from the footprint.
      const fanned = building.levels * (STOREY + FAN);
      const middle = new Vector3(building.centre.x, fanned / 2, building.centre.z);
      const sphere = { at: middle, radius: Math.hypot(building.radius, fanned / 2) + 14 };
      const distance = solveDistance([sphere], middle, view.azimuth, FANNED) * 0.9;
      flyTo(middle, distance, FANNED, ms, view.azimuth, steer);
      return;
    }

    const fit = fitCampus();
    flyTo(campusCentre.clone(), fit.distance, ELEVATION, ms, fit.azimuth, steer);
  }

  // --- live updates ------------------------------------------------------
  // A booking made in another tab re-tints this one: the building on the
  // campus, and the room tile if you're looking down on its floor. The
  // panel's lists update on the next navigation; the map updates now.
  const events = new EventSource("/api/events");
  events.addEventListener("message", (event) => {
    try {
      const booking = JSON.parse((event as MessageEvent<string>).data) as {
        type: "booked" | "cancelled";
        roomCode: string;
        buildingSlug: string;
        date: string;
        startSlot: number;
        endSlot: number;
      };
      if (!current || booking.date !== current.date) return;
      const sign = booking.type === "cancelled" ? 1 : -1;
      const slots = Math.max(0, booking.endSlot - booking.startSlot);

      const entry = current.buildings.find((b) => b.slug === booking.buildingSlug);
      if (entry && entry.matching > 0) {
        entry.free = clamp(entry.free + (sign * slots) / (entry.matching * 24), 0, 1);
      }
      const room = current.rooms.find((r) => r.code === booking.roomCode);
      if (room && current.focus === booking.buildingSlug) {
        room.free = clamp(room.free + (sign * slots) / 24, 0, 1);
      }
      paint(current, false);
      buildRooms(current, false);
      request();
    } catch {
      // a malformed frame is not worth breaking the view over
    }
  });

  resize();

  return {
    update(state: SceneState): void {
      const changedView =
        current?.mode !== state.mode ||
        current?.focus !== state.focus ||
        current?.floor !== state.floor ||
        current?.selected !== state.selected;
      const first = current === undefined;
      current = state;

      // what covers the canvas is new with every page
      overlays.disconnect();
      for (const el of document.querySelectorAll("[data-occludes]")) overlays.observe(el);
      insetGoal = measureInsets();
      if (first) insetNow = { ...insetGoal };

      const animate = changedView && !first;
      paint(state, animate);
      buildRooms(state, animate);
      if (changedView) {
        touched = false;
        hovered = undefined;
        showHud(undefined);
        frameFor(state, first ? 0 : 900);
      }
      request();
    },
    dispose(): void {
      disposed = true;
      events.close();
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("map:overlays", onOverlays);
      document.removeEventListener("pointerover", onListIn);
      document.removeEventListener("pointerout", onListOut);
      document.removeEventListener("focusin", onListIn);
      document.removeEventListener("focusout", onListOut);
      renderer.dispose();
      // browsers cap live WebGL contexts; don't wait for GC to free this one
      renderer.forceContextLoss();
    },
  };
}

/** Relative luminance of a (linear) colour, for picking ink that reads on it. */
function luminance(colour: Color): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/** A room's number painted flat on its tile, facing up.
 *
 *  The tile is rotated to its building's corridor, and the camera looks
 *  down along that same axis — turned a quarter on a tall screen, so the
 *  building runs up the phone. `turn` is that quarter: the text is turned by
 *  it within the tile, so it always reads left to right on screen. */
function roomTag(
  text: string,
  sub: string,
  w: number,
  d: number,
  turn: number,
  dark: boolean,
): Group {
  const sideways = Math.abs(Math.sin(turn)) > 0.5;
  const across = (sideways ? d : w) * 0.92;
  const down = (sideways ? w : d) * 0.92;
  const PX = 56; // texture pixels per metre
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(clamp(across * PX, 48, 640));
  canvas.height = Math.round(clamp(down * PX, 48, 640));
  const ctx = canvas.getContext("2d");
  const family = "ui-monospace, SFMono-Regular, Menlo, monospace";
  if (ctx) {
    let size = Math.min(canvas.height * 0.4, (canvas.width * 0.86) / (text.length * 0.62));
    ctx.font = `700 ${size}px ${family}`;
    const fits = ctx.measureText(text).width;
    if (fits > canvas.width * 0.86) size *= (canvas.width * 0.86) / fits;
    const withSub = canvas.height > size * 2.5;
    const subSize = Math.min(size * 0.5, (canvas.width * 0.9) / (sub.length * 0.62));

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = dark ? "#1b1813" : "#ffffff";
    ctx.font = `700 ${size}px ${family}`;
    const middle = canvas.height / 2 - (withSub ? subSize * 0.6 : 0);
    ctx.fillText(text, canvas.width / 2, middle);
    if (withSub) {
      ctx.globalAlpha = 0.78;
      ctx.font = `600 ${subSize}px ${family}`;
      ctx.fillText(sub, canvas.width / 2, middle + size * 0.5 + subSize * 0.75);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const geometry = new PlaneGeometry(across, down);
  geometry.rotateX(-Math.PI / 2);
  const plane = new Mesh(
    geometry,
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  const holder = new Group();
  holder.rotation.y = turn;
  holder.add(plane);
  return holder;
}

// --- geometry helpers ------------------------------------------------------

/** A closed ring, as an extruded solid standing on the ground plane.
 *  The shape is built in XY with y = -worldZ so that rotating it flat maps
 *  it back onto world XZ the right way round, with the extrusion going up. */
function extrude(ring: Ring, height: number): ExtrudeGeometry | undefined {
  if (ring.length < 3) return undefined;
  const shape = new Shape();
  shape.moveTo(ring[0][0], -ring[0][1]);
  for (const [x, z] of ring.slice(1)) shape.lineTo(x, -z);
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function mergeExtrusions(
  items: Array<{ ring: Ring; height: number }>,
): BufferGeometry | undefined {
  const parts = items
    .map((item) => extrude(item.ring, item.height))
    .filter((g): g is ExtrudeGeometry => g !== undefined);
  if (parts.length === 0) return undefined;
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/** A polyline widened into a flat ribbon lying on the ground.
 *
 *  `taper` narrows the ribbon to nothing over that many metres at each end.
 *  It exists for Sullivans Creek: a constant-width blue band running from
 *  one edge of the canvas to the other reads as a river escaping the map,
 *  where one that thins away reads as a river carrying on past it. Roads
 *  get a gentler version of the same treatment. */
function ribbon(points: Ring, width: number, y: number, taper = 0): BufferGeometry | undefined {
  if (points.length < 2) return undefined;
  const half = width / 2;
  const vertices: number[] = [];
  const indices: number[] = [];

  // distance along the line to each point, for the taper
  const along: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    along.push(
      along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]),
    );
  }
  const total = along[along.length - 1];

  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - previous[0];
    let dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    // normal in the ground plane, narrowed towards either end
    const ends = taper > 0 ? Math.min(1, Math.min(along[i], total - along[i]) / taper) : 1;
    const scaled = half * (0.12 + 0.88 * ends);
    const nx = -dz * scaled;
    const nz = dx * scaled;
    vertices.push(points[i][0] + nx, y, points[i][1] + nz);
    vertices.push(points[i][0] - nx, y, points[i][1] - nz);
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mergeRibbons(
  lines: Ring[],
  width: number,
  y: number,
  taper = 0,
): BufferGeometry | undefined {
  const parts = lines
    .map((line) => ribbon(line, width, y, taper))
    .filter((g): g is BufferGeometry => g !== undefined);
  if (parts.length === 0) return undefined;
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/** Concatenate position/normal-only geometries. three ships a utility for
 *  this in its addons, but it insists every input carry identical attribute
 *  sets — ours do, and doing it here keeps the addon out of the bundle. */
function mergeGeometries(parts: BufferGeometry[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];

  for (const part of parts) {
    const indexed = part.index ? part.toNonIndexed() : part;
    const position = indexed.getAttribute("position");
    if (!indexed.getAttribute("normal")) indexed.computeVertexNormals();
    const normal = indexed.getAttribute("normal");
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
    if (indexed !== part) indexed.dispose();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  return geometry;
}

/** A tag drawn to a canvas and hung in the scene: a building's code above
 *  its roof, a level's number on its storey. `height` is a fraction of the
 *  viewport's height. */
function makeLabel(text: string, height = 0.036): Sprite {
  const scale = 4;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const font = `600 ${13 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  if (context) {
    context.font = font;
    canvas.width = Math.ceil(context.measureText(text).width) + 20 * scale;
    canvas.height = 26 * scale;
  }
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = font;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 8 * scale);
    ctx.fill();
    ctx.strokeStyle = "rgba(27,24,19,0.22)";
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();
    ctx.fillStyle = "#1b1813";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + scale);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // sizeAttenuation off: the label keeps the same size on screen however far
  // away the camera is, so a code is as readable on a 390 px phone framing
  // the whole campus as it is zoomed into one building.
  const sprite = new Sprite(
    new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: false,
    }),
  );
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function disposeDeep(object: Object3D): void {
  object.traverse((child) => {
    const mesh = child as Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
}


const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
/** the equivalent angle in (-π, π], so a turn never goes the long way */
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
