import { useEffect, useState } from 'react'

/** Tracks the window maximized state so `.win` can drop its rounded margin when maximized. */
export function useMaximized(): boolean {
  const [max, setMax] = useState(false)
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
    return window.api.onWinState((s) => setMax(s.maximized))
  }, [])
  return max
}
