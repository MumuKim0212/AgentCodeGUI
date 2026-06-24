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

export interface VerseScopes {
  members: Set<string> // class/struct field names
  locals: Set<string> // parameters + local bindings
  structEnum: Set<string> // struct/enum type names → the distinct lighter type colour
}

/**
 * Member-field and local-binding names declared in `code`. See module header for how they map
 * to colours in recolorVerse. One pass: members need indentation (class-body children only);
 * locals are collected loosely by pattern (over-collecting locals only suppresses module-colour,
 * it never mis-colours).
 */
export function verseScopes(code: string): VerseScopes {
  const members = new Set<string>()
  const structEnum = new Set<string>()
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
      if (th[2] === 'struct' || th[2] === 'enum') structEnum.add(th[1]) // distinct lighter colour
      if (th[2] !== 'enum') bodyIndents.push(lvl + 1) // enum body holds values, not member fields
      continue
    }
    if (!bodyIndents.length || lvl !== bodyIndents[bodyIndents.length - 1]) continue
    const v = VAR_FIELD.exec(trimmed)
    if (v) {
      members.add(v[1])
      continue
    }
    const t = TYPED_FIELD.exec(trimmed)
    if (t) members.add(t[1])
  }

  // Locals: parameters (`(Name:` / `, ?Name:`), `var`/`set` bindings, and walrus `Name :=`
  // (failable `if (X := …)`, loop `for (X := …)`, plain local). Pattern-matched over the whole
  // file; `members` wins at paint time, so a class-body constant caught here is harmless.
  const locals = new Set<string>()
  for (const m of code.matchAll(/\b(?:var|set)\s+([A-Za-z_]\w*)/g)) locals.add(m[1])
  for (const m of code.matchAll(/([A-Za-z_]\w*)\s*:=/g)) locals.add(m[1])
  for (const m of code.matchAll(/[(,]\s*\??\s*([A-Za-z_]\w*)\s*:(?!=)/g)) locals.add(m[1])
  return { members, locals, structEnum }
}

// Recolour highlight.js output for .verse using the scanned scopes. Operates on the raw HTML
// (both the viewer and the editor go through highlightCode, so both benefit). A `hljs-variable`
// span optionally followed by '.' is a receiver; member names carry no HTML-significant chars.
export function recolorVerse(html: string, scopes: VerseScopes): string {
  const { members, locals, structEnum } = scopes
  let out = html.replace(
    /<span class="hljs-variable">([A-Za-z_]\w*)<\/span>(\.?)/g,
    (full, name: string, dot: string) => {
      if (members.has(name)) return full // member field → member colour (keep)
      if (dot === '.' && !locals.has(name)) return `<span class="hljs-title class_">${name}</span>.` // external receiver → module/type colour
      return name + dot // local / parameter / non-member read → default colour
    }
  )
  // struct/enum type names (definitions `hljs-title class_`, snake_case uses `hljs-type`) →
  // the distinct lighter type colour (sem-type2 = --code-type-2), like Rider's struct/enum.
  if (structEnum.size) {
    out = out.replace(/<span class="hljs-(?:title class_|type)">([A-Za-z_]\w*)<\/span>/g, (full, name: string) =>
      structEnum.has(name) ? `<span class="sem-type2">${name}</span>` : full
    )
  }
  return out
}
