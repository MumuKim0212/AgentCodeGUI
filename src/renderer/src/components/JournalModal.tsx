import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JournalEntryMeta, JournalEntry, JournalCategory } from '@shared/protocol'
import { Markdown } from './Markdown'
import { IconBook, IconClose, IconMax, IconRefresh, IconRestore } from './icons'
import { useResizableModal, ModalResizeHandles } from './resizableModal'

// 프로젝트-로컬 자동 작업 일지(.journal/) 뷰어. 메인 프로세스가 턴 종료마다 남긴
// 마크다운을 타임라인으로 렌더해 "clone하면 전 과정 복원"을 화면에서 완성한다.
// 데이터는 전부 읽기 전용 IPC(window.api.journal). diff는 저장된 .diff 텍스트를
// 경량 렌더(색칠한 줄)로 보여준다 — 기존 코드 뷰어 재사용은 추후(TODO).

const CAT: Record<JournalCategory, { label: string; cls: string }> = {
  bugfix: { label: '버그', cls: 'bug' },
  feature: { label: '기능', cls: 'feat' },
  refactor: { label: '리팩', cls: 'refac' },
  error: { label: '에러', cls: 'err' },
  chore: { label: '잡일', cls: 'chore' }
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

export function JournalModal({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const rz = useResizableModal('journal.modal', true)
  const [list, setList] = useState<JournalEntryMeta[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [entry, setEntry] = useState<JournalEntry | null>(null)

  const reload = useCallback(() => {
    window.api.journal
      .list(cwd)
      .then((r) => {
        setList(r)
        setSel((s) => s ?? r[0]?.id ?? null)
      })
      .catch(() => setList([]))
  }, [cwd])

  useEffect(() => reload(), [reload])

  useEffect(() => {
    if (!sel) {
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
  }, [cwd, sel])

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

  const body = useMemo(() => (entry ? bodyOf(entry.markdown) : ''), [entry])
  const diffLines = useMemo(
    () => (entry?.diffText ? entry.diffText.replace(/\n$/, '').split('\n') : []),
    [entry]
  )

  const empty = list != null && list.length === 0

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
            {empty && <div className="jrn-empty">아직 기록된 일지가 없어요.</div>}
            {groups.map((grp) => (
              <div key={grp.day}>
                <div className="gitm-sec">{dayHeader(grp.day)}</div>
                {grp.items.map((m) => {
                  const cat = CAT[m.category] ?? CAT.chore
                  return (
                    <button
                      key={m.id}
                      className={'jrn-item' + (m.id === sel ? ' on' : '')}
                      onClick={() => setSel(m.id)}
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
            {entry ? (
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
              !empty && <div className="jrn-empty">왼쪽에서 일지를 선택하세요.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
