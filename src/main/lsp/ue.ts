import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { APP_HOME } from '../engine/versions'

/* ============================================================
 * Unreal Engine 프로젝트의 clangd 컴파일 데이터베이스 자동 생성.
 *
 * clangd는 compile_commands.json(각 .cpp의 인클루드 경로·매크로·플래그 목록)이
 * 있어야 엔진 심볼(FString 등)을 해석한다 — Rider는 자체 인덱서라 필요 없지만
 * clangd에겐 이 파일이 다리다. 프로젝트 루트에 .uproject가 보이면
 * UnrealBuildTool의 GenerateClangDatabase 모드로 만들어 준다(수 초).
 *
 * 컴파일러: UBT의 이 모드는 기본값이 -Compiler=Clang인데, Windows에 LLVM
 * 툴체인이 없는 게 보통이라 그대로는 "Clang x64 must be installed"로 즉사한다.
 * 그래서 기본(클랭이 있으면 최상) → VS2026 → VS2022 순으로 폴백한다 — clangd는
 * cl.exe 명령줄도 해석하므로(clang-cl 드라이버 모드) MSVC DB로도 충분하다.
 * 실패한 시도는 툴체인 탐지 단계에서 1초 안에 끝나 폴백 비용이 거의 없다.
 *
 * 갱신 기준: DB가 없거나, 구조 파일(.uproject/.uplugin/*.Build.cs/*.Target.cs)이
 * DB보다 새로울 때. 새 .cpp 추가만으로는 재생성하지 않는다 — clangd가 DB에 없는
 * 파일의 플래그를 같은 모듈의 이웃 파일에서 추론하므로 그걸로 충분하다.
 *
 * 시도/실패 내역은 ~/.agentcodegui/lsp/ue-clangdb.log에 남는다.
 * ============================================================ */

export type UeDbResult = 'none' | 'fresh' | 'generated'

// 프로젝트 루트당 세션에 한 번만 시도 — 실패해도 재시도 루프를 만들지 않는다
const attempts = new Map<string, Promise<UeDbResult>>()

export function ensureUeClangDb(root: string): Promise<UeDbResult> {
  const abs = path.resolve(root)
  const key = abs.toLowerCase()
  let p = attempts.get(key)
  if (!p) {
    p = generate(abs).catch(() => 'none' as const)
    attempts.set(key, p)
  }
  return p
}

async function generate(root: string): Promise<UeDbResult> {
  if (process.platform !== 'win32') return 'none'
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch {
    return 'none'
  }
  const uprojName = names.find((n) => n.toLowerCase().endsWith('.uproject'))
  if (!uprojName) return 'none'
  const uproject = path.join(root, uprojName)

  const db = path.join(root, 'compile_commands.json')
  const dbStat = await fsp.stat(db).catch(() => null)
  if (dbStat && dbStat.mtimeMs >= (await newestStructureMtime(root, uproject))) return 'fresh'

  const target = await editorTarget(root)
  if (!target) return 'none'

  const assoc = await engineAssociation(uproject)
  const engine = await engineRoot(assoc, root)
  if (!engine) return 'none'
  const ubt = [
    path.join(engine, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe'), // UE5
    path.join(engine, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool.exe') // UE4
  ].find((p) => fs.existsSync(p))
  if (!ubt) return 'none'

  const base = ['-mode=GenerateClangDatabase', `-project=${uproject}`, target, 'Win64', 'Development', `-OutputDir=${root}`]
  // ''(기본 = Clang, 있으면 최상) → MSVC 폴백. 모르는 enum 값(구버전 엔진의
  // VisualStudio2026 등)은 인자 파싱에서 즉시 실패해 다음 후보로 넘어간다.
  for (const compiler of ['', 'VisualStudio2026', 'VisualStudio2022']) {
    const ok = await run(ubt, compiler ? [...base, `-Compiler=${compiler}`] : base)
    if (ok) return fs.existsSync(db) ? 'generated' : 'none'
  }
  return 'none'
}

/** .uproject/.uplugin/*.Build.cs/*.Target.cs 중 가장 최근 수정 시각 — DB 신선도 기준. */
async function newestStructureMtime(root: string, uproject: string): Promise<number> {
  let newest = 0
  const stat = async (p: string): Promise<void> => {
    const st = await fsp.stat(p).catch(() => null)
    if (st && st.mtimeMs > newest) newest = st.mtimeMs
  }
  await stat(uproject)
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let ents: fs.Dirent[]
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const n = e.name.toLowerCase()
        // 빌드 산출물·콘텐츠는 구조와 무관 — 큰 프로젝트에서 스캔을 가볍게 유지
        if (n === 'intermediate' || n === 'binaries' || n === 'saved' || n === 'content' || n === 'deriveddatacache' || n === '.git') continue
        await scan(p, depth + 1)
      } else if (/\.(build|target)\.cs$|\.uplugin$/i.test(e.name)) {
        await stat(p)
      }
    }
  }
  await scan(path.join(root, 'Source'), 0)
  await scan(path.join(root, 'Plugins'), 0)
  return newest
}

