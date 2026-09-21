import type { SceneState } from "./campus";

// Mounting the 3D campus, and deciding whether to mount it at all.
//
// The scene is enhancement: every page it appears on is already complete
// without it. So this bails out quietly — leaving the container hidden and
// the server-rendered list or floor plan in charge — whenever the scene
// would be unwelcome or impossible:
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
    container.hidden = false;
    window.__campusScene.update(state);
    return;
  }

  if (window.__campusScene === "loading") return;
  if (!wanted()) {
    window.__campusScene = "unavailable";
    return;
  }

  window.__campusScene = "loading";
  try {
    const { createScene } = await import("./campus");
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("no canvas to draw on");
    // Unhide BEFORE constructing: the scene sizes its camera from the
    // container, and a display:none element measures 0×0.
    container.hidden = false;
    const scene = createScene(canvas, container);
    window.__campusScene = scene;
    scene.update(readState() ?? state);
  } catch (error) {
    // a campus that won't draw is not a broken page — say so once and let
    // the list underneath do the job
    window.__campusScene = "unavailable";
    console.warn("campus scene unavailable, falling back to the list", error);
  }
}

export function mountScene(): void {
  void sync();
  document.addEventListener("astro:page-load", () => void sync());
}
