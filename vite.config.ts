import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content: "src/content/content.ts",
        popup: "src/popup/popup.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});