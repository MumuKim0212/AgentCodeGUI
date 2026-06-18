import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import type {
  EngineEvent,
  RunRequest,
  ChangedFile,
  FileDiff,
  JournalCategory,
  JournalEntryMeta,
  JournalEntry
} from '@shared/protocol'

/* ============================================================
 * 프로젝트-로컬 자동 작업 일지 (.journal/)  — "앱이 직접" 방식(b)
 *
 * 엔진 이벤트 스트림을 관찰해 한 턴(run)이 끝나면(`result`) 그 시점의 누적
 * diff + 사용자 프롬프트(의도) + 모델 요약(무엇)을 프로젝트 폴더의 마크다운으로
 * 남긴다. 이 파일들은 git으로 따라다녀, 다른 PC에서 clone하면 전 과정이 복원된다.
 *
 *   <프로젝트>/.journal/
 *     config.md                  앱이 읽는 규칙(현재는 문서 + 기본값 안내)
 *     entries/YYYY-MM-DD/<id>-<category>.md
 *     diffs/<id>.diff            그 시점 누적 diff(표준 unified, Obsidian/git 친화)
 * ============================================================ */

const JOURNAL_DIR = '.journal'

// ── 런별 누적 상태 ───────────────────────────────────────────
interface RunRecord {
  runId: string
  cwd: string
  prompt: string
  model: string
  sessionId: string | null
  files: Map<string, FileDiff> // path → 누적 diff
}

export class JournalRecorder {
  // 엔진-키(main / panelId)별 "다음 run의 입력". session 이벤트에서 prompt를 잇는다.
  private pending = new Map<string, RunRequest>()
  // 엔진-키별 진행 중인 run. 한 엔진은 동시에 한 run만 → runId가 아니라 키로 묶는다.
  private active = new Map<string, RunRecord>()

  /** 렌더러가 run을 시작시킬 때(runStart/maRun) 호출 — prompt·cwd를 stash. */
  onRunStart(key: string, req: RunRequest): void {
    this.pending.set(key, req)
  }

  /** 엔진 이벤트 스트림을 흘려보내며 일지에 필요한 것만 추린다. */
  observe(key: string, e: EngineEvent): void {
    switch (e.type) {
      case 'session': {
        const req = this.pending.get(key)
        this.pending.delete(key)
        this.active.set(key, {
          runId: e.runId,
          cwd: e.cwd,
          model: e.model,
          prompt: req?.prompt ?? '',
          sessionId: e.sessionId,
          files: new Map()
        })
        break
      }
      case 'file-change': {
        const rec = this.active.get(key)
        if (rec) mergeDiff(rec.files, e.file, e.diff, e.whole)
        break
      }
      case 'result': {
        const rec = this.active.get(key)
        if (!rec) break
        this.active.delete(key)
        // 정책: 실패한 턴 / 파일 변경 없는 턴은 기록하지 않는다(=diff 스냅샷이 핵심).
        // config.md로 전 턴 기록 전환은 추후(TODO).
        if (e.isError) break
        if (rec.files.size === 0) break
        // best-effort: 일지 기록 실패가 에이전트 실행을 막아선 안 된다.
        void writeEntry(rec, e).catch((err) =>
          console.error('[journal] 엔트리 기록 실패:', err)
        )
        break
      }
    }
  }

  /** run이 끝나기 전에 패널이 사라지면(dispose) 누적분을 버린다. */
  drop(key: string): void {
    this.pending.delete(key)
    this.active.delete(key)
  }
}

// ── diff 누적 (renderer session.ts와 동일 규칙) ──────────────
function mergeDiff(
  files: Map<string, FileDiff>,
  file: ChangedFile,
  diff: FileDiff,
  whole: boolean
): void {
  const prev = files.get(file.path)
  // 전체 Write는 파일 전체를 대체 → 누적분을 덮어쓴다. 증분 Edit는 기존 위에 머지.
  if (!whole && prev) {
    files.set(file.path, {
      ...prev,
      add: prev.add + diff.add,
      del: prev.del + diff.del,
      lines: [...prev.lines, ...diff.lines]
    })
  } else {
    files.set(file.path, diff)
  }
}

