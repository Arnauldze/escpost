import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      // Two entries, one per package export: "." and "./qz".
      entry: { index: "src/index.ts", qz: "src/qz/index.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    minify: false,
  },
});
