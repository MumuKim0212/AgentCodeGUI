import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { APP_HOME } from './engine/versions'
import { ancestorDirs } from './paths'
import type { McpServerInfo, McpOrigin, McpTransport } from '@shared/protocol'

// MCP servers the user has turned off in the app. Kept in the app's own home folder
// (NOT in ~/.claude.json), so toggling never rewrites Claude Code's config. The
// choice is applied per-run via the SDK's `deniedMcpServers` flag layer (a denylist
// that spans every scope), so a turned-off server is blocked for that run.
const DISABLED_PATH = path.join(APP_HOME, 'mcp.json')

// where Claude Code stores MCP server configs:
//   ~/.claude.json  → mcpServers           (user / 전역, all projects)
//                   → projects[dir].mcpServers (local / private to a project)
//   <dir>/.mcp.json → mcpServers           (project / shared, committed to the repo)
// `dir` is not just cwd: like git finding .git, the engine also reads .mcp.json
// from every parent of cwd, so a subfolder run still sees the repo root's config.
const USER_CONFIG = path.join(os.homedir(), '.claude.json')

/** Names the user has disabled. Keyed by name, matching deniedMcpServers' serverName. */
function readDisabled(): Set<string> {
  try {
    const j = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    const list: unknown = j?.disabled
    return new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDisabled(set: Set<string>): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  fs.writeFileSync(DISABLED_PATH, JSON.stringify({ disabled: [...set].sort() }, null, 2))
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Claude Code keys ~/.claude.json projects by absolute path. The app's cwd may use
// different separators/casing than what's stored — and the user may have registered
// servers from the repo root while the app opened a subfolder — so match loosely
// against cwd and each parent. The nearest entry that actually has servers wins.
function findProjectEntry(projects: unknown, cwd: string): Record<string, unknown> | null {
  if (!projects || typeof projects !== 'object' || !cwd) return null
  const map = projects as Record<string, Record<string, unknown>>
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const byNorm = new Map<string, Record<string, unknown>>()
  for (const k of Object.keys(map)) if (!byNorm.has(norm(k))) byNorm.set(norm(k), map[k])
  for (const dir of ancestorDirs(cwd)) {
    const entry = byNorm.get(norm(dir))
    if (entry && entry.mcpServers && typeof entry.mcpServers === 'object' && Object.keys(entry.mcpServers).length > 0) return entry
  }
  return null
}

// derive a transport + one-line summary (command line or URL) from a server config
function describe(cfg: unknown): { transport: McpTransport; detail: string } {
  if (cfg && typeof cfg === 'object') {
    const c = cfg as Record<string, unknown>
    if (typeof c.command === 'string') {
      const args = Array.isArray(c.args) ? c.args.join(' ') : ''
      return { transport: 'stdio', detail: `${c.command} ${args}`.trim() }
    }
    if (typeof c.url === 'string') {
      return { transport: c.type === 'sse' ? 'sse' : 'http', detail: c.url }
    }
  }
  return { transport: 'unknown', detail: '' }
}

function collect(servers: unknown, origin: McpOrigin, disabled: Set<string>, out: McpServerInfo[]): void {
  if (!servers || typeof servers !== 'object') return
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    const { transport, detail } = describe(cfg)
    out.push({
      name,
      scope: origin === 'user' ? 'global' : 'local',
      origin,
      transport,
      detail,
      enabled: !disabled.has(name)
    })
  }
}

/** Every MCP server visible to a run from `cwd`: user (전역) + project + local. */
export function listMcpServers(cwd: string): McpServerInfo[] {
  const disabled = readDisabled()
  const out: McpServerInfo[] = []

  const userCfg = readJson(USER_CONFIG)
  if (userCfg) {
    collect(userCfg.mcpServers, 'user', disabled, out) // 전역 — all projects
    const entry = findProjectEntry(userCfg.projects, cwd)
    if (entry) collect(entry.mcpServers, 'local', disabled, out) // 로컬 — private to this project
  }

  if (cwd && cwd.trim()) {
    // 프로젝트 — shared via .mcp.json. Collected from cwd and every parent (the
    // engine reads each level too); the nearest file wins when names clash.
    const seen = new Set<string>()
    for (const dir of ancestorDirs(cwd)) {
      const proj = readJson(path.join(dir, '.mcp.json'))
      if (!proj || !proj.mcpServers || typeof proj.mcpServers !== 'object') continue
      const fresh: Record<string, unknown> = {}
      for (const [name, cfg] of Object.entries(proj.mcpServers as Record<string, unknown>)) {
        if (seen.has(name)) continue
        seen.add(name)
        fresh[name] = cfg
      }
      collect(fresh, 'project', disabled, out)
    }
  }

  // alphabetical by name; user → project → local on ties
  const rank: Record<McpOrigin, number> = { user: 0, project: 1, local: 2 }
  return out.sort((a, b) => a.name.localeCompare(b.name) || rank[a.origin] - rank[b.origin])
}

/** Turn an MCP server on/off by name. Persisted to the app home folder. */
export function setMcpEnabled(name: string, enabled: boolean): void {
  const set = readDisabled()
  if (enabled) set.delete(name)
  else set.add(name)
  writeDisabled(set)
}

/**
 * The disabled servers as an SDK `deniedMcpServers` list ([{ serverName }, …]), or
 * null when nothing is disabled. Fed into a run's inline `settings` (the highest
 * priority flag layer); the denylist spans every scope, so a turned-off server is
 * blocked for that run without ever editing the user's ~/.claude.json.
 */
export function deniedMcpServers(): { serverName: string }[] | null {
  const set = readDisabled()
  if (set.size === 0) return null
  return [...set].map((serverName) => ({ serverName }))
}
