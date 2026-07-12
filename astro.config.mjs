import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  srcDir: "./web",
  outDir: "./dist",
  output: "static",
});
