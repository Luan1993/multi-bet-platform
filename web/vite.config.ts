import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// O dev server serve o frontend em 5173 e encaminha /api para a API em 4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: false,
      },
      "/uploads": {
        target: "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
