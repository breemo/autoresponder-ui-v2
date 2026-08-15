import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// Self-hosted Inter (@fontsource) — the font this app's typography was
// always designed around (see index.css). It was previously only named
// in the font-family stack, never actually loaded, so it only rendered on
// machines that happened to have it installed locally. Importing the
// weight files here bundles them with the app (no external/CDN request,
// works offline) so every page consistently renders in the same font
// everywhere, matching the Auto Replies reference appearance. Only the
// weights actually used by Tailwind classes in this codebase (font-normal
// 400, font-medium 500, font-semibold 600, font-bold 700, font-extrabold
// 800, font-black 900) are imported.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/inter/900.css'
import './index.css'

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
      <App />
  </React.StrictMode>
)
