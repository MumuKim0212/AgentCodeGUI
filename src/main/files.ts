import fs from 'node:fs'
import path from 'node:path'
import type { DirEntry } from '@shared/protocol'

// Directories we never descend into when building the "@" mention file list —
// heavy, generated, or VCS internals that would swamp the picker and slow the walk.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite',
  '.idea', '.vs', '.gradle', 'bin', 'obj', 'target', 'vendor', '__pycache__',
  '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.expo', 'Pods', '.dart_tool'
])

// Hidden dot-directories worth keeping — they hold real, mention-worthy files
// (workflows, skills, MCP config) unlike the noise SKIP_DIRS already drops.
const KEEP_DOT_DIRS = new Set(['.github', '.claude', '.vscode'])

const MAX_FILES = 6000 // cap so a giant repo can't stall the walk or the renderer

/**
 * Walk `cwd` breadth-first and return project-relative POSIX file paths, skipping
 * heavy/generated directories and most hidden dot-dirs. Breadth-first ordering keeps
 * shallow files (the ones a user most often mentions) near the front, and MAX_FILES
 * bounds the work so the "@" mention palette stays responsive even in large repos.
 */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (!cwd) return []
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length && out.length < MAX_FILES) {
    const rel = queue.shift() as string
    const abs = rel ? path.join(cwd, rel) : cwd
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      continue // unreadable dir (perms, race) — just skip it
    }
    const dirs: string[] = []
    for (const e of entries) {
      const name = e.name
      const childRel = rel ? rel + '/' + name : name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        if (name.startsWith('.') && !KEEP_DOT_DIRS.has(name)) continue
        dirs.push(childRel)
      } else if (e.isFile()) {
        out.push(childRel)
        if (out.length >= MAX_FILES) break
      }
    }
    // queue this dir's children after the ones already waiting → breadth-first
    for (const d of dirs) queue.push(d)
  }
  return out
}

/**
 * List ONE folder for the file explorer — `rel` is cwd-relative ('' = project root).
 * Lazy by design (called per expanded folder), so unlike the bounded mention walk
 * above nothing is filtered: an explorer shows the real tree, node_modules included.
 * Folders first, then files, each sorted case-insensitively.
 */
export async function listDir(cwd: string, rel: string): Promise<DirEntry[]> {
  if (!cwd) return []
  const root = path.resolve(cwd)
  const abs = path.resolve(root, rel || '.')
  // never escape the project root (a crafted "../" rel could otherwise browse anywhere)
  if (abs !== root && !abs.startsWith(root + path.sep)) return []
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true })
  } catch {
    return [] // unreadable dir (perms, gone) — show it empty
  }
  const out: DirEntry[] = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
  out.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1
  )
  return out
}
