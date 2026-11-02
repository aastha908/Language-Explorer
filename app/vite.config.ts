import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? (process.env.GITHUB_PAGES_BASE ?? '/lang-viz/') : '/',
  // Preserve the worker's lazy geometry import as a separate production chunk.
  worker: { format: 'es' },
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
})
