import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Root-absolute, NOT relative ('./'). This app is a client-routed SPA
  // deployed at the domain root behind Vercel's SPA rewrite
  // (vercel.json: /((?!api/).*)  ->  /index.html). With a relative base,
  // dist/index.html's <script src="./assets/...."> resolves against the
  // browser's CURRENT URL path, not the site root — so a hard refresh on
  // any nested route (e.g. /client/messages) requests
  // /client/assets/index-*.js, which doesn't exist as a static file, so
  // Vercel's catch-all rewrite serves index.html's HTML for it instead of
  // the JS module. The browser then rejects it ("Expected a
  // JavaScript-or-Wasm module script but the server responded with a MIME
  // type of text/html") and React never initializes — a fully blank page,
  // not fixable by an error boundary since React never boots. Root-absolute
  // paths (/assets/index-*.js) resolve identically regardless of the
  // current URL's depth, which is what a rewrite-based SPA requires.
  base: '/',
  build: {
    outDir: 'dist',
  },
})