// ── 엔트리 기록 ──────────────────────────────────────────────
async function writeEntry(
  rec: RunRecord,
  result: Extract<EngineEvent, { type: 'result' }>
): Promise<void> {
  const root = projectJournalRoot(rec.cwd)
  if (!root) return // 프로젝트 폴더가 아니면(홈 디렉토리 등) 기록하지 않음

  const now = new Date()
  const id = `${stamp(now)}-${rand4()}`
  const day = ymd(now)
  const category = classify(rec.prompt, rec.files)
  const title = deriveTitle(rec.prompt, category)
  const changedFiles = [...rec.files.keys()].sort()

  const entriesDir = path.join(root, 'entries', day)
  const diffsDir = path.join(root, 'diffs')
  fs.mkdirSync(entriesDir, { recursive: true })
  fs.mkdirSync(diffsDir, { recursive: true })

  // diff 스냅샷 — .journal 루트 기준 상대 경로로 링크(이식성)
  const diffRel = `diffs/${id}.diff`
  fs.writeFileSync(path.join(diffsDir, `${id}.diff`), serializeDiffs(rec.files), 'utf8')

  ensureConfig(root)

  const meta: JournalEntryMeta = {
    id,
    timestamp: isoLocal(now),
    category,
    title,
    model: rec.model,
    changedFiles,
    diffRef: diffRel,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    sessionId: rec.sessionId,
    day
  }

  const md = renderEntry(meta, rec, result)
  fs.writeFileSync(path.join(entriesDir, `${id}-${category}.md`), md, 'utf8')
}

/** 프로젝트별 .journal 루트(절대경로). 홈 디렉토리/빈 cwd면 null(기록 안 함). */
function projectJournalRoot(cwd: string): string | null {
  if (!cwd || !cwd.trim()) return null
  const abs = path.resolve(cwd)
  // 프로젝트 없이 홈에서 돈 run은 ~/.journal 오염 방지를 위해 건너뛴다.
  if (abs === path.resolve(os.homedir())) return null
  try {
    if (!fs.statSync(abs).isDirectory()) return null
  } catch {
    return null
  }
  return path.join(abs, JOURNAL_DIR)
}

// ── 5종 분류 (앱-side 휴리스틱) ──────────────────────────────
// 빗나가면 사용자가 프론트매터 category만 고치면 된다. 키워드의 config.md
// 오버라이드는 추후(TODO). 우선순위: 위에서부터 첫 매치.
// 우선순위: 위에서부터 첫 매치. 강한 신호(에러·버그) 먼저, 문서/설정(chore)은
// feature보다 앞에 둬서 "문서로 작성"이 feature로 새지 않게 한다.
const RULES: { category: JournalCategory; re: RegExp }[] = [
  { category: 'error', re: /에러|예외|exception|crash|stack\s*trace|컴파일\s*오류|타입\s*오류|런타임/i },
  { category: 'bugfix', re: /버그|수정|고치|고침|틀린|잘못|\bfix\b|bug|defect|broken/i },
  { category: 'refactor', re: /리팩|정리|rename|이름\s*변경|구조\s*개선|중복\s*제거|refactor|cleanup|clean\s*up|simplif|extract/i },
  { category: 'chore', re: /문서|문서화|readme|주석|코멘트|타이포|typo|오타|버전|bump|설정|config|패키지|의존성|dependency/i },
  { category: 'feature', re: /추가|신설|구현|기능|만들|작성|feature|implement|support|\badd\b|introduce/i }
]

function classify(prompt: string, files: Map<string, FileDiff>): JournalCategory {
  // 의도(프롬프트)만 본다 — 모델 요약문엔 '정리/수정/추가' 같은 일반어가 흔해
  // 신호로 쓰면 오분류를 부른다(요약의 "정리한 문서" → refactor 오인 등).
  for (const r of RULES) if (r.re.test(prompt)) return r.category
  // 신호 없으면: 새 파일만 있으면 feature, 그 외 chore
  let onlyNew = files.size > 0
  for (const d of files.values()) if (d.tag !== 'new') onlyNew = false
  return onlyNew ? 'feature' : 'chore'
}

