import { createRoot } from 'react-dom/client'
import App from './App'
import { loadPrefs } from './lib/prefs'
import { applyTheme } from './lib/theme'
import './styles.css'

// load saved UI prefs (viewer size/zoom, chat zoom, theme) before first paint so the
// hooks read the persisted values synchronously and the UI doesn't flash a default —
// applyTheme() in particular must run before render so dark users don't flash light
loadPrefs().finally(() => {
  applyTheme()
  createRoot(document.getElementById('root')!).render(<App />)
})
