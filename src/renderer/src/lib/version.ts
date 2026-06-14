import { useEffect, useState } from 'react'
import { APP_VERSION } from '@shared/config'

/**
 * The app's real version (package.json `version`, e.g. "1.0.0"), fetched from the
 * main process. This is the same value auto-update compares against, so the UI always
 * shows exactly what's installed. Falls back to APP_VERSION until the IPC resolves.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION)
  useEffect(() => {
    window.api.app
      .getVersion()
      .then((v) => {
        if (v) setVersion(v)
      })
      .catch(() => {})
  }, [])
  return version
}