function deriveTitle(prompt: string, category: JournalCategory): string {
  const first = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return CATEGORY_LABEL[category]
  return first.length > 70 ? `${first.slice(0, 69)}…` : first
}

const CATEGORY_LABEL: Record<JournalCategory, string> = {
  bugfix: '버그 수정',
  feature: '기능 추가',
  refactor: '리팩토링',
  error: '에러 처리',
  chore: '잡일'
}

// ── 마크다운 / diff 직렬화 ──────────────────────────────────
function renderEntry(
  meta: JournalEntryMeta,
  rec: RunRecord,
  result: Extract<EngineEvent, { type: 'result' }>
): string {
  const fm = [
    '---',
    `id: ${meta.id}`,
    `timestamp: ${meta.timestamp}`,
    `category: ${meta.category}`,
    `title: ${yamlStr(meta.title)}`,
    `model: ${meta.model}`,
    `changed_files: [${meta.changedFiles.map(yamlStr).join(', ')}]`,
    `diff_ref: ${meta.diffRef}`,
    `cost_usd: ${meta.costUsd ?? 'null'}`,
    `duration_ms: ${meta.durationMs ?? 'null'}`,
    `num_turns: ${meta.numTurns ?? 'null'}`,
    `session_id: ${meta.sessionId ? yamlStr(meta.sessionId) : 'null'}`,
    '---'
  ].join('\n')

  const fileList = [...rec.files.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => `- \`${d.path}\` (${d.tag === 'new' ? '신규, ' : ''}+${d.add} −${d.del})`)
    .join('\n')

  return [
    fm,
    '',
    `# ${meta.title}`,
    '',
    '## 의도 (왜)',
    '',
    rec.prompt.trim() || '_(프롬프트 없음)_',
    '',
    '## 요약 (무엇)',
    '',
    result.text.trim() || '_(요약 없음)_',
    '',
    '## 변경 파일',
    '',
    fileList,
    '',
    `→ diff 스냅샷: [\`${meta.diffRef}\`](../../${meta.diffRef})`,
    ''
  ].join('\n')
}

