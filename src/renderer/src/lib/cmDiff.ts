import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import type { FileDiff } from '@shared/protocol'
import { highlightCode } from './highlight'

// ── changed-file decorations (diff painted onto the live file) ───────────────
// The agent's cumulative whole-file diff (run baseline → current) mapped onto the
// real file: which current-file lines were added, and the boundaries where lines
// were deleted. Shared by the read-only viewer (FileModal) and the CM editor.
export interface DiffMarks {
  added: Set<number> // 1-based current-file line numbers introduced by this run
  delAfter: Set<number> // a deletion sits between line n and n+1 (0 = before line 1)
  // 삭제된 줄의 원문 — 경계(새 파일 기준 줄 번호) 자리에 빨간 고스트 줄로 렌더된다.
  // n은 옛(old-side) 줄 번호: 사라진 코드가 원래 몇 번째 줄이었는지 거터에 보여준다.
  ghosts: Map<number, { n: number; text: string }[]>
  blocks: { start: number; end: number; type: 'add' | 'del' | 'mix' }[] // overview-ruler runs
  newCount: number // new-side line total
  // 부모(에이전트 작업 전, old-side) 전체 줄 — del+ctx로 복원. 읽기 모드 표준 diff의 기준이며,
  // 저장·재열기로 디스크가 바뀌어도 이 기준은 안 변하므로 "현재파일 vs 부모" diff가 안 깨진다.
  oldLines: string[]
}

export function diffMarksOf(diff: FileDiff): DiffMarks {
  const added = new Set<number>()
  const delAfter = new Set<number>()
  const ghosts = new Map<number, { n: number; text: string }[]>()
  const blocks: DiffMarks['blocks'] = []
  const oldLines: string[] = []
  const mark = (line: number, type: 'add' | 'del'): void => {
    const last = blocks[blocks.length - 1]
    if (last && line - last.end <= 1) {
      last.end = Math.max(last.end, line)
      if (last.type !== type) last.type = 'mix'
    } else blocks.push({ start: line, end: line, type })
  }
  let ln = 0
  let oldLn = 0
  for (const l of diff.lines) {
    if (l.t === 'hunk') continue
    if (l.t === 'del') {
      oldLn++
      oldLines.push(l.text) // del = old-side 줄
      delAfter.add(ln)
      let arr = ghosts.get(ln)
      if (!arr) ghosts.set(ln, (arr = []))
      arr.push({ n: oldLn, text: l.text })
      mark(ln + 1, 'del') // ruler mark above line ln+1 (below the last line when at EOF)
      continue
    }
    ln++
    if (l.t === 'add') {
      added.add(ln)
      mark(ln, 'add')
    } else {
      oldLn++
      oldLines.push(l.text) // ctx = old-side 줄이기도 하다
    }
  }
  return { added, delAfter, ghosts, blocks, newCount: ln, oldLines }
}

// ── CodeMirror diff decorations ──────────────────────────────────────────────
// Deleted lines render as a block widget between lines — a red "ghost" showing the
// removed source (syntax-highlighted; colors inherit from the host's hljs/palette
// classes) with the old line number in a faux-gutter. Display-only (events ignored).
class GhostWidget extends WidgetType {
  readonly key: string
  constructor(
    private readonly gs: { n: number; text: string }[],
    private readonly lang: string
  ) {
    super()
    this.key = gs.map((g) => g.n + ':' + g.text).join('\n')
  }
  eq(other: GhostWidget): boolean {
    return other.key === this.key
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ghost'
    for (const g of this.gs) {
      // 삭제 줄 = 본문 코드 줄과 같은 패딩으로 렌더 → 삭제 코드가 실제 코드와 정확히 정렬.
      // (CM 블록 위젯은 거터 칸을 못 만들어 옛 줄번호는 거터에 못 넣는다 — 생략)
      const row = document.createElement('div')
      row.className = 'cm-ghost-row'
      if (this.lang) row.innerHTML = highlightCode(g.text || ' ', this.lang)
      else row.textContent = g.text || ' '
      wrap.appendChild(row)
    }
    return wrap
  }
  ignoreEvent(): boolean {
    return true
  }
}

