import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': shared } },
    // Honor an externally assigned port (preview tooling); default stays 5173.
    server: { port: Number(process.env.PORT) || 5173 },
    // Single source of truth for the version shown in the UI.
    define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '') },
    build: {
      // Monaco's editor core is inherently large; it loads from local disk in
      // the packaged app, so the network-oriented size warning is noise here.
      chunkSizeWarningLimit: 9000,
      rollupOptions: {
        output: {
          manualChunks: { monaco: ['monaco-editor'] }
        }
      }
    }
  }
})
