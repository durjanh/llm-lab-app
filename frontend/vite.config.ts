import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, Vite serves the pages and forwards API calls and local model files to the
// FastAPI backend on port 8000 (set LLM_LAB_API to use another). `npm run build` writes dist/,
// which the backend serves itself.
const api = process.env.LLM_LAB_API ?? 'http://127.0.0.1:8000';
// LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080 sends the MedAssist page's calls to the .NET API (dotnet/) instead,
// which serves the same /api/medassist routes and JSON. Everything else still goes to the Python backend.
const medassist = process.env.LLM_LAB_MEDASSIST_API;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LLM_LAB_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: {
      ...(medassist ? { '/api/medassist': medassist } : {}), // listed first, so it wins over /api
      '/api': api,
      '/models': api,
      '/sites/': api, // /sites/<id>/ serves the site builder's sites
    },
  },
  build: { chunkSizeWarningLimit: 800 },
});
