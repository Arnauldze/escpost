import { defineConfig } from "vite";

// Second build: `dist/escpost-qz.js`, a classic script that defines `window.qz`
// for pages that load QZ Tray with a `<script>` tag instead of an import.
export default defineConfig({
  build: {
    lib: {
      entry: "src/qz/script.ts",
      formats: ["iife"],
      name: "EscpostQz",
      fileName: () => "escpost-qz.js",
    },
    // The first build already wrote dist/; keep its files.
    emptyOutDir: false,
    minify: false,
  },
});
