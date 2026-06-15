import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Bumped from default 500kB — Firebase + the larger admin pages legitimately
    // push past it; the warning was just noise. Real splitting is via
    // route-level lazy() in App.jsx + the vendor chunks below.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split heavy third-party libs into their own cacheable chunks so an
        // app code change doesn't bust the vendor cache on every deploy.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'firebase-vendor': [
            'firebase/app',
            'firebase/auth',
            'firebase/firestore',
            'firebase/storage',
          ],
          'xlsx-vendor': ['xlsx'],
          'date-vendor': ['date-fns'],
        },
      },
    },
  },
})
