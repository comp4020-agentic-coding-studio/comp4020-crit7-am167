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

// ANU Acton, extruded.
//
// Real OpenStreetMap footprints pushed up by their real storey count, tinted
// by how free each building's rooms are. Click one and the camera flies in
// while the page navigates underneath; its floors fan apart and the rooms on
// the chosen level appear as boxes you can click.
//
// Two decisions worth knowing about:
//
// 1. IT RENDERS ON DEMAND. There is no unconditional requestAnimationFrame
//    loop — a frame is drawn when something changes (a camera tween, a hover,
//    a live booking) and then the loop stops. That keeps a phone's battery
//    and a Fly machine's CPU out of it, and it means a screenshot tool isn't
//    racing a canvas that repaints forever.
//
// 2. IT IS NEVER THE ONLY WAY. Every building and room here is also a link
//    in the server-rendered page. This file can fail to load and nothing is
//    lost but the spectacle.

export type SceneState = {
  mode: "campus" | "building";
  date: string;
  focus: string | null;
  floor: number;
  buildings: Array<{ slug: string; free: number; matching: number; yours: number }>;
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
const ROOM_HEIGHT = 5;
/** hover lifts a surface towards this rather than making it glow */
const WHITE = /* @__PURE__ */ (() => new Color(0xffffff))();

/** How far the floors drift apart in building mode. */
const FAN = 11;

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
  scene.fog = new Fog(COLOUR.ground, 1000, 3000);

  // A near plane of 1 against a far plane of 4000 throws away almost all
  // the depth buffer on space the camera never occupies — which showed up
  // as the ground markings flickering against each other while panning,
  // because 0.02 of world separation stopped being resolvable out at 800
  // units. The camera is clamped to 40 units away at closest, so 6 is
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

  // Ground markings, drawn bottom-up so a road crosses a footpath rather
  // than the other way round, and each one a hair above the last so they
  // don't z-fight on a flat plane.
  // Ground markings, drawn bottom-up so a road crosses a footpath rather
  // than the other way round, each a hair above the last so they don't
  // z-fight. DoubleSide because a ribbon's winding depends on which way the
  // way was drawn in OSM, and a back-facing road is an invisible one.
  // Ground markings, drawn bottom-up so the thing that should win a
  // crossing is drawn last. Each sits a hair above the one below so they
  // don't z-fight on a flat plane. DoubleSide because a ribbon's winding
  // follows however the way was drawn in OSM, and a back-facing road is an
  // invisible one.
  //
  // Footpaths get a casing — a slightly wider, darker ribbon underneath a
  // pale one — which is how paper maps make a thin line readable without
  // making it thick. A flat 3 px line on warm paper just disappears.
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
    group: Group;
    /** one slab per storey, so they can fan apart */
    slabs: Mesh[];
    edges: LineSegments[];
    label: Sprite;
  };

  const parts = new Map<string, BuildingParts>();
  const pickableBuildings: Object3D[] = [];

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
      const slab = new Mesh(geometry, material);
      slab.position.y = level * STOREY;
      slab.userData = { slug: building.slug, level };
      group.add(slab);
      slabs.push(slab);
      pickableBuildings.push(slab);

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
      group,
      slabs,
      edges,
      label,
    });
  }

  // --- rooms, built and torn down as the floor changes -------------------
  const roomGroup = new Group();
  world.add(roomGroup);
  let pickableRooms: Object3D[] = [];

  // --- camera rig --------------------------------------------------------
  // Framing the campus is computed, not guessed. ANU Acton is a long thin
  // site — Menzies sits half a kilometre south of Birch — and the canvas is
  // wide and short on a desktop but tall and narrow on a phone. A hand-
  // tuned distance fits one of those and crops a building off the other.
  //
  // So: point the camera down whichever axis puts the campus's long side
  // across the screen's long side, then solve for the distance at which
  // every bookable building lands inside the frustum.
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

  /** The distance at which every one of these spheres lands inside the
   *  frustum, looking at `target` from `azimuth`/`elevation`.
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
    const vHalf = Math.tan((camera.fov * Math.PI) / 360);
    const hHalf = vHalf * camera.aspect;
    if (!Number.isFinite(hHalf) || hHalf <= 0 || spheres.length === 0) return MAX_DISTANCE / 2;

    const offset = new Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );

    let distance = 60;
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
    return distance;
  }

  /** Azimuth and distance that fit the whole campus at the current aspect. */
  function fitCampus(): { azimuth: number; distance: number } {
    const wide = canvas.clientWidth >= canvas.clientHeight;
    // put the longer ground axis along the longer screen axis
    const alongZ = extentZ > extentX;
    const azimuth = alongZ === wide ? -Math.PI / 2 : 0;
    const distance = solveDistance(spots, campusCentre, azimuth, ELEVATION);

    // A distance beyond the far plane renders nothing at all, and an empty
    // canvas is a far worse failure than a slightly tight crop.
    return { azimuth, distance: Math.min(distance * 1.04, MAX_DISTANCE) };
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
  }

  function flyTo(
    target: Vector3,
    distance: number,
    elevation: number,
    ms = 900,
    azimuth = view.azimuth,
  ): void {
    tweenFrom = { ...view, target: view.target.clone() };
    goal.target = target.clone();
    goal.distance = distance;
    goal.elevation = elevation;
    // take the short way round, so a reset never spins the campus
    goal.azimuth = view.azimuth + wrapAngle(azimuth - view.azimuth);
    tweenStart = performance.now();
    tweenUntil = tweenStart + ms;
    request();
  }

  // --- render on demand --------------------------------------------------
  let queued = false;
  let running = false;

  function request(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    queued = false;
    running = false;

    if (now < tweenUntil) {
      const t = ease((now - tweenStart) / (tweenUntil - tweenStart));
      view.target.lerpVectors(tweenFrom.target, goal.target, t);
      view.distance = lerp(tweenFrom.distance, goal.distance, t);
      view.elevation = lerp(tweenFrom.elevation, goal.elevation, t);
      view.azimuth = lerp(tweenFrom.azimuth, goal.azimuth, t);
      running = true;
    } else if (tweenUntil !== 0) {
      view.target.copy(goal.target);
      view.distance = goal.distance;
      view.elevation = goal.elevation;
      view.azimuth = goal.azimuth;
      tweenUntil = 0;
    }

    applyCamera();
    renderer.render(scene, camera);
    if (running) request();
  }

  // --- sizing ------------------------------------------------------------
  function resize(): void {
    // The container is hidden until the scene is ready, and a hidden
    // element measures 0×0. Fitting the camera to that produced a distance
    // past the far plane and a black canvas, so: no layout, no decisions.
    const width = container.clientWidth;
    if (width < 50) return;
    const height = Math.max(
      260,
      Math.min(
        Math.round(window.innerHeight * 0.62),
        Math.round(width * (window.innerWidth < 760 ? 1.15 : 0.52)),
      ),
    );
    renderer.setSize(width, height, false);
    canvas.style.width = "100%";
    canvas.style.height = `${height}px`;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // the fit depends on the aspect, so a resize re-frames — but only while
    // the visitor hasn't taken the camera somewhere themselves
    if (current?.mode !== "building" && !touched) {
      const fit = fitCampus();
      view.distance = fit.distance;
      view.azimuth = fit.azimuth;
      view.target.copy(campusCentre);
      view.elevation = ELEVATION;
      // drop any flight still aimed using the previous aspect, or it will
      // lerp the camera straight back to where it no longer belongs
      tweenUntil = 0;
    }
    request();
  }

  /** set once the visitor drags or zooms, so a resize stops overriding
   *  where they put the camera */
  let touched = false;
  /** the state the scene is currently showing */
  let current: SceneState | undefined;

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // --- interaction -------------------------------------------------------
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const hud = container.querySelector<HTMLElement>("[data-scene-hud]");
  let hovered: Object3D | undefined;

  function pickAt(event: PointerEvent | MouseEvent): Object3D | undefined {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets = current?.mode === "building" ? pickableRooms : pickableBuildings;
    return raycaster.intersectObjects(targets, false)[0]?.object;
  }

  let throttled = 0;
  canvas.addEventListener("pointermove", (event) => {
    if (dragging) return;
    const now = performance.now();
    if (now - throttled < 40) return;
    throttled = now;

    const hit = pickAt(event);
    if (hit === hovered) return;
    hovered = hit;
    canvas.style.cursor = hit ? "pointer" : "grab";
    showHud(hit);
    paintHighlight();
    request();
  });

  canvas.addEventListener("pointerleave", () => {
    hovered = undefined;
    showHud(undefined);
    paintHighlight();
    request();
  });

  function showHud(object: Object3D | undefined): void {
    if (!hud) return;
    const data = object?.userData as { label?: string; slug?: string } | undefined;
    if (!data) {
      hud.hidden = true;
      return;
    }
    const building = data.slug ? parts.get(data.slug) : undefined;
    hud.textContent = data.label ?? (building ? `${building.code} — ${building.name}` : "");
    hud.hidden = !hud.textContent;
  }

  // drag to orbit; a click that didn't drag is a selection
  let dragging = false;
  let moved = 0;
  let last = { x: 0, y: 0 };

  canvas.style.touchAction = "pan-y";
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = 0;
    last = { x: event.clientX, y: event.clientY };
    // capture can refuse a pointer the browser doesn't consider active
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // dragging still works without it; only the edges get sloppier
    }
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointerup", (event) => {
    dragging = false;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // nothing was captured; nothing to release
    }
    canvas.style.cursor = "grab";
    if (moved > 6) return;

    const hit = pickAt(event);
    const data = hit?.userData as { slug?: string; href?: string } | undefined;
    if (!data) return;

    // A room box knows its own URL. A building doesn't: its destination
    // depends on the date being shown, which changes under it — so the
    // link is built here from the state the scene is currently painting.
    const href =
      data.href ?? (data.slug ? `/b/${data.slug}/?date=${current?.date ?? ""}` : undefined);
    if (href) void navigate(href);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy);
    last = { x: event.clientX, y: event.clientY };
    view.azimuth -= dx * 0.005;
    view.elevation = clamp(view.elevation + dy * 0.005, 0.22, 1.45);
    touched = true;
    tweenUntil = 0;
    request();
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.distance = clamp(view.distance * (1 + Math.sign(event.deltaY) * 0.12), 40, 3200);
      touched = true;
      tweenUntil = 0;
      request();
    },
    { passive: false },
  );

  container.querySelector("[data-scene-reset]")?.addEventListener("click", () => {
    touched = false;
    if (current) frameFor(current, 650);
  });

  // --- painting ----------------------------------------------------------

  /** Slab colour: cool where the building is free, dim where it's taken,
   *  hot where you already have a room in it. */
  function paint(state: SceneState): void {
    const byslug = new Map(state.buildings.map((b) => [b.slug, b]));
    const inside = state.mode === "building";

    // Inside a building, the rest of campus is context, not competition —
    // it stays visible enough to say where you are and no more.
    sceneryMaterial.opacity = inside ? 0.18 : 1;
    // the ground recedes with the rest of campus, or the path network is
    // busier than the building you came here to look at
    for (const material of markingMaterials) material.opacity = inside ? 0.3 : 1;
    sceneryEdgeMaterial.opacity = inside ? 0.08 : 0.55;

    for (const building of parts.values()) {
      const focused = state.mode === "building" && state.focus === building.slug;
      const info = byslug.get(building.slug);
      const free = info?.free ?? 0.5;
      const dimmed = state.mode === "building" && !focused;

      // The building keeps its own identity colour; how free it is decides
      // how much of that colour survives. A busy building fades towards
      // stone, a free one is fully itself. Squaring the ratio spreads the
      // busy end of the range, which is the end you care about.
      const heat = free ** 1.6;
      const identity = new Color(swatchFor(building.code).hex);
      // Inside a building, the storey slabs are the floor you stand on, not
      // the subject: they go pale so the room boxes on them are what your
      // eye lands on.
      // The floor is at 0.42, not 0: a fully-booked building still has to be
      // recognisably ITS colour, or the identity the cards teach you stops
      // matching the map. Busy reads as duller, never as a different
      // building.
      const colour = new Color(state.mode === "building" ? 0xffffff : COLOUR.spent).lerp(
        identity,
        state.mode === "building" ? (focused ? 0.3 : 0.1) : 0.42 + heat * 0.58,
      );

      building.slabs.forEach((slab, level) => {
        const material = slab.material as MeshStandardMaterial;
        const chosen = focused && level === state.floor;

        // On a light ground, "dim" cannot mean "transparent" — a pale thing
        // on pale paper just disappears. The storeys you're not looking at
        // stay solid and simply lose their colour; only the rest of campus
        // goes see-through, and then only enough to sit behind the subject.
        const shown = chosen
          ? colour
          : focused
            ? new Color(COLOUR.ground).lerp(identity, 0.1)
            : colour;
        material.userData.base = shown.clone();
        material.color.copy(shown);
        material.opacity = dimmed ? 0.16 : 1;
        material.depthWrite = !dimmed;

        // the fan: in building mode the focused building's storeys drift
        // apart so you can see into the one you're looking at
        const spread = focused ? FAN : 0;
        const lift = chosen ? 2.5 : 0;
        slab.position.y = level * (STOREY + spread) + lift;
        const outline = building.edges[level];
        if (outline) {
          outline.position.y = slab.position.y;
          (outline.material as LineBasicMaterial).opacity = dimmed ? 0.05 : chosen ? 0.5 : 0.22;
        }
      });

      const top = building.levels * (focused ? STOREY + FAN : STOREY);
      building.label.position.y = top + 26;
      (building.label.material as SpriteMaterial).opacity = dimmed ? 0.18 : 0.95;
      building.label.visible = state.mode === "campus" || focused;
    }

    paintHighlight();
  }

  /** Hover, in daylight: the thing under the pointer lifts towards white
   *  rather than glowing, because nothing else in this scene emits light. */
  function paintHighlight(): void {
    const data = hovered?.userData as { slug?: string } | undefined;

    for (const building of parts.values()) {
      const lit = data?.slug === building.slug && current?.mode === "campus";
      for (const slab of building.slabs) {
        const material = slab.material as MeshStandardMaterial;
        const base = material.userData.base as Color | undefined;
        if (base) material.color.copy(base);
        if (lit) material.color.lerp(WHITE, 0.32);
      }
    }

    for (const mesh of pickableRooms) {
      const material = (mesh as Mesh).material as MeshStandardMaterial;
      const base = material.userData.base as Color | undefined;
      if (base) material.color.copy(base);
      if (mesh === hovered) material.color.lerp(WHITE, 0.34);
    }
  }

  /** Build the room boxes for the floor being shown. */
  function buildRooms(state: SceneState): void {
    for (const child of [...roomGroup.children]) {
      roomGroup.remove(child);
      disposeDeep(child);
    }
    pickableRooms = [];
    if (state.mode !== "building" || !state.focus) return;

    const parent = parts.get(state.focus);
    if (!parent) return;
    const building = { code: parent.code };
    const y = state.floor * (STOREY + FAN) + 2.5 + STOREY * 0.94;

    for (const room of state.rooms) {
      const geometry = new BoxGeometry(room.w, ROOM_HEIGHT, room.d);
      // A room keeps its building's colour and loses saturation as it fills
      // up; a room you hold is inked, which no hue in the palette is.
      const tint = room.yours
        ? new Color(COLOUR.mine)
        : new Color(COLOUR.spent).lerp(
            new Color(swatchFor(building.code).hex),
            0.45 + room.free ** 1.5 * 0.55,
          );
      const material = new MeshStandardMaterial({
        color: tint,
        roughness: 0.5,
        metalness: 0,
      });
      material.userData.base = tint.clone();

      const mesh = new Mesh(geometry, material);
      mesh.position.set(room.cx, y + ROOM_HEIGHT / 2, room.cz);
      mesh.rotation.y = -room.angle;
      mesh.userData = {
        href: `/b/${state.focus}/${room.slug}/?date=${state.date}`,
        label: `${room.code} — ${room.capacity} seats — ${Math.round(room.free * 100)}% free`,
      };
      roomGroup.add(mesh);
      pickableRooms.push(mesh);
    }
  }

  function frameFor(state: SceneState, ms = 900): void {
    if (state.mode === "building" && state.focus) {
      const building = parts.get(state.focus);
      if (building) {
        // A fanned building is much taller than it is wide — five storeys
        // pulled apart is nearly 100 m of scene — so the distance is solved
        // against the whole fan rather than guessed from the footprint.
        const fanned = building.levels * (STOREY + FAN);
        const middle = new Vector3(building.centre.x, fanned / 2, building.centre.z);
        const elevation = 0.5;
        const sphere = {
          at: middle,
          radius: Math.hypot(building.radius, fanned / 2) + 18,
        };
        // a touch tighter than a perfect fit: the building is the subject
        const distance = solveDistance([sphere], middle, view.azimuth, elevation) * 0.88;
        // look slightly above the chosen storey, not at the building's waist
        const look = new Vector3(
          building.centre.x,
          state.floor * (STOREY + FAN) + STOREY,
          building.centre.z,
        );
        flyTo(look.lerp(middle, 0.45), distance, elevation, ms);
        return;
      }
    }
    const fit = fitCampus();
    flyTo(campusCentre.clone(), fit.distance, ELEVATION, ms, fit.azimuth);
  }

  // --- live updates ------------------------------------------------------
  // A booking made in another tab re-tints this one. The page's own lists
  // update on the next navigation; the map updates now.
  const events = new EventSource("/api/events");
  events.addEventListener("message", (event) => {
    try {
      const booking = JSON.parse((event as MessageEvent<string>).data) as {
        buildingSlug: string;
        date: string;
      };
      if (!current || booking.date !== current.date) return;
      const entry = current.buildings.find((b) => b.slug === booking.buildingSlug);
      if (entry) {
        // nudge the tint without a round trip; the next navigation carries
        // the exact figure
        entry.free = clamp(entry.free + (booking.date ? -0.01 : 0.01), 0, 1);
      }
      paint(current);
      request();
    } catch {
      // a malformed frame is not worth breaking the view over
    }
  });

  return {
    update(state: SceneState): void {
      const changedView =
        current?.mode !== state.mode ||
        current?.focus !== state.focus ||
        current?.floor !== state.floor;
      current = state;
      buildRooms(state);
      paint(state);
      if (changedView) frameFor(state);
      request();
    },
    dispose(): void {
      events.close();
      observer.disconnect();
      renderer.dispose();
    },
  };
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

/** A building code, drawn to a canvas and hung above the roof. */
function makeLabel(text: string): Sprite {
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
  const height = 0.036; // a fraction of the viewport height
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
