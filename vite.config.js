import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Bumped from default 500kB — Firebase + the larger admin pages legitimately
    // push past it; the warning was just noise. Real splitting is via
    // route-level lazy() in App.jsx, which automatically code-splits each route
    // into its own chunk.
    chunkSizeWarningLimit: 900,
  },
})
