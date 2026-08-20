import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // Stage B — minimal PWA foundation: application-shell caching only.
    // No runtimeCaching entries are configured anywhere in this file, and
    // none should ever be added for this app without a deliberate,
    // reviewed decision — the generated service worker precaches ONLY the
    // static build output (JS/CSS/fonts/icons/index.html, via the default
    // globPatterns below) and is otherwise completely transparent to every
    // fetch() the app makes. In particular this means Supabase queries,
    // every /api/* call (human-reply, media-*, conversation-status,
    // claim-conversation, ...), and any signed media URL are NEVER
    // intercepted or cached by the service worker — they always hit the
    // network exactly as they did before this file existed. The Inbox
    // (conversations/messages/Human Takeover state) must always show live
    // server data; caching any of that would be a correctness bug, not an
    // optimization.
    VitePWA({
      // 'generateSW' (the default strategy) is exactly what "application
      // shell caching only, no custom runtime logic" calls for — it
      // precaches globPatterns below and installs a navigation fallback
      // for offline shell loads, nothing more. No injectManifest/custom
      // service-worker source is needed for this minimal foundation.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Jawab AI',
        short_name: 'Jawab AI',
        description: 'Jawab AI — WhatsApp, Facebook and Telegram auto-reply and inbox management.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Both values are this app's own existing design tokens (see
        // src/index.css :root), not new/invented branding colors.
        // background_color: the splash-screen backdrop shown while the
        // PWA is loading, before any CSS has painted — matches --app-bg.
        // theme_color: the OS/browser chrome tint (Android status bar,
        // task switcher strip) while the app is open — matches
        // --app-primary, the same indigo already used for the sidebar's
        // brand mark and the primary buttons throughout the app.
        background_color: '#f5f7fb',
        theme_color: '#4f46e5',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Default-ish glob — the app's own built JS/CSS/HTML/fonts/icons/
        // manifest. Deliberately does NOT include any runtime-fetched data;
        // this only ever matches files vite build actually emits into dist/.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ico}'],
        // A hard navigation to /api/* should never happen (those are
        // fetch()-only endpoints, never link/navigation targets), but this
        // keeps the SPA shell's navigation fallback from ever being able to
        // intercept one even in that unexpected case.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      // devOptions left at its default (disabled) — the service worker is
      // only built/enabled for production builds, never `npm run dev`, so
      // local development is completely unaffected by any of this.
    }),
  ],
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
