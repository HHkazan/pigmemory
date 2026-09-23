import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "viewer",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
