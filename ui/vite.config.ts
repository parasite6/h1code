import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  worker: {
    format: "es",
  },
});
