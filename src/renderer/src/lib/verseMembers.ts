import { verseReg, verseInheritedMembers, verseInheritedMethods } from './verseRegistry'

// ── B-lite: approximate member / local / module colouring for .verse ─────────
// verse-lsp exposes no semantic tokens / documentSymbol, and Verse's `Name:type` syntax is
// identical for fields, parameters and locals, so highlight.js alone cannot tell them apart.
// This whole-file scan recovers two name sets — MEMBER fields (declared in a class/struct body)
// and LOCALS (parameters + `var`/`:=`/`for`/`if (…:=)` bindings) — by tracking indentation
// (Verse blocks are significant-indent, `\t` or 4 spaces per level, like Epic's own grammar).
// recolorVerse then paints each highlight.js `hljs-variable` token:
//   • name ∈ members            → keep member colour (decl AND every use, e.g. `Maybe?`)
//   • name before a '.' (a member-access receiver) that is NOT a local → module/type colour
//     (external module / namespace like `TickEvents` — has no in-file declaration)
//   • everything else (locals, parameters, non-member reads) → default text colour
// Honest limits (regex, no symbol table — caveats the user accepted): inherited/external bare
// members (no '.') stay default; a local shadowing a field's name reads as the member; a module
// sharing a local's name reads as the local.

function indentLevel(line: string): number {
  let i = 0
  let lvl = 0
  for (;;) {
    if (line[i] === '\t') {
      lvl++
      i++
    } else if (line.startsWith('    ', i)) {
      lvl++
      i += 4
    } else break
  }
  return lvl
}

