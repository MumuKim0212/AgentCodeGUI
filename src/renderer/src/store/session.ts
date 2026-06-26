import { useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentStatus,
  AgentQuestion,
  ChangedFile,
  EngineEvent,
  FileDiff,
  PlanGoal,
  SubAgentInfo,
  TermLine,
  Todo,
  ToolLogItem
} from '@shared/protocol'

export type ThreadItem =
  | { kind: 'msg'; id: string; role: 'user' | 'assistant'; text: string; animate: boolean; error?: boolean; time: string; images?: string[] }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'toolgroup'; id: string; tools: ToolLogItem[]; time: string }
  // a "/command" card (slash commands only — skills/​/clear excluded). Shown the
  // moment the command starts (running:true, with a spinner) and updated in place to
  // the completed summary when it finishes — so the run is never a blank freeze.
  | {
      kind: 'cmdresult'
      id: string
      name: string
      title: string
      sub: string | null
      stats: string | null
      time: string
      running: boolean
      failed?: boolean
    }
  // 시스템 경고를 스레드에 인라인으로 보여주는 줄 (예: 정책 거부 → 모델 자동 전환)
  | { kind: 'notice'; id: string; text: string; time: string }

export interface SessionState {
  status: AgentStatus
  messages: ThreadItem[]
  todos: Todo[]
  files: ChangedFile[]
  diffs: Record<string, FileDiff>
  terminal: TermLine[]
  subagents: SubAgentInfo[]
  pendingPermission: { requestId: string; toolName: string; summary: string } | null
  pendingQuestion: { requestId: string; questions: AgentQuestion[] } | null
  session: { sessionId: string; model: string; cwd: string } | null
  result: {
    costUsd: number | null
    durationMs: number | null
    numTurns: number | null
    contextTokens: number | null
    contextWindow: number | null
  } | null
  // set while a slash command run is in flight; consumed on 'result' to finalize its
  // card (cardId points at the running card pushed in 'begin')
  pendingCommand: { name: string; beforeContext: number | null; beforeMsgs: number; cardId: string } | null
  thinkingText: string | null
  openGroupId: string | null
  seq: number
}

type Action =
  | { type: 'begin'; text: string; time: string; command: string | null; images?: string[] }
  | { type: 'engine'; event: EngineEvent }
  | { type: 'clear-permission' }
  | { type: 'clear-question' }
  | { type: 'load'; state: SessionState }

const THINKING_ID = 'thinking'

export function nowTime(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
}

