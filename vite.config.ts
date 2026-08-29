import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // One 960 kB bundle is mostly xterm and React, neither of which
        // changes when the app does. Splitting them keeps the app's own chunk
        // small enough to be worth re-downloading, and keeps the build honest
        // about size rather than silencing the warning.
        manualChunks: {
          xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-search", "@xterm/addon-webgl"],
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      allow: [process.cwd(), "/tmp"],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // The vendored xterm.js tree ships its own test suite; only run ours.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
