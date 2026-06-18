import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JournalEntryMeta, JournalEntry, JournalCategory } from '@shared/protocol'
import { Markdown } from './Markdown'
import { IconBook, IconClose, IconClock, IconMax, IconRefresh, IconRestore } from './icons'
import { useResizableModal, ModalResizeHandles } from './resizableModal'

// 프로젝트-로컬 자동 작업 일지(.journal/) 뷰어. 메인 프로세스가 턴 종료마다 남긴
// 마크다운을 (1) Today 브리프(워크데이 경계 집계)와 (2) 전체 타임라인으로 렌더해
// "clone하면 전 과정 복원"을 화면에서 완성한다. 데이터는 읽기 전용 IPC.

const CAT: Record<JournalCategory, { label: string; cls: string }> = {
  bugfix: { label: '버그', cls: 'bug' },
  feature: { label: '기능', cls: 'feat' },
  refactor: { label: '리팩', cls: 'refac' },
  error: { label: '에러', cls: 'err' },
  chore: { label: '잡일', cls: 'chore' }
}
const CAT_ORDER: JournalCategory[] = ['feature', 'bugfix', 'refactor', 'error', 'chore']

// 워크데이 경계 — 새벽 이 시각 전에 한 작업은 '전날'로 묶는다(심야 작업 보정).
const DAY_START_HOUR = 4

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 타임스탬프(또는 now)를 워크데이 키(YYYY-MM-DD)로. 작성자 로컬 벽시계 기준. */
function workdayKey(y: number, mo: number, d: number, h: number): string {
  const date = new Date(y, mo - 1, d)
  if (h < DAY_START_HOUR) date.setDate(date.getDate() - 1)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
function workdayOf(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/)
  if (!m) return iso.slice(0, 10)
  return workdayKey(+m[1], +m[2], +m[3], +m[4])
}

function dayHeader(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const that = new Date(y, m - 1, d).getTime()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.round((today - that) / 86_400_000)
  if (diff === 0) return '오늘'
  if (diff === 1) return '어제'
  if (y !== now.getFullYear()) return `${y}년 ${m}월 ${d}일`
  return `${m}월 ${d}일`
}

function timeOf(ts: string): string {
  const m = ts.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

/** 프론트매터와 우리가 단 diff 링크 줄을 떼고 본문만 남긴다(뷰어가 diff를 직접 그림). */
function bodyOf(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/^→ diff 스냅샷:.*$/m, '')
    .trim()
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'head' | 'ctx'
function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) return 'head'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

interface BriefStat {
  count: number
  cats: Partial<Record<JournalCategory, number>>
  files: number
}
function summarize(items: JournalEntryMeta[]): BriefStat {
  const cats: Partial<Record<JournalCategory, number>> = {}
  const files = new Set<string>()
  for (const m of items) {
    cats[m.category] = (cats[m.category] ?? 0) + 1
    for (const f of m.changedFiles) files.add(f)
  }
  return { count: items.length, cats, files: files.size }
}

interface Brief {
  todayKey: string
  today: JournalEntryMeta[]
  prevKey: string | null
  prev: JournalEntryMeta[]
}
function buildBrief(metas: JournalEntryMeta[]): Brief {
  const now = new Date()
  const todayKey = workdayKey(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours())
  const byDay = new Map<string, JournalEntryMeta[]>()
  for (const m of metas) {
    const k = workdayOf(m.timestamp)
    const arr = byDay.get(k)
    if (arr) arr.push(m)
    else byDay.set(k, [m])
  }
  const prevKey =
    [...byDay.keys()].filter((k) => k < todayKey).sort().reverse()[0] ?? null
  return {
    todayKey,
    today: byDay.get(todayKey) ?? [],
    prevKey,
    prev: prevKey ? byDay.get(prevKey)! : []
  }
}

