import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import type { EngineEvent, RunRequest, PlanGoal, PlanStatus, PlanSubtask, Todo } from '@shared/protocol'
import { atomicWriteFileSync } from './journal'

const SUBTASK_ID_RE = /^st-\d+$/

/* ============================================================
 * Planner (.journal/plan/) — 목표→서브태스크→일지 3단 위계 (읽기)
 *
 * 에이전트가 `.journal/plan/<goalId>-<slug>.md` 를 작성하고(스킬로 포맷 주입),
 * 앱은 그걸 읽어 렌더한다. 시간 버킷 아님 — 상태로만 관리. 일지 연동은
 * "## 연결된 일지" 매핑(subtask id → entry id 목록)으로 Planner가 보관한다.
 *
 *   ---
 *   id: g-20260618-ab12
 *   title: ...
 *   status: active        # active | done | dropped
 *   created: 2026-06-18T..
 *   ---
 *   ## 서브태스크
 *   - [ ] (st-1) ...
 *   - [x] (st-2) ...
 *   ## 연결된 일지
 *   - st-1: 20260618-143205-a1b2, 20260618-150112-cd34
 * ============================================================ */

const PLAN_REL = path.join('.journal', 'plan')
const STATUSES: PlanStatus[] = ['active', 'done', 'dropped']

/** cwd의 .journal/plan/*.md 를 읽어 목표 목록으로(진행 중 먼저, 최신 생성순). */
export function listPlans(cwd: string): PlanGoal[] {
  const dir = path.join(path.resolve(cwd || '.'), PLAN_REL)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const goals: PlanGoal[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const g = parseGoal(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (g) goals.push(g)
    } catch {
      /* 깨진 목표 파일은 건너뜀 */
    }
  }
  const rank = (s: PlanStatus): number => (s === 'active' ? 0 : s === 'done' ? 1 : 2)
  goals.sort((a, b) =>
    rank(a.status) !== rank(b.status)
      ? rank(a.status) - rank(b.status)
      : (b.created ?? '').localeCompare(a.created ?? '')
  )
  return goals
}

function parseGoal(md: string): PlanGoal | null {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  if (end < 0) return null
  const fm = md.slice(3, end)
  const body = md.slice(end + 4)
  const get = (k: string): string | null => {
    const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^"|"$/g, '') : null
  }
  const id = get('id')
  if (!id) return null
  const rawStatus = (get('status') ?? 'active') as PlanStatus
  const status: PlanStatus = STATUSES.includes(rawStatus) ? rawStatus : 'active'

  // "## 연결된 일지" 매핑(다음 ## 헤딩 또는 끝까지)
  const links = new Map<string, string[]>()
  const linkSec = body.match(/##[^\n]*연결된 일지[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)
  if (linkSec) {
    for (const line of linkSec[1].split('\n')) {
      const m = line.match(/^-\s*([a-z0-9-]+)\s*:\s*(.+)$/i)
      if (m) {
        links.set(
          m[1],
          m[2]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    }
  }

  // 서브태스크 체크리스트
  const subtasks: PlanSubtask[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s*\[([ xX])\]\s*\(([a-z0-9-]+)\)\s*(.*)$/)
    if (m) {
      subtasks.push({
        id: m[2],
        label: m[3].trim(),
        done: m[1].toLowerCase() === 'x',
        entryIds: links.get(m[2]) ?? []
      })
    }
  }

  const sessionId = get('session_id')
  return {
    id,
    title: get('title') ?? id,
    status,
    created: get('created'),
    sessionId: sessionId && sessionId !== 'null' ? sessionId : null,
    subtasks
  }
}

// ── 편집 (M-P2) — 마크다운을 외과적으로 수정해 다른 내용은 보존한다 ──────
const PLAN_STATUSES: PlanStatus[] = ['active', 'done', 'dropped']

/** goalId(front-matter id)로 파일 경로를 찾는다. id를 경로에 쓰지 않아 traversal 안전. */
function findGoalFile(cwd: string, goalId: string): string | null {
  const dir = path.join(path.resolve(cwd || '.'), PLAN_REL)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const p = path.join(dir, name)
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const m = raw.match(/^id:\s*(.*)$/m)
      if (m && m[1].trim().replace(/^"|"$/g, '') === goalId) return p
    } catch {
      /* skip */
    }
  }
  return null
}

/** 공통: goal 파일을 읽어 transform한 결과를 다시 쓴다. 변경 없으면 false. */
function editGoalFile(cwd: string, goalId: string, transform: (md: string) => string | null): boolean {
  const p = findGoalFile(cwd, goalId)
  if (!p) return false
  let md: string
  try {
    md = fs.readFileSync(p, 'utf8')
  } catch {
    return false
  }
  const next = transform(md)
  if (next == null || next === md) return false
  atomicWriteFileSync(p, next)
  return true
}

