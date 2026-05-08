import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    /** Production bundle is emitted into the backend package so `npm start` serves UI + API on one port. */
    build: {
        outDir: "../backend/public",
        emptyOutDir: true,
    },
    server: {
        port: 5174,
        proxy: {
            "/api": {
                target: "http://localhost:8787",
                changeOrigin: true,
            },
            "/terminal/ws": {
                target: "ws://localhost:8787",
                ws: true,
            },
            "/fs/watch": {
                target: "ws://localhost:8787",
                ws: true,
            },
            "/browser/ws": {
                target: "ws://localhost:8787",
                ws: true,
            },
        },
    },
});
