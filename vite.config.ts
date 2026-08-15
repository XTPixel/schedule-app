import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2.x 约定的 Vite 配置（开发端口 1420）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