/** 서브태스크 완료 토글 — 해당 체크리스트 줄의 [ ]↔[x] 만 바꾼다. */
export function setSubtaskDone(cwd: string, goalId: string, subtaskId: string, done: boolean): boolean {
  if (!SUBTASK_ID_RE.test(subtaskId)) return false
  const re = new RegExp(`^(-\\s*\\[)[ xX](\\]\\s*\\(${subtaskId}\\))`, 'm')
  return editGoalFile(cwd, goalId, (md) => (re.test(md) ? md.replace(re, `$1${done ? 'x' : ' '}$2`) : null))
}

/** 목표 상태 변경 — front-matter status 줄만 바꾼다. */
export function setGoalStatus(cwd: string, goalId: string, status: PlanStatus): boolean {
  if (!PLAN_STATUSES.includes(status)) return false
  return editGoalFile(cwd, goalId, (md) => {
    if (!md.startsWith('---')) return null
    const end = md.indexOf('\n---', 3)
    if (end < 0) return null
    const fm = md.slice(0, end)
    const body = md.slice(end)
    const re = /^(status:\s*).*$/m
    const nextFm = re.test(fm) ? fm.replace(re, `$1${status}`) : `${fm}\nstatus: ${status}`
    return nextFm + body
  })
}

/** "## 연결된 일지" 섹션에서 한 서브태스크의 entry id 목록 줄을 만들거나 고친다. */
function setLinkLine(md: string, subtaskId: string, entryIds: string[]): string {
  const lines = md.split('\n')
  const newLine = `- ${subtaskId}: ${entryIds.join(', ')}`
  const secIdx = lines.findIndex((l) => /^##.*연결된 일지/.test(l))
  const lineRe = new RegExp(`^-\\s*${subtaskId}\\s*:`)
  if (secIdx >= 0) {
    let end = lines.length
    for (let i = secIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    const at = lines.slice(secIdx + 1, end).findIndex((l) => lineRe.test(l))
    if (at >= 0) {
      if (entryIds.length === 0) lines.splice(secIdx + 1 + at, 1)
      else lines[secIdx + 1 + at] = newLine
    } else if (entryIds.length > 0) {
      lines.splice(end, 0, newLine)
    }
    return lines.join('\n')
  }
  if (entryIds.length === 0) return md
  return md.replace(/\s*$/, '') + `\n\n## 연결된 일지\n${newLine}\n`
}

/** 서브태스크에 일지 엔트리를 연결/해제한다 (중복 추가 무시). */
export function linkEntry(cwd: string, goalId: string, subtaskId: string, entryId: string, linked: boolean): boolean {
  if (!SUBTASK_ID_RE.test(subtaskId)) return false
  return editGoalFile(cwd, goalId, (md) => {
    const g = parseGoal(md)
    if (!g) return null
    const sub = g.subtasks.find((s) => s.id === subtaskId)
    if (!sub) return null
    const current = sub.entryIds
    const next = linked
      ? current.includes(entryId) ? current : [...current, entryId]
      : current.filter((id) => id !== entryId)
    if (next.length === current.length && next.every((v, i) => v === current[i])) return null
    return setLinkLine(md, subtaskId, next)
  })
}

/** 서브태스크 추가 — 다음 (st-N) 번호로 체크리스트 줄을 삽입한다. */
export function addSubtask(cwd: string, goalId: string, label: string): boolean {
  const clean = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  if (!clean) return false
  return editGoalFile(cwd, goalId, (md) => {
    let max = 0
    for (const m of md.matchAll(/\(st-(\d+)\)/g)) max = Math.max(max, Number(m[1]))
    const line = `- [ ] (st-${max + 1}) ${clean}`
    const lines = md.split('\n')
    // 마지막 서브태스크 체크리스트 줄 다음에 삽입
    let at = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^-\s*\[[ xX]\]\s*\(st-\d+\)/.test(lines[i])) at = i
    }
    if (at >= 0) {
      lines.splice(at + 1, 0, line)
      return lines.join('\n')
    }
    // 체크리스트가 없으면 "## 서브태스크" 헤딩 뒤에, 그것도 없으면 새 섹션으로
    const h = lines.findIndex((l) => /^##\s.*서브태스크/.test(l))
    if (h >= 0) {
      lines.splice(h + 1, 0, line)
      return lines.join('\n')
    }
    return md.replace(/\s*$/, '') + `\n\n## 서브태스크\n${line}\n`
  })
}

// ── 자동 캡처 (할일 도구 → 세션 작업 계획) ───────────────────
// 엔진이 TodoWrite/TaskCreate를 가로채 'todos' 이벤트로 흘려보내면, 그 현재 상태를
// .journal/plan/ 의 "세션=목표" 파일로 기록한다(모델 협조 불필요). 목표↔일지 연결은
// 일지 메타의 sessionId로 도출하므로 여기선 서브태스크만 갱신한다.
interface PSession {
  sessionId: string
  cwd: string
  prompt: string
  goalId: string
  created: string
}

// 'todos' 이벤트는 한 턴에서 여러 번 올 수 있어(작업 진행마다 갱신) 매번 디스크에
// 쓰면 낭비. 짧게 모아 마지막 상태만 쓴다 — run 종료(drop)시에도 미반영분을 흘려보낸다.
const FLUSH_MS = 1500

interface PendingWrite {
  session: PSession
  todos: Todo[]
  timer: ReturnType<typeof setTimeout>
}

export class PlannerRecorder {
  private pending = new Map<string, RunRequest>()
  private active = new Map<string, PSession>()
  private writes = new Map<string, PendingWrite>()

  onRunStart(key: string, req: RunRequest): void {
    this.pending.set(key, req)
  }

  observe(key: string, e: EngineEvent): void {
    if (e.type === 'session') {
      const req = this.pending.get(key)
      this.pending.delete(key)
      const hash = e.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase()
      if (!hash) return
      this.active.set(key, {
        sessionId: e.sessionId,
        cwd: e.cwd,
        prompt: req?.prompt ?? '',
        goalId: `g-${hash}`,
        created: isoLocal(new Date())
      })
    } else if (e.type === 'todos') {
      const s = this.active.get(key)
      if (!s || e.todos.length === 0) return
      this.scheduleWrite(key, s, e.todos)
    }
  }

  /** 디바운스 타이머를 잡고, 자리가 있으면 갈아치운다(마지막 todos만 살아남음). */
  private scheduleWrite(key: string, session: PSession, todos: Todo[]): void {
    const existing = this.writes.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => this.flush(key), FLUSH_MS)
    this.writes.set(key, { session, todos, timer })
  }

  private flush(key: string): void {
    const w = this.writes.get(key)
    if (!w) return
    this.writes.delete(key)
    try {
      writeSessionGoal(w.session, w.todos)
    } catch (err) {
      console.error('[planner] 세션 목표 기록 실패:', err)
    }
  }

  /** run이 끝나기 전에 패널이 사라지면(dispose) 미반영분을 즉시 흘려보낸다. */
  drop(key: string): void {
    this.pending.delete(key)
    this.active.delete(key)
    const w = this.writes.get(key)
    if (w) {
      clearTimeout(w.timer)
      this.flush(key)
    }
  }
}

