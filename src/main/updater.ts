import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/protocol'

// electron-updater is CommonJS — pull `autoUpdater` off the default export so it
// works under the ESM-bundled main process.
const { autoUpdater } = electronUpdater

// The authoritative update state lives here (not in the renderer), so the UI can
// fetch it on mount and never miss events fired before it subscribed. A running
// `log` mirrors the engine-install card's streamed output.
let state: UpdateStatus = { phase: 'idle', version: null, percent: 0, log: [], error: null }
let sender: ((s: UpdateStatus) => void) | null = null
let lastLoggedStep = -1
let wired = false

function emit(): void {
  sender?.(state)
}
function set(patch: Partial<UpdateStatus>, line?: string): void {
  state = { ...state, ...patch, log: line ? [...state.log, line] : state.log }
  emit()
}
function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1)
}

/** Current update state — used to seed the renderer on mount. */
export function getUpdateStatus(): UpdateStatus {
  return state
}

/**
 * Wire up auto-updates against the configured GitHub Releases provider. Only does
 * anything in a packaged build: electron-builder writes an `app-update.yml` into the
 * app resources at package time, and electron-updater needs it to know where to look.
 * In dev there's no metadata, so this is a no-op (no spurious errors).
 *
 * `send` pushes the full state to the renderer on every change.
 */
export function initAutoUpdater(send: (s: UpdateStatus) => void): void {
  sender = send
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true // download in the background as soon as one is found
  autoUpdater.autoInstallOnAppQuit = true // and install it on the next normal quit

  if (!wired) {
    wired = true
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }, '업데이트를 확인하는 중…'))
    autoUpdater.on('update-available', (info) =>
      set({ phase: 'available', version: info.version }, `새 버전 v${info.version}을(를) 찾았어요 · 다운로드를 시작합니다`)
    )
    autoUpdater.on('update-not-available', () => set({ phase: 'none' }, '이미 최신 버전이에요'))
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
      // append a log line only every 5% so the log reads cleanly instead of flooding
      const step = Math.floor(percent / 5)
      const line = step !== lastLoggedStep ? `다운로드 ${percent}% · ${mb(p.transferred)} / ${mb(p.total)} MB` : undefined
      if (line) lastLoggedStep = step
      set({ phase: 'downloading', percent }, line)
    })
    autoUpdater.on('update-downloaded', (info) =>
      set({ phase: 'downloaded', version: info.version, percent: 100 }, '다운로드 완료 · 재시작하면 설치됩니다')
    )
    autoUpdater.on('error', (err) => set({ phase: 'error', error: err?.message ?? String(err) }, '업데이트 중 오류가 발생했어요'))
  }

  checkForUpdates()
}

/** Trigger an update check. Safe to call repeatedly; ignored outside a packaged build. */
export function checkForUpdates(): void {
  if (!app.isPackaged) return
  // offline, or no release published yet → the 'error' event already surfaces anything
  // worth showing, so just swallow the rejection here.
  autoUpdater.checkForUpdates().catch(() => {})
}

/** Quit and install an already-downloaded update, then relaunch the app. */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall(false, true)
}
