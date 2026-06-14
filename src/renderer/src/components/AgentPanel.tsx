import { memo, useEffect } from 'react'
import type { AgentStatus, ChangedFile, SubAgentInfo, SubAgentStatus, Todo } from '@shared/protocol'
import { IconList, IconBot, IconFile, IconChevRight, IconCheck, IconSearch, IconClose } from './icons'
import { FileBadge } from './fileType'
import { Markdown } from './Markdown'

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '대기 중',
  analyzing: '분석 중',
  working: '작업 중',
  done: '완료',
  error: '오류'
}

function fmtElapsed(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function StatusPill({ status, elapsed }: { status: AgentStatus; elapsed: number }) {
  return (
    <div className={'status-pill ' + status}>
      <span className="d" />
      <span>{STATUS_LABEL[status]}</span>
      {status !== 'idle' && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.8 }}>{fmtElapsed(elapsed)}</span>
      )}
    </div>
  )
}

function Todos({ todos }: { todos: Todo[] }) {
  const total = todos.length
  const done = todos.filter((t) => t.status === 'done').length
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div>
      <div className="progress">
        <i style={{ width: pct + '%' }} />
      </div>
      <div className="todos scroll">
        {todos.map((t) => (
          <div key={t.id} className={'todo ' + t.status}>
            <span className="box">{t.status === 'done' && <IconCheck size={12} />}</span>
            <span className="lab">{t.label}</span>
            {t.status === 'running' && (
              <span style={{ marginLeft: 'auto' }}>
                <span className="spin" />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function FileRow({ f, onOpen }: { f: ChangedFile; onOpen: (f: ChangedFile) => void }) {
  const slash = f.path.lastIndexOf('/')
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <button className="file" data-tip={f.path} onClick={() => onOpen(f)}>
      <FileBadge path={f.path} size={18} />
      <span className="path">
        <span className="dir">{dir}</span>
        {name}
      </span>
      <span className="stat">
        {f.add ? <span className="add">+{f.add}</span> : null}
        {f.del ? <span className="del">−{f.del}</span> : null}
        <span className={'tag ' + (f.tag === 'new' ? 'new' : 'edit')}>{f.tag === 'new' ? 'NEW' : 'EDIT'}</span>
      </span>
      <IconChevRight size={14} className="fchev" />
    </button>
  )
}

function saIcon(name: string, size: number) {
  const n = name.toLowerCase()
  if (n.includes('explore') || n.includes('search') || n.includes('탐색')) return <IconSearch size={size} />
  if (n.includes('verify') || n.includes('test') || n.includes('검증')) return <IconCheck size={size} />
  if (n.includes('build') || n.includes('구현') || n.includes('code')) return <IconFile size={size} />
  return <IconBot size={size} />
}

const SA_STATUS_LABEL: Record<SubAgentStatus, string> = {
  queued: '대기 중',
  running: '실행 중',
  done: '완료'
}

// compact row — title + one-line description + status. The detail/output (full
// description, tools, result) lives in the card opened on click, so the panel
// stays tidy even with several subagents.
function SubAgent({ a, onOpen }: { a: SubAgentInfo; onOpen: (a: SubAgentInfo) => void }) {
  return (
    <button className={'subagent ' + a.status} onClick={() => onOpen(a)}>
      <span className="sa-ic">{saIcon(a.name, 15)}</span>
      <div className="sa-main">
        <div className="sa-name">{a.name}</div>
        {a.role && <div className="sa-sub">{a.role}</div>}
      </div>
      <span className="sa-status">
        {a.status === 'running' && <span className="spin" />}
        {a.status === 'done' && (
          <span className="sa-check">
            <IconCheck size={12} />
          </span>
        )}
        {a.status === 'queued' && <span className="sa-dot" />}
      </span>
      <IconChevRight className="sa-chev" size={15} />
    </button>
  )
}

// centered detail card — same visual language as the settings modal / install card
export function SubAgentModal({ agent, onClose }: { agent: SubAgentInfo | null; onClose: () => void }) {
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agent, onClose])
  if (!agent) return null
  const doneCount = agent.tools.filter((t) => t.status !== 'running').length
  return (
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="sa-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sa-card-head">
          <span className={'sa-card-ic ' + agent.status}>{saIcon(agent.name, 18)}</span>
          <div className="sa-card-titles">
            <div className="sa-card-name">{agent.name}</div>
            {agent.role && <div className="sa-card-role">{agent.role}</div>}
          </div>
          <span className={'sa-card-status ' + agent.status}>{SA_STATUS_LABEL[agent.status]}</span>
          <button className="sa-card-close" onClick={onClose} aria-label="닫기">
            <IconClose size={18} />
          </button>
        </div>
        <div className="sa-card-body scroll">
          {agent.activity && (
            <div className="sa-card-sec">
              <div className="sa-card-lbl">{agent.status === 'done' ? '결과' : '설명'}</div>
              <div className="content sa-card-md">
                <Markdown text={agent.activity} />
              </div>
            </div>
          )}
          <div className="sa-card-sec">
            <div className="sa-card-lbl">
              도구 {doneCount}/{agent.tools.length}
            </div>
            {agent.tools.length ? (
              <div className="sa-tools">
                {agent.tools.map((t) => (
                  <div className={'sa-tool ' + t.status} key={t.id}>
                    <span className="sa-tool-verb">{t.verb}</span>
                    <span className="sa-tool-target">{t.target}</span>
                    <span className="sa-tool-st">
                      {t.status === 'running' ? <span className="spin" /> : t.status === 'done' ? <IconCheck size={12} /> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ag-none">사용한 도구가 없어요</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// memoized so composer typing (which re-renders the app) doesn't re-render the
// panel — only re-renders when its own data (status/todos/files/terminal…) changes
export const AgentPanel = memo(function AgentPanel({
  status,
  elapsed,
  todos,
  files,
  subagents,
  onOpenFile,
  onOpenSubagent
}: {
  status: AgentStatus
  elapsed: number
  todos: Todo[]
  files: ChangedFile[]
  subagents: SubAgentInfo[]
  onOpenFile: (f: ChangedFile) => void
  onOpenSubagent: (a: SubAgentInfo) => void
}) {
  const busy = status === 'analyzing' || status === 'working'
  const runningSub = subagents.filter((a) => a.status === 'running').length
  const doneSub = subagents.filter((a) => a.status === 'done').length
  return (
    <section className="agent">
      <div className="ag-head">
        <span className="t">에이전트</span>
        <span className="spacer" />
        <StatusPill status={status} elapsed={elapsed} />
      </div>
      <div className="ag-scroll scroll">
        <div className="ag-sec">
          <div className="sh">
            <IconList size={14} style={{ color: 'var(--text-2)' }} />
            <span className="lbl">할 일</span>
            <span className="count">
              {todos.filter((t) => t.status === 'done').length}/{todos.length || 0}
            </span>
          </div>
          {todos.length ? (
            <Todos todos={todos} />
          ) : (
            <div className="ag-none">{busy ? '계획을 수립하는 중…' : '아직 할 일이 없어요'}</div>
          )}
        </div>

        <div className="ag-sec">
          <div className="sh">
            <IconBot size={14} style={{ color: 'var(--text-2)' }} />
            <span className="lbl">서브에이전트</span>
            <span className="count">{runningSub > 0 ? runningSub + ' 실행 중' : doneSub + '/' + (subagents.length || 0)}</span>
          </div>
          {subagents.length ? (
            <div className="subagents scroll">
              {subagents.map((a) => (
                <SubAgent key={a.id} a={a} onOpen={onOpenSubagent} />
              ))}
            </div>
          ) : (
            <div className="ag-none">아직 서브에이전트가 없어요</div>
          )}
        </div>

        {/* grow — 변경된 파일은 패널의 남는 세로 공간을 전부 사용 (목록 최소 224px) */}
        <div className="ag-sec grow" style={{ borderBottom: 'none' }}>
          <div className="sh">
            <IconFile size={14} style={{ color: 'var(--text-2)' }} />
            <span className="lbl">변경된 파일</span>
            <span className="count">{files.length}</span>
          </div>
          {files.length ? (
            <div className="files scroll">
              {files.map((f) => (
                <FileRow key={f.path} f={f} onOpen={onOpenFile} />
              ))}
            </div>
          ) : (
            <div className="ag-none">아직 변경된 파일이 없어요</div>
          )}
        </div>
      </div>
    </section>
  )
})
