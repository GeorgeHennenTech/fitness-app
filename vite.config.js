import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite picks up index.html at the project root automatically.
// API routes under /api/*.js are handled by Vercel as serverless functions.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 2000, // App.jsx is large; suppress noisy warning
  },
});
