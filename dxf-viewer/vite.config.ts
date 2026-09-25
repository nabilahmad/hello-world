import { defineConfig } from 'vite';

// Tauri expects a fixed dev-server port and serves the built files from dist/.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 (Chromium) on Windows, WebKit on macOS/Linux.
    target: ['es2021', 'chrome105', 'safari15'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  worker: { format: 'iife' },
});
