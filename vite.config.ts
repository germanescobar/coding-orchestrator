import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "client",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 4500,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
  build: {
    outDir: "../dist/client",
  },
});