/** FileDiff[] → 표준 unified diff 텍스트. Obsidian/사람이 읽기 좋게. */
function serializeDiffs(files: Map<string, FileDiff>): string {
  const blocks: string[] = []
  for (const d of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const head = [`diff --git a/${d.path} b/${d.path}`, `--- a/${d.path}`, `+++ b/${d.path}`]
    const body = d.lines.map((ln) => {
      if (ln.t === 'add') return `+${ln.text}`
      if (ln.t === 'del') return `-${ln.text}`
      if (ln.t === 'hunk') return ln.text.startsWith('@@') ? ln.text : `@@ ${ln.text} @@`
      return ` ${ln.text}`
    })
    blocks.push([...head, ...body].join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}

// ── config.md (앱이 읽는 규칙 — 현재는 문서 + 기본값 안내) ────
function ensureConfig(root: string): void {
  const p = path.join(root, 'config.md')
  if (fs.existsSync(p)) return
  fs.writeFileSync(p, DEFAULT_CONFIG, 'utf8')
}

const DEFAULT_CONFIG = `# .journal 규칙 (config.md)

이 폴더는 **AgentCodeGUI가 자동으로 생성하는 작업 일지**입니다.
에이전트가 한 턴을 끝낼 때마다 그 시점의 변경(diff)·의도(프롬프트)·요약을
\`entries/<날짜>/\`에 마크다운 1개로 남기고, git으로 따라다닙니다.

## 분류 (5종)
| category | 의미 |
|---|---|
| \`bugfix\`   | 버그 수정 |
| \`feature\`  | 기능 추가 |
| \`refactor\` | 리팩토링 |
| \`error\`    | 에러/예외 처리 |
| \`chore\`    | 잡일(문서·설정·버전 등) |

분류는 프롬프트·요약 키워드로 자동 추정합니다. 빗나가면 해당 엔트리의
front-matter \`category\`만 고치면 됩니다.

## 기록 정책 (현재 기본값)
- 파일 변경이 **있는** 턴만 기록합니다.
- 실패한 턴은 기록하지 않습니다.

> 이 파일의 값으로 분류 키워드·기록 정책을 오버라이드하는 기능은 예정입니다.
`

// ── 읽기 (뷰어용) ────────────────────────────────────────────
const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/

/** .journal/entries/*\/*.md 를 모두 읽어 메타 목록(최신순)으로. */
export function listJournal(cwd: string): JournalEntryMeta[] {
  const root = path.join(path.resolve(cwd || '.'), JOURNAL_DIR)
  const entriesDir = path.join(root, 'entries')
  const out: JournalEntryMeta[] = []
  let days: string[] = []
  try {
    days = fs.readdirSync(entriesDir)
  } catch {
    return []
  }
  for (const day of days) {
    const dayDir = path.join(entriesDir, day)
    let names: string[] = []
    try {
      names = fs.readdirSync(dayDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      try {
        const raw = fs.readFileSync(path.join(dayDir, name), 'utf8')
        const meta = parseMeta(raw, day)
        if (meta) out.push(meta)
      } catch {
        /* 깨진 엔트리는 건너뜀 */
      }
    }
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return out
}

/** 한 엔트리 원문 + diff 스냅샷 텍스트. */
export function readJournal(cwd: string, id: string): JournalEntry | null {
  if (!ID_RE.test(id)) return null // 경로 traversal 방지
  const root = path.join(path.resolve(cwd || '.'), JOURNAL_DIR)
  const day = id.slice(0, 4) + '-' + id.slice(4, 6) + '-' + id.slice(6, 8)
  const dayDir = path.join(root, 'entries', day)
  let mdName: string | undefined
  try {
    mdName = fs.readdirSync(dayDir).find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'))
  } catch {
    return null
  }
  if (!mdName) return null
  const markdown = fs.readFileSync(path.join(dayDir, mdName), 'utf8')
  const meta = parseMeta(markdown, day)
  if (!meta) return null
  let diffText: string | null = null
  if (meta.diffRef) {
    try {
      diffText = fs.readFileSync(path.join(root, meta.diffRef), 'utf8')
    } catch {
      diffText = null
    }
  }
  return { meta, markdown, diffText }
}

/** 우리가 쓴 front-matter를 되읽는 최소 파서(완전한 YAML 아님). */
function parseMeta(md: string, day: string): JournalEntryMeta | null {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  if (end < 0) return null
  const fm = md.slice(3, end)
  const get = (k: string): string | null => {
    const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))
    return m ? m[1].trim() : null
  }
  const id = get('id')
  if (!id) return null
  const arr = (s: string | null): string[] =>
    !s || s === '[]'
      ? []
      : s
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((x) => x.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"'))
          .filter(Boolean)
  const num = (s: string | null): number | null => (s && s !== 'null' ? Number(s) : null)
  const str = (s: string | null): string => (s ? s.replace(/^"|"$/g, '').replace(/\\"/g, '"') : '')
  return {
    id,
    timestamp: str(get('timestamp')),
    category: (get('category') ?? 'chore') as JournalCategory,
    title: str(get('title')),
    model: str(get('model')),
    changedFiles: arr(get('changed_files')),
    diffRef: get('diff_ref') && get('diff_ref') !== 'null' ? str(get('diff_ref')) : null,
    costUsd: num(get('cost_usd')),
    durationMs: num(get('duration_ms')),
    numTurns: num(get('num_turns')),
    sessionId: get('session_id') && get('session_id') !== 'null' ? str(get('session_id')) : null,
    day
  }
}

// ── 작은 유틸 ────────────────────────────────────────────────
const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const rand4 = (): string => Math.random().toString(36).slice(2, 6).padStart(4, '0')

function isoLocal(d: Date): string {
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(tz / 60)}:${pad(tz % 60)}`
}

/** YAML 스칼라 따옴표 처리 — 항상 쌍따옴표로 감싸 단순화. */
function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
