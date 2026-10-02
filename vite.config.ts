import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        confetti: resolve(__dirname, "confetti.html"),
        alert: resolve(__dirname, "alert.html"),
      },
    },
  },
  test: { globals: true, environment: "node" },
});
