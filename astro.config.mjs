import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  srcDir: "./web",
  outDir: "./dist",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
