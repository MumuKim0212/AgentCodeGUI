import type { VerseRegistry } from '@shared/protocol'

// Accurate Verse type registry (kinds / supers / members / enum values), fetched from main once per
// project and merged here (engine digests are shared across projects; user-type collisions are rare).
// recolorVerse / verseScopes read it SYNCHRONOUSLY; it's populated async on file open, and a version
// bump notifies open editors to re-decorate the one time it arrives.
let reg: VerseRegistry = { kind: {}, supers: {}, members: {}, methods: {}, enumValues: {}, setters: {} }
let version = 0
const fetched = new Set<string>()
const listeners = new Set<() => void>()

export function verseReg(): VerseRegistry {
  return reg
}
export function verseRegVersion(): number {
  return version
}
/** Subscribe to registry arrivals (editors re-decorate). Returns an unsubscribe fn. */
export function onVerseRegChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Fetch + merge a project's Verse registry (no-op if already loaded, or the file has no Verse project). */
export async function ensureVerseRegistry(cwd: string, relPath: string): Promise<void> {
  const key = cwd.toLowerCase()
  if (fetched.has(key)) return
  const r = await window.api.lsp.verseRegistry(cwd, relPath).catch(() => null)
  if (!r) return // non-Verse file or no project yet — leave unmarked so a later Verse file retries
  fetched.add(key)
  reg = {
    kind: { ...reg.kind, ...r.kind },
    supers: { ...reg.supers, ...r.supers },
    members: { ...reg.members, ...r.members },
    methods: { ...reg.methods, ...r.methods },
    enumValues: { ...reg.enumValues, ...r.enumValues },
    setters: { ...reg.setters, ...r.setters }
  }
  version++
  for (const fn of listeners) fn()
}

/** Members of `typeName` incl. inherited (walk supers), from the registry. Bounded against cycles. */
export function verseInheritedMembers(typeName: string, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  if (seen.has(typeName)) return out
  seen.add(typeName)
  for (const m of reg.members[typeName] ?? []) out.add(m)
  for (const s of reg.supers[typeName] ?? []) verseInheritedMembers(s, out, seen)
  return out
}

/** Methods (function members) of `typeName` incl. inherited — coloured as functions, not data members. */
export function verseInheritedMethods(typeName: string, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  if (seen.has(typeName)) return out
  seen.add(typeName)
  for (const m of reg.methods[typeName] ?? []) out.add(m)
  for (const s of reg.supers[typeName] ?? []) verseInheritedMethods(s, out, seen)
  return out
}
