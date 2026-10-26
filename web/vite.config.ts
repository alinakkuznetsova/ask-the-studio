import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// in development the api runs on :3000 and vite proxies to it, so the
// browser only ever talks to one origin (no cors needed, same as production)
const api = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/ask": api, "/feedback": api, "/health": api, "/evals": api },
  },
  build: { sourcemap: false },
});
