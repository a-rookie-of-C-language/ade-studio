import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

// Build (and optionally serve) Cindy's desktop renderer for first-party
// embedding inside OpenIDEA. Reads Cindy's repo, writes nothing there.
//
//   CINDY_DIR              cindy checkout (default D:/code/cindy)
//   VITE_CINDY_EMBED_OUT   static output dir (default public/cindy under this repo)
//
// window.electronAPI is stubbed by ./shim.js, inlined into index.html before
// the entry. Namespaces start as safe no-ops; real bridges replace them one
// by one (see shim.js).
const CINDY_DIR = process.env.CINDY_DIR ?? "D:/code/cindy";
const CINDY_DESKTOP = path.join(CINDY_DIR, "apps/desktop");
const requireFromCindy = createRequire(path.join(CINDY_DESKTOP, "package.json"));
const { defineConfig } = requireFromCindy("vite");
const reactModule = requireFromCindy("@vitejs/plugin-react");
const react = reactModule.default ?? reactModule;

const RENDERER_ROOT = path.join(CINDY_DESKTOP, "src/renderer");
const SHIM_PATH = new URL("./shim.js", import.meta.url);

export default defineConfig({
  root: RENDERER_ROOT,
  envDir: CINDY_DESKTOP,
  // Served under OpenIDEA's own origin at /cindy/. Hash routing needs no
  // basename, so only asset URLs change.
  base: "/cindy/",
  build: {
    outDir: process.env.VITE_CINDY_EMBED_OUT ?? "D:/code/openidea/public/cindy",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  plugins: [
    react(),
    {
      name: "cindy-embed-shim",
      async transformIndexHtml(html) {
        const SHIM = await fs.promises.readFile(SHIM_PATH, "utf8");
        return html.replace(
          '<div id="root"></div>',
          `<script>/* cindy-embed electronAPI stub */\n${SHIM}</script>\n<div id="root"></div>`,
        );
      },
    },
  ],
  resolve: {
    alias: {
      "@": RENDERER_ROOT,
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