function writeSessionGoal(s: PSession, todos: Todo[]): void {
  const abs = path.resolve(s.cwd || '.')
  if (!s.cwd || abs === path.resolve(os.homedir())) return // 홈/빈 cwd면 기록 안 함
  const dir = path.join(abs, PLAN_REL)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${s.goalId}.md`)

  const allDone = todos.length > 0 && todos.every((t) => t.status === 'done')
  const lines = todos
    .map((t, i) => `- [${t.status === 'done' ? 'x' : ' '}] (st-${i + 1}) ${oneLine(t.label)}`)
    .join('\n')
  const section = `## 서브태스크\n${lines}\n`

  if (fs.existsSync(file)) {
    let md = fs.readFileSync(file, 'utf8')
    const re = /(##[^\n]*서브태스크[^\n]*\n)[\s\S]*?(?=\n##\s|$)/
    md = re.test(md) ? md.replace(re, `$1${lines}\n`) : md.replace(/\s*$/, '') + `\n\n${section}`
    // 모든 서브태스크가 완료됐고 사용자가 dropped로 보류시키지 않았으면 active→done 자동 전환.
    const statusM = md.match(/^status:\s*(.*)$/m)
    if (allDone && statusM && statusM[1].trim() === 'active') {
      md = md.replace(/^(status:\s*).*$/m, '$1done')
    }
    atomicWriteFileSync(file, md)
    return
  }

  const title = oneLine(s.prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '') || '작업 세션'
  const md =
    `---\n` +
    `id: ${s.goalId}\n` +
    `title: ${yamlStr(title.length > 70 ? title.slice(0, 69) + '…' : title)}\n` +
    `status: ${allDone ? 'done' : 'active'}\n` +
    `session_id: ${yamlStr(s.sessionId)}\n` +
    `created: ${s.created}\n` +
    `---\n${section}`
  atomicWriteFileSync(file, md)
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()
const pad2p = (n: number): string => String(n).padStart(2, '0')
function isoLocal(d: Date): string {
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad2p(d.getMonth() + 1)}-${pad2p(d.getDate())}` +
    `T${pad2p(d.getHours())}:${pad2p(d.getMinutes())}:${pad2p(d.getSeconds())}` +
    `${sign}${pad2p(tz / 60)}:${pad2p(tz % 60)}`
  )
}
function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