// Slash commands that get a card. Skills and /clear (client-side) are excluded.
// `running` is the in-progress title; `sub` the static done description (/compact
// fills it dynamically).
const CMD_CARDS: Record<string, { title: string; running: string; sub: string | null }> = {
  init: { title: 'CLAUDE.md를 정리했어요', running: 'CLAUDE.md를 작성하는 중…', sub: '코드베이스를 분석해 프로젝트 가이드를 작성했습니다.' },
  compact: { title: '대화를 요약했어요', running: '대화를 요약하는 중…', sub: null },
  review: { title: '코드 리뷰를 마쳤어요', running: '코드를 리뷰하는 중…', sub: '변경 사항을 검토했습니다.' },
  'security-review': { title: '보안 검토를 마쳤어요', running: '보안을 검토하는 중…', sub: '변경 사항의 보안 취약점을 점검했습니다.' },
  plan: { title: 'Planner를 정리했어요', running: 'Planner를 정리하는 중…', sub: '목표·서브태스크를 .journal/plan/ 에 기록했습니다.' }
}
// /plan isn't a CLI built-in — it's this app's Planner (.journal/plan/) feature, so
// its authoring rules are injected into the prompt before it reaches the engine.
// This replaces the local-skill approach (.claude/skills/plan/), which only worked
// inside this repo, so /plan now behaves the same in every cwd.
export const PLAN_GUIDE = `This project's Planner is an intent layer on top of the automatic work journal (.journal/entries/).
The journal records "what happened, minute by minute"; the Planner records "which goal that belongs to."
Per the user's request, directly create or edit goal files under .journal/plan/.

Do not confuse this with the built-in todo tools (TodoWrite/TaskCreate/TaskList) — those
are temporary, session-scoped lists. The Planner is a permanent, git-tracked set of files
(.journal/plan/*.md).

Write with ordinary file tools (Write/Edit). Always use an absolute path rooted at the
current working directory (cwd, i.e. the project root) — never a relative path.

Core rules:
1. No time buckets. Never invent date- or period-based categories like "weekly goals /
   daily subtasks," and never estimate durations. Structure is purely a goal → subtask
   grouping; progress is expressed only via status (checkbox/status field).
2. No over-structuring. Don't split a goal into an elaborate hierarchy. 1-6 subtasks is
   usually enough.
3. No speculative creation. Only create a goal when the user explicitly asks to plan or
   organize.
4. Confirm before writing. Briefly propose what should become the goal/subtasks first,
   and write the file only after the user agrees.

Storage location and format — one goal = one file: .journal/plan/<goalId>-<slug>.md
- goalId: g-<YYYYMMDD>-<random4> (e.g. g-20260618-ab12)
- slug: a short kebab-case version of the title

---
id: g-20260618-ab12
title: Build the automatic-journal PM layer
status: active        # active | done | dropped
created: 2026-06-18T14:32:05+09:00
---
## Subtasks
- [ ] (st-1) Today brief
- [x] (st-2) Planner foundation
- [ ] (st-3) Semantic search

## Linked journal entries
- st-2: 20260618-143205-a1b2, 20260618-150112-cd34

Rules:
- Subtasks are a "- [ ] (st-N) description" checklist. Done is "- [x]". Never change an
  existing (st-N) id — that breaks the link. Add new subtasks with the next number.
- "## Linked journal entries" is optional, format "st-N: <entry id>, ...". A journal entry
  id is the filename prefix under .journal/entries/<date>/ (YYYYMMDD-HHmmss-xxxx). Link it
  when you know it; leave it blank if you don't — never invent one.
- Feel free to add an "## Intent" section or other notes below; the app only reads the
  two sections above.

Behavior guide:
- New goal/plan request: propose candidate goal/subtasks → create the file once the user agrees.
- Progress update: toggle the relevant subtask "- [ ]" → "- [x]", or add a new subtask.
- Linking a journal entry: if asked to attach a recent/specific entry to a subtask, add its
  id under "## Linked journal entries".
- Closing a goal: once everything is done, set front-matter status: done.
- After writing or editing, report in one line what changed.`
/** "/plan organize what we've done" → Planner authoring rules + the user's request, for the engine. */
export function buildPlanPrompt(text: string): string {
  const userPart = text.trim().slice(5).trim()
  return `${PLAN_GUIDE}\n\n## User request\n${userPart || "Organize the work done so far into the Planner."}`
}

/** "/run" 자동 진행 루프의 한 턴 프롬프트 — 지정한 목표(goal)에서 다음 미완 서브태스크
 *  하나만 구현하게 한다. 정지 판단은 앱이 plan 파일을 재조회해서 하므로(App.tsx의 루프
 *  드레인), 프롬프트엔 TASK_COMPLETE 같은 마커가 필요 없다 — "한 턴 = 한 서브태스크"만 담당. */
export function buildRunPrompt(goal: PlanGoal): string {
  const next = goal.subtasks.find((s) => s.done === false)
  const nextLine = next ? `${next.id}: ${next.label}` : '(없음 — 모든 서브태스크가 완료됨)'
  const done = goal.subtasks.filter((s) => s.done).length
  return [
    `You are progressing a plan from this project's Planner (.journal/plan/${goal.id}.md).`,
    `Goal: ${goal.title}`,
    `Progress: ${done}/${goal.subtasks.length} subtasks done.`,
    `Next uncompleted subtask → ${nextLine}`,
    ``,
    `Rules for this turn:`,
    `1. Implement ONLY this single next subtask — nothing beyond it.`,
    `2. When it's done, open .journal/plan/${goal.id}.md and change that subtask's`,
    `   "- [ ] (${next?.id ?? 'st-N'}) ..." line to "- [x] (${next?.id ?? 'st-N'}) ...".`,
    `   Never change an existing (st-N) id, and don't touch other lines.`,
    `3. If you get stuck or the subtask can't be completed, STOP and explain — do NOT`,
    `   check it off. Do not invent new subtasks.`,
    `Always use an absolute path rooted at the project root (cwd).`
  ].join('\n')
}
/** "/compact …" → "compact" when it's a card command, else null (normal prompt / skill). */
export function commandOf(text: string): string | null {
  const m = /^\/([a-z][a-z-]*)/i.exec(text.trim())
  const name = m?.[1]?.toLowerCase()
  return name && name in CMD_CARDS ? name : null
}
/** Friendly title for naming a chat started by a command. */
export function commandTitleOf(name: string): string {
  return CMD_CARDS[name]?.title ?? name
}
function fmtTokShort(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}