/** Source/*.Target.cs에서 에디터 타깃 이름 — Editor 타깃 우선, 없으면 첫 타깃. */
async function editorTarget(root: string): Promise<string | null> {
  let names: string[]
  try {
    names = await fsp.readdir(path.join(root, 'Source'))
  } catch {
    return null
  }
  const targets = names.filter((n) => /\.target\.cs$/i.test(n))
  if (!targets.length) return null
  const editor = targets.find((n) => /editor\.target\.cs$/i.test(n))
  return (editor ?? targets[0]).replace(/\.target\.cs$/i, '')
}

async function engineAssociation(uproject: string): Promise<string> {
  try {
    const j = JSON.parse(await fsp.readFile(uproject, 'utf8')) as { EngineAssociation?: string }
    return j.EngineAssociation ?? ''
  } catch {
    return ''
  }
}

/**
 * .uproject의 EngineAssociation → 엔진 설치 경로.
 * "5.8" 같은 버전은 런처 레지스트리(HKLM) → 런처 설치 목록(LauncherInstalled.dat)
 * → Program Files 추측 순서로 찾고(레지스트리는 키가 없는 버전이 흔하다 — 이
 * 머신만 해도 5.8 키가 없었다), GUID는 소스 빌드 레지스트리(HKCU),
 * 빈 값(엔진 옆에 둔 프로젝트)은 상위 폴더에서 Engine/ 디렉터리를 찾는다.
 */
async function engineRoot(assoc: string, root: string): Promise<string | null> {
  if (/^\d+\.\d+$/.test(assoc)) {
    const reg = await regQuery(`HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${assoc}`, 'InstalledDirectory')
    if (reg && fs.existsSync(reg)) return reg
    const dat = await launcherEngine(assoc)
    if (dat) return dat
    const guess = path.join('C:\\Program Files\\Epic Games', `UE_${assoc}`)
    if (fs.existsSync(guess)) return guess
  } else if (assoc) {
    const reg = await regQuery('HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', assoc)
    if (reg && fs.existsSync(reg)) return reg
  }
  let d = root
  for (let i = 0; i < 6; i++) {
    d = path.dirname(d)
    if (fs.existsSync(path.join(d, 'Engine', 'Build', 'BatchFiles'))) return d
  }
  return null
}

/** 에픽 런처의 설치 목록 — "5.8" 버전 문자열을 AppName "UE_5.8"로 찾는다. */
async function launcherEngine(assoc: string): Promise<string | null> {
  try {
    const dat = path.join(
      process.env['ProgramData'] ?? 'C:\\ProgramData',
      'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'
    )
    const j = JSON.parse(await fsp.readFile(dat, 'utf8')) as {
      InstallationList?: { AppName?: string; InstallLocation?: string }[]
    }
    const e = j.InstallationList?.find((x) => x.AppName === `UE_${assoc}`)
    return e?.InstallLocation && fs.existsSync(e.InstallLocation) ? e.InstallLocation : null
  } catch {
    return null
  }
}

function regQuery(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg', ['query', key, '/v', value], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      // "    InstalledDirectory    REG_SZ    C:\Program Files\..." 형태의 줄을 찾는다
      const m = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(value.toLowerCase()))
      const v = m?.split(/\s{4,}|\tREG_\w+\t?/).pop()?.trim()
      resolve(v || null)
    })
  })
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const grab = (d: Buffer): void => {
      out = (out + d).slice(-8192) // 출력 꼬리만 — UBT 로그는 길어질 수 있다
    }
    child.stdout?.on('data', grab)
    child.stderr?.on('data', grab)
    // 한 번도 안 빌드된 프로젝트는 UHT 코드 생성까지 돌아 수 분이 걸릴 수 있다
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      void log(`$ ${cmd} ${args.join(' ')}\n${out}\n→ 시간 초과(10분), 중단\n`)
      resolve(false)
    }, 600_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      void log(`$ ${cmd} ${args.join(' ')}\n→ 실행 실패: ${e.message}\n`)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      void log(`$ ${cmd} ${args.join(' ')}\n${out}\n→ exit ${code}\n`)
      resolve(code === 0)
    })
  })
}

// 실패가 침묵하지 않도록 — 매 UBT 시도를 ~/.agentcodegui/lsp/ue-clangdb.log에 남긴다
const LOG_FILE = path.join(APP_HOME, 'lsp', 'ue-clangdb.log')
async function log(text: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true })
    const st = await fsp.stat(LOG_FILE).catch(() => null)
    if (st && st.size > 256 * 1024) await fsp.rm(LOG_FILE, { force: true }) // 단순 로테이션
    await fsp.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    /* 로그는 보조 수단 — 실패해도 본 작업엔 영향 없음 */
  }
}