// ── 표준 라인 diff (부모 a ↔ 현재 b) ─────────────────────────────────────────
// 두 줄 배열을 비교해 편집 스크립트를 돌려준다: eq(그대로)·del(부모에만 있음=삭제)·
// add(현재에만 있음=추가/변경). 앞뒤 공통 줄을 먼저 잘라 국소 변경은 O(n)으로 끝내고,
// 가운데 차이 구간만 LCS DP를 돈다.
type DiffOp = { t: 'eq'; ai: number; bi: number } | { t: 'del'; ai: number } | { t: 'add'; bi: number }
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const ops: DiffOp[] = []
  let p = 0
  const cap = Math.min(n, m)
  while (p < cap && a[p] === b[p]) p++
  let s = 0
  while (s < cap - p && a[n - 1 - s] === b[m - 1 - s]) s++
  for (let i = 0; i < p; i++) ops.push({ t: 'eq', ai: i, bi: i })
  const midA = a.slice(p, n - s)
  const midB = b.slice(p, m - s)
  const MA = midA.length
  const MB = midB.length
  if (MA && MB && MA * MB <= 4_000_000) {
    const dp: Int32Array[] = []
    for (let i = 0; i <= MA; i++) dp.push(new Int32Array(MB + 1))
    for (let i = MA - 1; i >= 0; i--)
      for (let j = MB - 1; j >= 0; j--)
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < MA || j < MB) {
      if (i < MA && j < MB && midA[i] === midB[j]) {
        ops.push({ t: 'eq', ai: p + i, bi: p + j })
        i++
        j++
      } else if (i < MA && (j >= MB || dp[i + 1][j] >= dp[i][j + 1])) {
        // 동점이면 del을 먼저 — 수정한 줄이 "🔴 옛거(위) → 🟢 새거(아래)" 표준 diff 순서로 보이게
        ops.push({ t: 'del', ai: p + i })
        i++
      } else {
        ops.push({ t: 'add', bi: p + j })
        j++
      }
    }
  } else {
    // 차이 구간이 비정상적으로 크면 DP 포기 — 전부 삭제 후 전부 추가(드묾·안전)
    for (let i = 0; i < MA; i++) ops.push({ t: 'del', ai: p + i })
    for (let j = 0; j < MB; j++) ops.push({ t: 'add', bi: p + j })
  }
  for (let k = 0; k < s; k++) ops.push({ t: 'eq', ai: n - s + k, bi: m - s + k })
  return ops
}

// 읽기 모드 데코 — "현재 파일(C) vs 부모(parent)" 표준 diff. 추가/변경된 C 줄 = 초록,
// 삭제된 부모 줄 = 그 자리 빨강 고스트 블록. 기준이 부모(불변)라 저장·재열기에도 안 깨진다.
const addLine = Decoration.line({ class: 'cm-dadd' })
function buildReadDiff(state: EditorState, parent: string[], lang: string): DecorationSet {
  const doc = state.doc
  const cLines = doc.toString().split('\n')
  let pLines = parent
  // CM은 끝의 개행을 빈 줄로 들고 있다 — C 끝에만 빈 줄이 있으면 부모에도 맞춰 헛 diff 방지
  if (cLines.length && cLines[cLines.length - 1] === '' && (pLines.length === 0 || pLines[pLines.length - 1] !== ''))
    pLines = [...pLines, '']
  const ops = diffOps(pLines, cLines)
  const ranges: Range<Decoration>[] = []
  let curLine = 0 // 지금까지 낸 현재(C) 줄 수
  let pendingDel: { n: number; text: string }[] = []
  const flushDel = (): void => {
    if (!pendingDel.length) return
    const pos = curLine <= 0 ? 0 : doc.line(Math.min(curLine, doc.lines)).to
    ranges.push(Decoration.widget({ widget: new GhostWidget(pendingDel, lang), block: true, side: curLine <= 0 ? -1 : 1 }).range(pos))
    pendingDel = []
  }
  for (const op of ops) {
    if (op.t === 'del') pendingDel.push({ n: op.ai + 1, text: pLines[op.ai] })
    else {
      flushDel() // 삭제 묶음은 앞 줄과 다음 줄 사이에 끼운다
      curLine++
      if (op.t === 'add' && curLine <= doc.lines) ranges.push(addLine.range(doc.line(curLine).from))
    }
  }
  flushDel() // 파일 끝 삭제
  return Decoration.set(ranges, true)
}

// 읽기 모드 전용 diff 필드. parent(부모) 기준으로 현재 문서를 표준 diff로 칠한다. 읽기 모드는
// 읽기 전용이라 보통 create()로 끝나지만, 안전하게 docChanged에도 다시 계산한다.
export function readDiffField(parent: string[], lang: string): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => buildReadDiff(state, parent, lang),
    update: (deco, tr) => (tr.docChanged ? buildReadDiff(tr.state, parent, lang) : deco),
    provide: (f) => EditorView.decorations.from(f)
  })
}
