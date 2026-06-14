import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileDiff, GitChange, GitCommit, GitFileAt, GitFileStatus, GitOpResult, GitStatus } from '@shared/protocol'
import { computeLineDiff } from './claude/diff'

// diff/내용을 만들 때 이 크기를 넘는 파일은 건너뛴다 (뷰어도 어차피 하이라이트를 끔)
const MAX_FILE = 1_500_000

// ── exec 헬퍼 ────────────────────────────────────────────────
// core.quotepath=false: 한글 경로가 "\354…" 식으로 이스케이프되지 않게.
function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').trim() || 'git 실행 실패'))
        else resolve(stdout)
      }
    )
  })
}
async function gitTry(cwd: string, args: string[], timeout?: number): Promise<string | null> {
  try {
    return await git(cwd, args, timeout)
  } catch {
    return null
  }
}

// ── 레포 루트 — cwd가 .git 없는 하위 폴더여도 상위로 탐색 ─────
// `rev-parse --show-toplevel`이 상위 탐색·워크트리·서브모듈까지 처리한다.
// 결과는 cwd별로 캐시 (같은 폴더에서 카드를 열 때마다 다시 찾지 않게).
const rootCache = new Map<string, string | null>()
// force: 캐시를 무시하고 다시 찾는다 — 에이전트가 방금 `git init` 했을 수도 있어
// 턴이 끝날 때마다 렌더러가 force로 한 번 갱신한다.
export async function gitRoot(cwd: string, force = false): Promise<string | null> {
  if (!cwd) return null
  const key = cwd.replace(/[\\/]+/g, '/').toLowerCase()
  if (!force && rootCache.has(key)) return rootCache.get(key) ?? null
  const out = await gitTry(cwd, ['rev-parse', '--show-toplevel'], 10_000)
  const root = out ? path.normalize(out.trim()) : null
  rootCache.set(key, root)
  return root
}

// ── 상태: 브랜치 + ahead/behind + 작업 트리 변경 ──────────────
function statusLetter(xy: string): GitFileStatus {
  // 워크트리 쪽 문자가 우선, 없으면(스테이지만 변경) 인덱스 쪽
  const c = xy[1] !== '.' ? xy[1] : xy[0]
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R') return 'R'
  return 'M'
}

export async function gitStatus(root: string): Promise<GitStatus | null> {
  const raw = await gitTry(root, ['status', '-b', '--porcelain=v2', '--untracked-files=normal'])
  if (raw == null) return null
  let branch = ''
  let ahead = 0
  let behind = 0
  const changes: GitChange[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ')
      changes.push({ path: parts.slice(8).join(' '), status: statusLetter(parts[1]), add: null, del: null })
    } else if (line.startsWith('2 ')) {
      // 2 <XY> … <path>\t<origPath> — 이름 변경
      const tab = line.indexOf('\t')
      const head = (tab >= 0 ? line.slice(0, tab) : line).split(' ')
      changes.push({ path: head.slice(9).join(' '), status: 'R', add: null, del: null })
    } else if (line.startsWith('? ')) {
      changes.push({ path: line.slice(2), status: 'A', add: null, del: null })
    }
  }
  if (branch === '(detached)') {
    branch = (await gitTry(root, ['rev-parse', '--short', 'HEAD']))?.trim() ?? 'detached'
  }

  // 증감 수치: 추적 파일은 numstat, 새(untracked) 파일은 줄 수를 직접 센다
  const numstat = await gitTry(root, ['diff', 'HEAD', '--numstat'])
  if (numstat) {
    const m = new Map<string, { add: number | null; del: number | null }>()
    for (const ln of numstat.split('\n')) {
      const [a, d, ...rest] = ln.split('\t')
      if (rest.length === 0) continue
      m.set(rest.join('\t'), { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) })
    }
    for (const c of changes) {
      const s = m.get(c.path)
      if (s) {
        c.add = s.add
        c.del = s.del
      }
    }
  }
  await Promise.all(
    changes
      .filter((c) => c.status === 'A' && c.add == null)
      .map(async (c) => {
        try {
          const st = await fs.stat(path.join(root, c.path))
          if (st.size > MAX_FILE) return
          const text = await fs.readFile(path.join(root, c.path), 'utf8')
          if (!text.includes('\0')) {
            c.add = text.length ? text.replace(/\n$/, '').split('\n').length : 0
            c.del = 0
          }
        } catch {
          /* 새 폴더 등 — 수치 없이 둔다 */
        }
      })
  )

  const branchesRaw = (await gitTry(root, ['branch', '--format=%(HEAD)\t%(refname:short)'])) ?? ''
  const branches = branchesRaw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [head, ...name] = l.split('\t')
      return { name: name.join('\t'), current: head === '*' }
    })
    .filter((b) => b.name)
  const remotes = ((await gitTry(root, ['remote'])) ?? '').split('\n').filter(Boolean)
  const tags = ((await gitTry(root, ['tag', '--sort=-creatordate'])) ?? '').split('\n').filter(Boolean).slice(0, 20)

  return { root, branch, ahead, behind, changes, branches, remotes, tags }
}

// ── 커밋 로그 ────────────────────────────────────────────────
const SEP = '\x1f'
const REC = '\x1e'

