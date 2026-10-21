import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { stlFilesPlugin, stlRoot } from './stlPlugin'

export default defineConfig({
  plugins: [stlFilesPlugin(), react()],
  server: {
    fs: {
      allow: [stlRoot, '.'],
    },
  },
})
