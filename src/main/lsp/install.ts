import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { APP_HOME } from '../engine/versions'
import type { LspInstallProgress } from '@shared/protocol'

/* ============================================================
 * Downloadable language servers (C# / C++). Unlike the bundled
 * Node-based servers (TypeScript, Python), these are native
 * binaries too big to ship in the installer — they're fetched
 * on demand (one explicit click in the viewer) into
 * ~/.agentcodegui/lsp/<id>/ and reused from there.
 * ============================================================ */

const LSP_DIR = path.join(APP_HOME, 'lsp')

export interface DownloadSpec {
  id: string
  label: string
  /** resolve the (win-x64) archive URL — may hit the GitHub API for the asset name */
  resolveUrl(): Promise<string>
  /** locate the server executable inside the install dir, or null when absent */
  findBin(dir: string): string | null
}

export const DOWNLOADS: Record<string, DownloadSpec> = {
  cs: {
    id: 'cs',
    label: 'C# (OmniSharp)',
    // the net6.0 build, run via `dotnet` with roll-forward: it uses the machine's
    // .NET SDK MSBuild, which loads modern SDK-style projects. (The full-framework
    // build binds VS's MSBuild and breaks against current VS versions.)
    resolveUrl: async () =>
      'https://github.com/OmniSharp/omnisharp-roslyn/releases/latest/download/omnisharp-win-x64-net6.0.zip',
    findBin: (dir) => {
      const p = path.join(dir, 'OmniSharp.dll')
      return fs.existsSync(p) ? p : null
    }
  },
  cpp: {
    id: 'cpp',
    label: 'C/C++ (clangd)',
    // clangd's assets are version-named (clangd-windows-19.x.zip) → ask the API
    resolveUrl: async () => {
      const res = await fetch('https://api.github.com/repos/clangd/clangd/releases/latest', {
        headers: { 'user-agent': 'AgentCodeGUI', accept: 'application/vnd.github+json' }
      })
      if (!res.ok) throw new Error(`GitHub API 응답 오류 (${res.status})`)
      const j = (await res.json()) as { assets?: { name?: string; browser_download_url?: string }[] }
      const asset = j.assets?.find((a) => /^clangd-windows-[\d.]+\.zip$/.test(a.name ?? ''))
      if (!asset?.browser_download_url) throw new Error('clangd Windows 빌드를 찾을 수 없어요')
      return asset.browser_download_url
    },
    findBin: (dir) => {
      // the zip extracts to clangd_<version>/bin/clangd.exe
      let names: string[] = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        return null
      }
      for (const n of names) {
        const p = path.join(dir, n, 'bin', 'clangd.exe')
        if (n.startsWith('clangd') && fs.existsSync(p)) return p
      }
      return null
    }
  }
}

// in-flight installs (in-memory; installed-ness itself is derived from disk so it
// survives restarts)
const installing = new Set<string>()

export type InstallState = 'none' | 'installing' | 'installed'

export function installState(id: string): InstallState {
  if (installing.has(id)) return 'installing'
  return installedBin(id) ? 'installed' : 'none'
}

/** Absolute path of an installed server binary, or null. */
export function installedBin(id: string): string | null {
  const spec = DOWNLOADS[id]
  if (!spec) return null
  return spec.findBin(path.join(LSP_DIR, id))
}

async function download(url: string, dest: string, onPct: (pct: number | null) => void): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'AgentCodeGUI' } })
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total > 0) {
      const pct = Math.min(99, Math.floor((got / total) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        onPct(pct)
      }
    }
  })
  await pipeline(body, fs.createWriteStream(dest))
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 종료 코드 ${code}`))))
  })
}

async function extractZip(zip: string, dest: string): Promise<void> {
  // Windows 10+ ships bsdtar, which reads zip archives. Use the System32 binary by
  // absolute path — a GNU tar earlier in PATH (e.g. Git's) chokes on drive-letter
  // colons ("Cannot connect to C"). PowerShell is the fallback.
  const sysTar = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
  try {
    await run(fs.existsSync(sysTar) ? sysTar : 'tar', ['-xf', zip, '-C', dest])
  } catch {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dest}'`
    ])
  }
}

// Kill any process launched from this server's install dir. Matched by command
// line, so only our servers are touched — including orphans left behind when the
// app was force-killed (they keep holding the dll and make the delete EPERM).
// $PID excludes the sweeping PowerShell itself (its command line contains the dir).
function killHolders(id: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const dir = path.join(LSP_DIR, id).replace(/'/g, "''")
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${dir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    ps.on('error', () => resolve())
    ps.on('close', () => resolve())
  })
}

/** Remove an installed server from disk, killing whatever still runs from it first. */
export async function uninstall(id: string): Promise<void> {
  await killHolders(id)
  await new Promise((r) => setTimeout(r, 300)) // let the OS release file handles
  try {
    await fsp.rm(path.join(LSP_DIR, id), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch {
    throw new Error('파일이 아직 사용 중이에요. 잠시 후 다시 시도하거나 앱을 재시작해 주세요.')
  }
}

/**
 * Download + extract a server into ~/.agentcodegui/lsp/<id>/, streaming progress.
 * Concurrent calls for the same server coalesce into "already installing".
 */
export async function install(
  id: string,
  onProgress: (p: LspInstallProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const spec = DOWNLOADS[id]
  if (!spec) return { ok: false, error: '알 수 없는 서버' }
  if (installing.has(id)) return { ok: true }
  if (installedBin(id)) return { ok: true }
  if (process.platform !== 'win32') return { ok: false, error: 'Windows에서만 자동 설치를 지원해요' }

  installing.add(id)
  const dir = path.join(LSP_DIR, id)
  const emit = (p: Partial<LspInstallProgress>): void =>
    onProgress({ server: id, label: spec.label, percent: null, ...p })
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    emit({ line: `${spec.label} 다운로드 주소 확인 중…` })
    const url = await spec.resolveUrl()
    emit({ line: `다운로드 중: ${url}`, percent: 0 })
    const zip = path.join(dir, '_download.zip')
    await download(url, zip, (pct) => emit({ percent: pct }))
    emit({ line: '압축 해제 중…', percent: 99 })
    await extractZip(zip, dir)
    await fsp.rm(zip, { force: true })
    if (!spec.findBin(dir)) throw new Error('설치 후 실행 파일을 찾을 수 없어요')
    emit({ done: true, ok: true, percent: 100 })
    return { ok: true }
  } catch (e) {
    const error = (e as Error).message || '설치 실패'
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    emit({ done: true, ok: false, error })
    return { ok: false, error }
  } finally {
    installing.delete(id)
  }
}
