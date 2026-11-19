import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3002',
        ws: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('socket.io-client') || id.includes('engine.io-client')) {
              return 'vendor-socket';
            }
            if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
              return 'vendor-react';
            }
            if (id.includes('leaflet') || id.includes('react-leaflet')) {
              return 'vendor-leaflet';
            }
          }
        }
      }
    }
  }
})