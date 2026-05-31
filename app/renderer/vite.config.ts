import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Renderer-only dev server — no API proxy (desktop uses IPC). */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
