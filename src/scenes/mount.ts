import type { Theme } from "../lib/theme";
import type { SceneState } from "./campus";

// Mounting the 3D campus, and deciding whether to mount it at all.
//
// The scene is enhancement: every page it appears on is already complete
// without it. So this bails out quietly — leaving the container hidden and
// the server-rendered lists, floor plan and dialog laid out as an ordinary
// page — whenever the scene would be unwelcome or impossible:
//
//   * the visitor asked for reduced motion
//   * the browser can't give us a WebGL context
//   * three.js fails to load at all
//
// Astro's ClientRouter re-runs this on every navigation (astro:page-load),
// while transition:persist keeps the canvas itself alive across the swap.
// That's the zoom: the page really navigates, the scene really doesn't.

type Scene = {
  update(state: SceneState): void;
  dispose(): void;
};

declare global {
  interface Window {
    __campusScene?: Scene | "loading" | "unavailable";
  }
}

/** The theme on screen: a choice if someone made one, else the device's. */
function themeNow(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** the theme the live scene was built in */
let builtIn: Theme | undefined;

/** The container the live scene draws into. transition:persist carries it
 *  across a navigation only when BOTH pages have one: pass through a page
 *  without the map (sign-in, My bookings, About) and the router drops it, so
 *  the next map page arrives with a fresh container — and a scene still
 *  drawing into the old, detached canvas, invisibly, forever. */
let mountedOn: HTMLElement | undefined;

function release(): void {
  if (typeof window.__campusScene === "object") window.__campusScene.dispose();
  window.__campusScene = undefined;
  mountedOn = undefined;
}

function readState(): SceneState | undefined {
  const tag = document.querySelector("script[data-scene-state]");
  if (!tag?.textContent) return undefined;
  try {
    return JSON.parse(tag.textContent) as SceneState;
  } catch {
    return undefined;
  }
}

function wanted(): boolean {
  if (!document.querySelector("[data-scene]")) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  // a probe context, released immediately — cheaper than finding out by
  // constructing a renderer and catching the throw
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

async function sync(): Promise<void> {
  const container = document.querySelector<HTMLElement>("[data-scene]");
  const state = readState();
  if (!container || !state) return;

  if (window.__campusScene === "unavailable") return;

  if (typeof window.__campusScene === "object") {
    if (container === mountedOn && builtIn === themeNow()) {
      container.hidden = false;
      window.__campusScene.update(state);
      return;
    }
    // a new container: the old scene has nowhere visible to draw, so let it
    // go and build again on this one. Or a new theme: the scene's colours
    // are baked into its materials and label textures, so that's a new
    // scene too — on a new canvas, because dispose() forces the old context
    // lost and a canvas hands back that same dead context for as long as it
    // lives.
    const retheme = container === mountedOn;
    release();
    if (retheme) {
      const canvas = container.querySelector("canvas");
      canvas?.replaceWith(canvas.cloneNode(false));
    }
  }

  if (window.__campusScene === "loading") return;
  if (!wanted()) {
    window.__campusScene = "unavailable";
    return;
  }

  window.__campusScene = "loading";
  // Take the window now, before three.js has loaded: showing the container
  // is what switches the page into its map layout, and doing it once the
  // module arrives would lay the page out as a list and then rearrange it
  // under the visitor. Until the first frame, the container says it's
  // loading. It also has to be showing BEFORE the scene is constructed: the
  // scene sizes its camera from the container, and a display:none element
  // measures 0×0.
  container.hidden = false;
  try {
    const { createScene } = await import("./campus");
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("no canvas to draw on");
    builtIn = themeNow();
    const scene = createScene(canvas, container, builtIn);
    window.__campusScene = scene;
    mountedOn = container;
    // navigated off the map while three.js was still loading: start again on
    // whatever the page has now, if anything
    if (!container.isConnected) {
      release();
      void sync();
      return;
    }
    scene.update(readState() ?? state);
  } catch (error) {
    // a campus that won't draw is not a broken page — say so once, hide the
    // map again, and the page lays itself out as the lists it already has
    window.__campusScene = "unavailable";
    container.hidden = true;
    console.warn("campus scene unavailable, falling back to the list", error);
  }
}

export function mountScene(): void {
  void sync();
  document.addEventListener("astro:page-load", () => void sync());
  // and on landing somewhere without the map, give the GPU context and the
  // live event stream back rather than holding them for a canvas that's gone
  document.addEventListener("astro:after-swap", () => {
    if (mountedOn && !mountedOn.isConnected) release();
  });
  // the masthead's switch, or the device changing its mind while nobody has
  // chosen — either way, sync() rebuilds if the theme on screen has moved
  window.addEventListener("theme:change", () => void sync());
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => void sync());
}