export function JournalModal({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const rz = useResizableModal('journal.modal', true)
  const [list, setList] = useState<JournalEntryMeta[] | null>(null)
  const [view, setView] = useState<'brief' | 'entry'>('brief')
  const [sel, setSel] = useState<string | null>(null)
  const [entry, setEntry] = useState<JournalEntry | null>(null)

  const reload = useCallback(() => {
    window.api.journal
      .list(cwd)
      .then((r) => setList(r))
      .catch(() => setList([]))
  }, [cwd])

  useEffect(() => reload(), [reload])

  useEffect(() => {
    if (view !== 'entry' || !sel) {
      setEntry(null)
      return
    }
    let live = true
    window.api.journal.read(cwd, sel).then((e) => {
      if (live) setEntry(e)
    })
    return () => {
      live = false
    }
  }, [cwd, sel, view])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const groups = useMemo(() => {
    const g: { day: string; items: JournalEntryMeta[] }[] = []
    for (const m of list ?? []) {
      let last = g[g.length - 1]
      if (!last || last.day !== m.day) {
        last = { day: m.day, items: [] }
        g.push(last)
      }
      last.items.push(m)
    }
    return g
  }, [list])

  const brief = useMemo(() => buildBrief(list ?? []), [list])
  const body = useMemo(() => (entry ? bodyOf(entry.markdown) : ''), [entry])
  const diffLines = useMemo(
    () => (entry?.diffText ? entry.diffText.replace(/\n$/, '').split('\n') : []),
    [entry]
  )

  const empty = list != null && list.length === 0
  const openEntry = (id: string): void => {
    setSel(id)
    setView('entry')
  }

  return (
    <div
      className="gitm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="gitm-modal rzm jrn" ref={rz.ref} style={rz.modalStyle}>
        {!rz.maximized && <ModalResizeHandles onStart={rz.startResize} />}
        <div className="diff-head" onDoubleClick={rz.onHeaderDoubleClick}>
          <span className="gitm-ic">
            <IconBook size={16} />
          </span>
          <span className="gitm-name">작업 일지</span>
          {list && <span className="gitm-br">{list.length}개</span>}
          <span className="gitm-path">{cwd}</span>
          <span className="dspacer" />
          <button className="dclose htip" onClick={reload} aria-label="새로고침" data-tip="새로고침">
            <IconRefresh size={15} />
          </button>
          <button
            className="dclose htip"
            onClick={rz.toggleMaximize}
            aria-label={rz.maximized ? '이전 크기로' : '최대화'}
            data-tip={rz.maximized ? '이전 크기로' : '최대화'}
          >
            {rz.maximized ? <IconRestore size={15} /> : <IconMax size={13} />}
          </button>
          <button className="dclose htip" onClick={onClose} aria-label="닫기" data-tip="닫기 (Esc)">
            <IconClose size={16} />
          </button>
        </div>

        <div className="gitm-body">
          <nav className="gitm-nav scroll">
            <button
              className={'gitm-item' + (view === 'brief' ? ' on' : '')}
              onClick={() => setView('brief')}
            >
              <span className="ic">
                <IconClock size={13} />
              </span>
              Today 브리프
            </button>
            <div className="gitm-sec">전체 타임라인</div>
            {empty && <div className="jrn-empty">아직 기록된 일지가 없어요.</div>}
            {groups.map((grp) => (
              <div key={grp.day}>
                <div className="gitm-sec">{dayHeader(grp.day)}</div>
                {grp.items.map((m) => {
                  const cat = CAT[m.category] ?? CAT.chore
                  return (
                    <button
                      key={m.id}
                      className={'jrn-item' + (view === 'entry' && m.id === sel ? ' on' : '')}
                      onClick={() => openEntry(m.id)}
                    >
                      <span className={'jrn-badge ' + cat.cls}>{cat.label}</span>
                      <span className="jrn-ti">{m.title}</span>
                      <span className="jrn-tm">{timeOf(m.timestamp)}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          <div className="jrn-detail scroll">
            {view === 'brief' ? (
              <BriefView brief={brief} empty={empty} onOpen={openEntry} />
            ) : entry ? (
              <>
                <div className="jrn-meta">
                  <span className={'jrn-badge ' + (CAT[entry.meta.category] ?? CAT.chore).cls}>
                    {(CAT[entry.meta.category] ?? CAT.chore).label}
                  </span>
                  <code className="jrn-chip">{entry.meta.model}</code>
                  <span className="jrn-chip">{entry.meta.changedFiles.length}개 파일</span>
                  {entry.meta.numTurns != null && (
                    <span className="jrn-chip">{entry.meta.numTurns}턴</span>
                  )}
                  {entry.meta.costUsd != null && (
                    <span className="jrn-chip">${entry.meta.costUsd.toFixed(2)}</span>
                  )}
                  <span className="jrn-chip dim">{entry.meta.timestamp.replace('T', ' ').slice(0, 16)}</span>
                </div>
                <div className="jrn-md">
                  <Markdown text={body} />
                </div>
                {diffLines.length > 0 && (
                  <details className="jrn-diffwrap" open>
                    <summary>diff 스냅샷</summary>
                    <pre className="jrn-diff">
                      {diffLines.map((ln, i) => (
                        <div key={i} className={'ln ' + classifyDiffLine(ln)}>
                          {ln || ' '}
                        </div>
                      ))}
                    </pre>
                  </details>
                )}
              </>
            ) : (
              <div className="jrn-empty">일지를 불러오는 중…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Today 브리프 ─────────────────────────────────────────────
function BriefView({
  brief,
  empty,
  onOpen
}: {
  brief: Brief
  empty: boolean
  onOpen: (id: string) => void
}) {
  if (empty) return <div className="jrn-empty">아직 기록된 일지가 없어요.</div>
  return (
    <div className="jrn-brief">
      <BriefSection title="오늘" sub={dayHeader(brief.todayKey)} items={brief.today} onOpen={onOpen} />
      <BriefSection
        title="어제 끝낸 것"
        sub={brief.prevKey ? dayHeader(brief.prevKey) : '—'}
        items={brief.prev}
        onOpen={onOpen}
      />
      <div className="jrn-bsec">
        <div className="jrn-bhead">
          <h4>다음</h4>
        </div>
        <div className="jrn-next">Planner(Tier 2) 연동 예정 — 목표·서브태스크가 여기 모입니다.</div>
      </div>
    </div>
  )
}

function BriefSection({
  title,
  sub,
  items,
  onOpen
}: {
  title: string
  sub: string
  items: JournalEntryMeta[]
  onOpen: (id: string) => void
}) {
  const stat = summarize(items)
  return (
    <div className="jrn-bsec">
      <div className="jrn-bhead">
        <h4>{title}</h4>
        <span className="jrn-bsub">{sub}</span>
        <span className="jrn-bspacer" />
        {stat.count > 0 && (
          <span className="jrn-bsum">
            {stat.count}건 · 파일 {stat.files}개
          </span>
        )}
      </div>
      {stat.count === 0 ? (
        <div className="jrn-next">기록 없음.</div>
      ) : (
        <>
          <div className="jrn-bcats">
            {CAT_ORDER.filter((c) => stat.cats[c]).map((c) => (
              <span key={c} className={'jrn-badge ' + CAT[c].cls}>
                {CAT[c].label} {stat.cats[c]}
              </span>
            ))}
          </div>
          <div className="jrn-blist">
            {items.map((m) => (
              <button key={m.id} className="jrn-item" onClick={() => onOpen(m.id)}>
                <span className={'jrn-badge ' + (CAT[m.category] ?? CAT.chore).cls}>
                  {(CAT[m.category] ?? CAT.chore).label}
                </span>
                <span className="jrn-ti">{m.title}</span>
                <span className="jrn-tm">{timeOf(m.timestamp)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
