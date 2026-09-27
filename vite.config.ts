import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3333', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3333', changeOrigin: true },
    },
  },
  build: {
    sourcemap: 'hidden',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor'
          if (id.includes('/lucide-react/')) return 'icons'
        },
      },
    },
  },
  preview: { port: 4173 },
})