const TYPE_HEADER = /^([A-Za-z_]\w*)\s*(?:<[^>]*>)*\s*:=\s*(class|struct|interface|enum)\b/
const VAR_FIELD = /^(?:var|set)\s+([A-Za-z_]\w*)/
const TYPED_FIELD = /^([A-Za-z_]\w*)\s*(?:<[^>]*>)*\s*:/
// a class-body method: a name (+ specifiers) immediately before '(' — `OnTick(`, `OnBegin<override>(`
const METHOD_DECL = /^([A-Za-z_]\w*)\s*(?:<[^>]*>)*\s*\(/

export interface VerseScopes {
  members: Set<string> // this file's class/struct fields + members inherited from registry supers
  methods: Set<string> // this file's class methods — so a bare method reference (callback) reads as a function
  locals: Set<string> // parameters + local bindings
  fileTypes: Map<string, string> // this file's own type defs → kind (class|struct|enum|interface)
}

/**
 * Member-field and local-binding names declared in `code`. See module header for how they map
 * to colours in recolorVerse. One pass: members need indentation (class-body children only);
 * locals are collected loosely by pattern (over-collecting locals only suppresses module-colour,
 * it never mis-colours).
 */
export function verseScopes(code: string): VerseScopes {
  const members = new Set<string>()
  const methods = new Set<string>()
  const fileTypes = new Map<string, string>() // this file's type defs → kind
  const supers: string[] = [] // superclass names of this file's classes → expand inherited members
  const bodyIndents: number[] = [] // body indent (= header indent + 1) of each open class/struct
  let inBlockComment = false
  for (const raw of code.split('\n')) {
    const trimmed = raw.trim()
    if (inBlockComment) {
      if (trimmed.includes('#>')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('<#') && !trimmed.includes('#>')) {
      inBlockComment = true
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    const lvl = indentLevel(raw)
    while (bodyIndents.length && lvl < bodyIndents[bodyIndents.length - 1]) bodyIndents.pop()
    const th = TYPE_HEADER.exec(trimmed)
    if (th) {
      fileTypes.set(th[1], th[2]) // name → kind (class|struct|enum|interface)
      // superclass(es) of a class def — `name<…> := class<…>(Super, …):` → expand inherited members
      const sup = /:=\s*(?:class|interface)\b(?:<[^>]*>)*\s*\(([^)]*)\)/.exec(trimmed)
      if (sup) for (const s of sup[1].split(',')) supers.push(s.replace(/[<(].*$/, '').trim())
      if (th[2] !== 'enum') bodyIndents.push(lvl + 1) // enum body holds values, not member fields
      continue
    }
    if (!bodyIndents.length || lvl !== bodyIndents[bodyIndents.length - 1]) continue
    const md = METHOD_DECL.exec(trimmed) // `Name(… ` — a method (function member), not a field
    if (md) {
      methods.add(md[1])
      continue
    }
    const v = VAR_FIELD.exec(trimmed)
    if (v) {
      members.add(v[1])
      continue
    }
    const t = TYPED_FIELD.exec(trimmed)
    if (t) members.add(t[1])
  }
  // inherited members from the registry (engine bases like `component`) so e.g. `TickEvents.` reads
  // as a member (blue), not an external module (purple). Inherited METHODS go to `methods` (mint),
  // the rest (data fields) to `members` (member colour) — collect methods first so the field pass
  // can exclude them.
  for (const s of supers) if (s) for (const m of verseInheritedMethods(s)) methods.add(m)
  for (const s of supers) if (s) for (const m of verseInheritedMembers(s)) if (!methods.has(m)) members.add(m)

  // Locals: parameters (`(Name:` / `, ?Name:`), `var`/`set` bindings, and walrus `Name :=`
  // (failable `if (X := …)`, loop `for (X := …)`, plain local). Pattern-matched over the whole
  // file; `members` wins at paint time, so a class-body constant caught here is harmless.
  const locals = new Set<string>()
  for (const m of code.matchAll(/\b(?:var|set)\s+([A-Za-z_]\w*)/g)) locals.add(m[1])
  // walrus `Name := …` binds a local — but NOT `Name := class|struct|enum|interface|module` (a
  // type definition). Excluding the type-def form keeps real type names out of `locals`.
  for (const m of code.matchAll(/([A-Za-z_]\w*)\s*:=\s*(?!(?:class|struct|enum|interface|module)\b)/g))
    locals.add(m[1])
  for (const m of code.matchAll(/[(,]\s*\??\s*([A-Za-z_]\w*)\s*:(?!=)/g)) locals.add(m[1])
  return { members, methods, locals, fileTypes }
}

// Recolour highlight.js output for .verse from FACTS, not guesses. The grammar no longer assumes
// "lowercase = type" (everything unknown is a plain `hljs-variable`); here we keep the default
// (white) for anything we can't confirm, and only colour identifiers we KNOW the kind of:
//   • a class/struct field, or a member inherited from a registry super → member colour (kept)
//   • a confirmed TYPE (this file's defs ∪ the digest/project registry) → type colour, by kind
//   • everything else (locals, params, unknown receivers) → default colour (span stripped)
// Both the viewer and the editor go through here, so both get it.
export function recolorVerse(html: string, scopes: VerseScopes): string {
  const { members, methods, fileTypes } = scopes
  const reg = verseReg()
  const typeKind = (name: string): string | undefined => fileTypes.get(name) ?? reg.kind[name]
  // class/interface → the class colour; struct/enum → the distinct lighter type colour
  const typeSpan = (name: string, kind: string): string =>
    kind === 'class' || kind === 'interface'
      ? `<span class="hljs-title class_">${name}</span>`
      : `<span class="sem-type2">${name}</span>`
  let out = html.replace(
    /<span class="hljs-variable">([A-Za-z_]\w*)<\/span>(\.?)/g,
    (full, name: string, dot: string) => {
      if (members.has(name)) return full // member (own or inherited) → member colour, keep
      // a bare method reference (a callback passed without `()`) — colour it like a function (mint),
      // matching `OnTick(…)` at its definition/call. The grammar only catches a name BEFORE '(' .
      if (methods.has(name)) return `<span class="hljs-title function_">${name}</span>` + dot
      const k = typeKind(name)
      if (k) return typeSpan(name, k) + dot // confirmed type → type colour by kind
      return name + dot // local / parameter / unknown → default (white)
    }
  )
  // a type DEFINITION name is `hljs-title class_` from the grammar (always the class colour); recolour
  // struct/enum defs to the lighter type colour by their actual kind.
  out = out.replace(/<span class="hljs-title class_">([A-Za-z_]\w*)<\/span>/g, (full, name: string) => {
    const k = typeKind(name)
    return k === 'struct' || k === 'enum' ? `<span class="sem-type2">${name}</span>` : full
  })
  return out
}