// Whether two working-directory paths point at the same folder. Used to gate session
// resume: a Claude Code session id is scoped to the project it was created in (its file
// lives under that cwd), so resuming it after the folder changed fails with
// "No conversation found with session ID". The engine echoes a cwd that can differ in
// format from what we sent (separators / trailing slash / drive-letter case), so we
// normalize before comparing — and treat a folder change as "start a fresh conversation".
export function sameCwd(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// Strip live/ephemeral fields before persisting a session snapshot: an in-flight run
// is frozen to idle, transient UI (terminal, open modals, thinking text) is dropped,
// and lingering subagents are marked done. Messages, todos, files, diffs, and the
// session id (for resume) are kept. Shared by the single-chat list and multi-agent panels.
export function snapshotForPersist(s: SessionState): SessionState {
  return {
    ...s,
    status: s.status === 'analyzing' || s.status === 'working' ? 'idle' : s.status,
    terminal: [],
    pendingPermission: null,
    pendingQuestion: null,
    thinkingText: null,
    openGroupId: null,
    pendingCommand: null,
    // drop a command card still mid-run — it would restore as a forever-spinning card
    messages: s.messages.filter((m) => !(m.kind === 'cmdresult' && m.running)),
    subagents: s.subagents.map((a) => (a.status === 'done' ? a : { ...a, status: 'done' as const }))
  }
}

export const initialSessionState: SessionState = {
  status: 'idle',
  messages: [],
  todos: [],
  files: [],
  diffs: {},
  terminal: [],
  subagents: [],
  pendingPermission: null,
  pendingQuestion: null,
  session: null,
  result: null,
  pendingCommand: null,
  thinkingText: null,
  openGroupId: null,
  seq: 0
}

function reducer(state: SessionState, action: Action): SessionState {
  if (action.type === 'load') {
    return action.state
  }

  if (action.type === 'clear-permission') {
    return { ...state, pendingPermission: null }
  }

  if (action.type === 'clear-question') {
    return { ...state, pendingQuestion: null }
  }

  if (action.type === 'begin') {
    const seq = state.seq + 1
    const cmd = action.command
    const without = state.messages.filter((m) => m.id !== THINKING_ID)
    const cardId = `cmd${seq}`
    return {
      ...state,
      status: 'analyzing',
      // a command run replaces the user bubble with a live "running" card (spinner)
      // pushed right away, so the run shows immediate feedback instead of a blank gap
      messages: cmd
        ? [
            ...without,
            { kind: 'cmdresult', id: cardId, name: cmd, title: CMD_CARDS[cmd].running, sub: null, stats: null, time: action.time, running: true }
          ]
        : [...without, { kind: 'msg', id: `u${seq}`, role: 'user', text: action.text, animate: false, time: action.time, images: action.images?.length ? action.images : undefined }],
      // snapshot the pre-run context so /compact can report real savings on completion
      pendingCommand: cmd
        ? { name: cmd, beforeContext: state.result?.contextTokens ?? null, beforeMsgs: without.filter((m) => m.kind === 'msg').length, cardId }
        : null,
      // 할 일 (task plan) and 변경된 파일 (cumulative diff) are session-scoped, not
      // per-turn output — keep them across messages so they don't blank out and flicker
      // back when the next turn starts. Tasks: the engine retains them per session and
      // re-emits the full list on each change (replaced, never duplicated). Files: the
      // file-change reducer merges by path, so re-editing a file across turns accumulates.
      todos: state.todos,
      files: state.files,
      diffs: state.diffs,
      // drop only *completed* subagents at the start of a turn — still-running ones are
      // kept (e.g. spawned in parallel/background while the main agent moves on to the
      // next message). This bounds growth (done ones clear next turn) without wiping
      // in-flight work. A subagent has no agent-driven delete, so we prune here.
      subagents: state.subagents.filter((a) => a.status !== 'done'),
      // terminal is the current run's live command stream — start each turn clean
      terminal: [],
      pendingPermission: null,
      pendingQuestion: null,
      // keep the previous turn's result (only its contextTokens is shown) so the
      // "현재 컨텍스트" gauge holds its last value during the run instead of
      // dropping to 0 — it refreshes when this run emits its own result.
      result: state.result,
      thinkingText: null,
      openGroupId: null,
      seq
    }
  }

  const e = action.event
  switch (e.type) {
    case 'status':
      return { ...state, status: e.status }

    case 'session':
      return { ...state, session: { sessionId: e.sessionId, model: e.model, cwd: e.cwd } }

    case 'thinking':
      return { ...state, thinkingText: e.text }
    case 'thinking-clear':
      return { ...state, thinkingText: null }

    case 'assistant-stream': {
      // append a streamed chunk to the in-progress assistant message (creating it
      // on the first chunk). animate:false — the streaming itself is the animation.
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      const exists = without.some((m) => m.id === e.messageId)
      const messages = exists
        ? without.map((m) => (m.id === e.messageId && m.kind === 'msg' ? { ...m, text: m.text + e.delta } : m))
        : [...without, { kind: 'msg' as const, id: e.messageId, role: 'assistant' as const, text: e.delta, animate: false, time: nowTime() }]
      return { ...state, thinkingText: null, openGroupId: null, messages }
    }

    case 'assistant-done': {
      // finalize: if the message was streamed, replace its text with the
      // authoritative final text; otherwise add it fresh.
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      const exists = without.some((m) => m.id === e.messageId)
      if (exists) {
        return {
          ...state,
          openGroupId: null,
          messages: without.map((m) => (m.id === e.messageId && m.kind === 'msg' ? { ...m, text: e.text, animate: false } : m))
        }
      }
      return {
        ...state,
        openGroupId: null,
        messages: [
          ...without,
          // animate short replies for a streaming feel; render long output instantly
          { kind: 'msg', id: e.messageId, role: 'assistant', text: e.text, animate: e.text.length <= 280, time: nowTime() }
        ]
      }
    }

    case 'tool-start': {
      // tools spawned inside a Task subagent are attributed to that subagent,
      // not the top-level tool log.
      if (e.tool.parentToolId) {
        const pid = e.tool.parentToolId
        return {
          ...state,
          subagents: state.subagents.map((a) => (a.id === pid ? { ...a, tools: [...a.tools, e.tool] } : a))
        }
      }
      let messages = state.messages
      let openGroupId = state.openGroupId
      const hasOpen = openGroupId && messages.some((m) => m.kind === 'toolgroup' && m.id === openGroupId)
      if (!hasOpen) {
        const seq = state.seq + 1
        openGroupId = `tg${seq}`
        messages = [...messages.filter((m) => m.id !== THINKING_ID), { kind: 'toolgroup', id: openGroupId, tools: [], time: nowTime() }]
        state = { ...state, seq }
      }
      messages = messages.map((m) =>
        m.kind === 'toolgroup' && m.id === openGroupId ? { ...m, tools: [...m.tools, e.tool] } : m
      )
      return { ...state, messages, openGroupId }
    }

    case 'tool-end': {
      // tool-end carries no parentToolId, so update whichever container holds the id.
      const upd = (t: ToolLogItem): ToolLogItem =>
        t.id === e.id ? { ...t, status: e.status, result: e.result, ...(e.output ? { output: e.output } : {}) } : t
      return {
        ...state,
        messages: state.messages.map((m) => (m.kind === 'toolgroup' ? { ...m, tools: m.tools.map(upd) } : m)),
        subagents: state.subagents.map((a) => ({ ...a, tools: a.tools.map(upd) }))
      }
    }

    case 'todos':
      return { ...state, todos: e.todos }

    case 'file-change': {
      // A full Write replaces the whole file, so its diff supersedes whatever was
      // accumulated for that path — otherwise re-writing a file stacks a second block
      // and double-counts the lines (+17 then +41 → +58). An Edit is incremental, so
      // it still merges onto the existing diff. (`whole` is set by the engine: true for
      // Write — even an overwrite that renders as a real +/− diff — false for Edit.)
      const isWrite = e.whole
      const existing = state.files.find((f) => f.path === e.file.path)
      // most-recently-touched first — a re-edited file bubbles back to the top of the
      // panel instead of staying parked wherever it was first touched
      const updated: ChangedFile =
        !existing || isWrite
          ? e.file
          : { ...existing, add: existing.add + e.file.add, del: existing.del + e.file.del, tag: existing.tag === 'new' ? 'new' : e.file.tag }
      const files = [updated, ...state.files.filter((f) => f.path !== e.file.path)]
      const prevDiff = state.diffs[e.file.path]
      const diff: FileDiff =
        prevDiff && !isWrite
          ? { ...prevDiff, add: prevDiff.add + e.diff.add, del: prevDiff.del + e.diff.del, lines: [...prevDiff.lines, ...e.diff.lines] }
          : e.diff
      return { ...state, files, diffs: { ...state.diffs, [e.file.path]: diff } }
    }

    case 'terminal':
      return { ...state, terminal: [...state.terminal, e.line] }

    case 'subagent': {
      const existing = state.subagents.find((a) => a.id === e.agent.id)
      if (existing) {
        const subagents = state.subagents.map((a) =>
          a.id === e.agent.id
            ? {
                ...a,
                status: e.agent.status,
                name: e.agent.name || a.name,
                role: e.agent.role || a.role,
                activity: e.agent.activity || a.activity
              }
            : a
        )
        return { ...state, subagents }
      }
      return { ...state, subagents: [...state.subagents, e.agent] }
    }

    case 'model-fallback': {
      // Fable 5가 정책상 응답을 거부해 폴백 모델로 전환됨 — 거부된 쪽이 스트리밍하던
      // 부분 답변을 지우고(재시도 답변이 새 말풍선으로 오도록) 경고 배너를 끼워 넣는다.
      const seq = state.seq + 1
      const without = state.messages.filter((m) => m.id !== THINKING_ID && (!e.retractMessageId || m.id !== e.retractMessageId))
      return {
        ...state,
        seq,
        thinkingText: null,
        messages: [...without, { kind: 'notice', id: `fb${seq}`, text: e.text, time: nowTime() }]
      }
    }

    case 'permission-request':
      return { ...state, pendingPermission: { requestId: e.requestId, toolName: e.toolName, summary: e.summary } }

    case 'question-request':
      return { ...state, pendingQuestion: { requestId: e.requestId, questions: e.questions } }

    case 'context': {
      // live mid-run update of just the context-token gauge
      const prev = state.result
      return {
        ...state,
        result: {
          costUsd: prev?.costUsd ?? null,
          durationMs: prev?.durationMs ?? null,
          numTurns: prev?.numTurns ?? null,
          contextTokens: e.contextTokens,
          contextWindow: prev?.contextWindow ?? null
        }
      }
    }

    case 'result': {
      const after = e.contextTokens ?? state.result?.contextTokens ?? null
      const window = e.contextWindow ?? state.result?.contextWindow ?? null
      const base = {
        ...state,
        result: {
          costUsd: e.costUsd,
          durationMs: e.durationMs,
          numTurns: e.numTurns,
          // keep the last live context value if the result didn't carry one (e.g. a
          // run that errored before any assistant turn) instead of blanking the gauge
          contextTokens: after,
          // the real window size only arrives with the result; hold the last known
          // value across turns so the denominator stays correct mid-run
          contextWindow: window
        },
        pendingPermission: null,
        pendingQuestion: null,
        pendingCommand: null
      }
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      // a slash command finished → finalize its running card in place
      const pc = state.pendingCommand
      if (pc) {
        const cfg = CMD_CARDS[pc.name]
        // failed run: flip the spinner to a failed state (never leave it spinning)
        if (e.isError) {
          return {
            ...base,
            messages: without.map((m) =>
              m.kind === 'cmdresult' && m.id === pc.cardId
                ? { ...m, running: false, failed: true, title: '명령을 완료하지 못했어요', sub: e.text || null, stats: null, time: nowTime() }
                : m
            )
          }
        }
        let sub = cfg.sub
        let stats: string | null = null
        if (pc.name === 'compact') {
          sub =
            pc.beforeMsgs > 0
              ? `이전 ${pc.beforeMsgs}개 메시지를 핵심 요약으로 압축했습니다.`
              : '대화를 핵심 요약으로 압축했습니다.'
          // only when the engine actually reports a smaller context — never fabricate
          const before = pc.beforeContext
          if (before != null && after != null && window && after < before) {
            const bp = Math.round((before / window) * 100)
            const ap = Math.round((after / window) * 100)
            stats = `컨텍스트 ${bp}% → ${ap}% 로 절약 · 토큰 ${fmtTokShort(before - after)} 회수`
          }
        }
        return {
          ...base,
          messages: without.map((m) =>
            m.kind === 'cmdresult' && m.id === pc.cardId
              ? { ...m, running: false, title: cfg.title, sub, stats, time: nowTime() }
              : m
          )
        }
      }
      // surface failure reason as a message (error subtypes carry text in `errors`)
      if (e.isError && e.text) {
        const seq = state.seq + 1
        return {
          ...base,
          seq,
          messages: [...without, { kind: 'msg', id: `rerr${seq}`, role: 'assistant', text: e.text, animate: false, error: true, time: nowTime() }]
        }
      }
      return base
    }

    case 'error': {
      const seq = state.seq + 1
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      return {
        ...state,
        seq,
        pendingPermission: null,
        pendingQuestion: null,
        messages: [
          ...without,
          { kind: 'msg', id: `err${seq}`, role: 'assistant', text: `오류: ${e.message}`, animate: false, error: true, time: nowTime() }
        ]
      }
    }

    default:
      // exhaustiveness guard — every EngineEvent variant is handled above
      return ((_x: never): SessionState => state)(e)
  }
}

// `subscribe` defaults to the main engine channel; the "/ask" modal passes
// window.api.ask.onEvent so its throwaway conversation drives a second, isolated
// session through the exact same reducer.
export function useAgentSession(
  subscribe?: (cb: (event: EngineEvent) => void) => () => void
) {
  const [state, dispatch] = useReducer(reducer, initialSessionState)
  const [elapsed, setElapsed] = useState(0)
  // whether the most recent finished run ended in error — the /run loop reads this to
  // stop (no auto-retry) instead of injecting the next turn. Tracked here rather than in
  // the reducer since it's loop control, not conversation state.
  const [lastRunErrored, setLastRunErrored] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startRef = useRef(0)

  // subscribe to streaming engine events (main channel by default, or the one passed in)
  useEffect(() => {
    const sub = subscribe ?? window.api.onEngineEvent
    return sub((event) => {
      // a new turn starts → clear the stale error flag; a finished turn records its outcome
      if (event.type === 'session') setLastRunErrored(false)
      else if (event.type === 'result') setLastRunErrored(!!event.isError)
      else if (event.type === 'error') setLastRunErrored(true)
      dispatch({ type: 'engine', event })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // run timer follows status
  const busy = state.status === 'analyzing' || state.status === 'working'
  useEffect(() => {
    if (busy) {
      if (timerRef.current) return
      startRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => {
      // always clear on unmount / dependency change to avoid a leaked interval
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [busy])

  const begin = (text: string, command: string | null = null, images?: string[]): void =>
    dispatch({ type: 'begin', text, time: nowTime(), command, images })
  const clearPermission = (): void => dispatch({ type: 'clear-permission' })
  const clearQuestion = (): void => dispatch({ type: 'clear-question' })
  // replace the entire live state — used when switching between chats
  const load = (snapshot: SessionState): void => dispatch({ type: 'load', state: snapshot })

  return { state, elapsed, busy, lastRunErrored, begin, clearPermission, clearQuestion, load }
}
