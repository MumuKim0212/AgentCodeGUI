// App theme (light / dark), persisted alongside the other UI prefs in ui-prefs.json.
// The whole design system is CSS-variable driven, so applying a theme is just setting
// `data-theme` on <html> — styles.css re-declares the tokens under
// `:root[data-theme="dark"]`. `applyTheme()` must run before first paint (see main.tsx)
// so dark users never flash the light card.

import { getPref, setPref } from './prefs'

export type Theme = 'light' | 'dark'

const KEY = 'app.theme'

/** The saved theme choice (valid after loadPrefs has resolved). Defaults to light.
 *  A 'system' choice saved by an older version resolves once to what the OS shows
 *  now, so removing the option doesn't visibly flip anyone's theme. */
export function getTheme(): Theme {
  const t = getPref<string>(KEY, 'light')
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Paint <html> for the given (or saved) theme. */
export function applyTheme(theme: Theme = getTheme()): void {
  document.documentElement.setAttribute('data-theme', theme)
}

/** Persist a new theme choice and apply it immediately. */
export function setTheme(theme: Theme): void {
  setPref(KEY, theme)
  applyTheme(theme)
}
