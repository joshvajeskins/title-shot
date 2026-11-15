import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (Fontsource, latin only, font-display: swap): no render-blocking request to Google before first paint.
import '@fontsource/big-shoulders-display/latin-600'
import '@fontsource/big-shoulders-display/latin-800'
import '@fontsource/big-shoulders-display/latin-900'
import '@fontsource/instrument-serif/latin-400'
import '@fontsource/instrument-serif/latin-400-italic'
import '@fontsource/jetbrains-mono/latin-400'
import '@fontsource/jetbrains-mono/latin-600'
import './styles/tokens.css'
import './styles/base.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
