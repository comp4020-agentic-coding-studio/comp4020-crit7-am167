import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Server-rendered output: pages render per request so they can read the
// database, and `astro build` emits the Node server the Dockerfile runs.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    // Fly's proxy terminates TLS, so naming the deploy domain is what lets
    // Astro trust x-forwarded-proto and accept same-origin form POSTs.
    allowedDomains: [{ hostname: "**.fly.dev", protocol: "https" }],
  },
  vite: {
    build: {
      // three.js is ~614 kB raw / 159 kB gzipped and arrives as its own
      // chunk, dynamically imported by src/scenes/mount.ts only once we
      // know the browser has WebGL and hasn't asked for reduced motion.
      // Every page is complete before it lands (19 kB of JS on first load),
      // so the split is already what the default 500 kB warning would tell
      // us to do. Raised just past the real figure rather than switched
      // off: if three ever leaks into the initial bundle, or this chunk
      // starts growing, the warning comes back and means something.
      chunkSizeWarningLimit: 650,
    },
  },
});
