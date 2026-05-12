import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // ← هاي أهم سطر لحل مشكلة Vercel
  build: {
    outDir: 'dist',
  },
})