export async function gitLog(root: string, limit = 80): Promise<GitCommit[]> {
  const fmt = ['%H', '%h', '%an', '%at', '%D', '%s', '%b'].join('%x1f') + '%x1e'
  const raw = await gitTry(root, ['log', `--format=${fmt}`, '-n', String(limit)])
  if (raw == null) return []
  // 업스트림에 아직 없는 커밋 집합 → 타임라인의 파란 점. 업스트림이 없으면 빈 집합.
  const unpushed = new Set(
    ((await gitTry(root, ['rev-list', '@{upstream}..HEAD'])) ?? '').split('\n').filter(Boolean)
  )
  const commits: GitCommit[] = []
  for (const rec of raw.split(REC)) {
    const t = rec.replace(/^\n/, '')
    if (!t.trim()) continue
    const [hash, shortHash, author, at, refs, subject, body] = t.split(SEP)
    if (!hash) continue
    const tags = (refs ?? '')
      .split(', ')
      .filter((r) => r.startsWith('tag: '))
      .map((r) => r.slice(5))
    commits.push({
      hash,
      shortHash,
      author,
      date: Number(at) * 1000,
      tags,
      subject: subject ?? '',
      body: (body ?? '').trim(),
      pushed: !unpushed.has(hash)
    })
  }
  return commits
}

// ── 한 커밋의 변경 파일 (+증감) ───────────────────────────────
export async function gitCommitDetail(root: string, hash: string): Promise<GitChange[]> {
  const [names, nums] = await Promise.all([
    gitTry(root, ['show', '--name-status', '--format=', hash]),
    gitTry(root, ['show', '--numstat', '--format=', hash])
  ])
  const stats = new Map<string, { add: number | null; del: number | null }>()
  for (const ln of (nums ?? '').split('\n')) {
    const [a, d, ...rest] = ln.split('\t')
    if (rest.length === 0) continue
    stats.set(rest.join('\t'), { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) })
  }
  const out: GitChange[] = []
  for (const ln of (names ?? '').split('\n')) {
    if (!ln.trim()) continue
    const [st, ...rest] = ln.split('\t')
    // R100 old new → 새 경로 기준
    const p = rest.length > 1 ? rest[rest.length - 1] : rest[0]
    if (!p) continue
    const letter: GitFileStatus = st[0] === 'A' ? 'A' : st[0] === 'D' ? 'D' : st[0] === 'R' ? 'R' : 'M'
    const s = stats.get(p) ?? stats.get(rest.join('\t')) ?? { add: null, del: null }
    out.push({ path: p, status: letter, add: s.add, del: s.del })
  }
  return out
}

// ── 커밋 시점 파일 + 부모→커밋 diff (뷰어 마킹) ────────────────
function looksBinary(s: string): boolean {
  return s.includes('\0')
}
function buildDiff(relPath: string, prev: string | null, next: string): FileDiff {
  if (prev == null || prev === '') {
    const lines = next.replace(/\n$/, '').split('\n')
    return {
      path: relPath,
      tag: 'new',
      add: next.length ? lines.length : 0,
      del: 0,
      lines: next.length ? lines.map((text) => ({ t: 'add' as const, text })) : []
    }
  }
  const { lines, add, del } = computeLineDiff(prev, next)
  return { path: relPath, tag: 'edit', add, del, lines }
}

export async function gitFileAt(root: string, hash: string, relPath: string): Promise<GitFileAt> {
  const cur = await gitTry(root, ['show', `${hash}:${relPath}`])
  if (cur == null) return { content: null, diff: null, error: '이 커밋에서 삭제되었거나 읽을 수 없는 파일이에요' }
  if (looksBinary(cur) || cur.length > MAX_FILE) return { content: null, diff: null, error: '미리볼 수 없는 파일이에요 (바이너리/대용량)' }
  const prev = await gitTry(root, ['show', `${hash}^:${relPath}`])
  const diff = prev != null && (looksBinary(prev) || prev.length > MAX_FILE) ? null : buildDiff(relPath, prev, cur)
  return { content: cur, diff }
}

// ── 작업 트리 파일의 HEAD→디스크 diff (뷰어 마킹) ──────────────
export async function gitWorkingFile(root: string, relPath: string): Promise<GitFileAt> {
  let disk: string
  try {
    disk = await fs.readFile(path.join(root, relPath), 'utf8')
  } catch {
    return { content: null, diff: null, error: '파일을 읽을 수 없어요' }
  }
  if (looksBinary(disk) || disk.length > MAX_FILE) return { content: null, diff: null }
  const head = await gitTry(root, ['show', `HEAD:${relPath}`])
  const diff = head != null && (looksBinary(head) || head.length > MAX_FILE) ? null : buildDiff(relPath, head, disk)
  // content는 비워 둔다 — 뷰어가 디스크에서 직접 읽어 LSP 좌표가 살아 있게
  return { content: null, diff }
}

// ── 쓰기 동작: 커밋 / 푸시 / 풀 ───────────────────────────────
export async function gitCommit(root: string, subject: string, body: string): Promise<GitOpResult> {
  try {
    await git(root, ['add', '-A'])
    const args = ['commit', '-m', subject]
    if (body.trim()) args.push('-m', body)
    await git(root, args)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function gitPush(root: string): Promise<GitOpResult> {
  try {
    await git(root, ['push'], 120_000)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 업스트림 미설정 → 현재 브랜치를 origin에 -u로 한 번 더
    if (/no upstream|set-upstream/i.test(msg)) {
      try {
        const br = ((await gitTry(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '').trim()
        if (br && br !== 'HEAD') {
          await git(root, ['push', '-u', 'origin', br], 120_000)
          return { ok: true }
        }
      } catch (e2) {
        return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) }
      }
    }
    return { ok: false, error: msg }
  }
}

export async function gitPull(root: string): Promise<GitOpResult> {
  try {
    await git(root, ['pull', '--ff-only'], 120_000)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
