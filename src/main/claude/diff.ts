import type { DiffLine } from '@shared/protocol'

/**
 * Minimal LCS line diff — good enough to render Edit/Write hunks in the UI.
 * Returns diff lines plus added/removed counts.
 */
export function computeLineDiff(
  oldText: string,
  newText: string
): { lines: DiffLine[]; add: number; del: number } {
  // Drop a single trailing newline so line counts match the real file.
  const an = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText
  const bn = newText.endsWith('\n') ? newText.slice(0, -1) : newText
  const a = an.length ? an.split('\n') : []
  const b = bn.length ? bn.split('\n') : []
  const n = a.length
  const m = b.length

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  let add = 0
  let del = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ t: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ t: 'del', text: a[i] })
      i++
      del++
    } else {
      lines.push({ t: 'add', text: b[j] })
      j++
      add++
    }
  }
  while (i < n) {
    lines.push({ t: 'del', text: a[i] })
    i++
    del++
  }
  while (j < m) {
    lines.push({ t: 'add', text: b[j] })
    j++
    add++
  }
  return { lines, add, del }
}

/** Build an all-added diff for a freshly written file. */
export function newFileDiff(content: string): { lines: DiffLine[]; add: number } {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
  const body = normalized.length ? normalized.split('\n') : []
  const lines: DiffLine[] = [{ t: 'hunk', text: `@@ 새 파일 +1,${body.length} @@` }]
  for (const text of body) lines.push({ t: 'add', text })
  return { lines, add: body.length }
}
