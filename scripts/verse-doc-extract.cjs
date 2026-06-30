// Extract Verse API doc-comment blocks (with the declaration they describe) from the
// local UEFN digests. Mirrors extractVerseDoc in src/main/lsp/verse.ts EXACTLY so the
// content-hash keys match what the app produces at hover time: walk UP from a declaration,
// skipping interleaved @attributes (capturing @doc), collecting `#` and one-line `<# #>`.
// We run it at every candidate declaration line (any non-comment / non-@ / non-blank line)
// so the key set is a superset of every symbol the user can hover. Output: JSON array of
// { key, src, decl, en } to stdout.
const fs = require('fs')
const crypto = require('crypto')

const base = (process.env.LOCALAPPDATA || '').split('\\').join('/')
const D = base + '/UnrealEditorFortnite/Saved/VerseProject/FortniteGame'
const FILES = [
  ['Verse.org', D + '/Verse/Verse.digest.verse'],
  ['UnrealEngine.com', D + '/UnrealEngine/UnrealEngine.digest.verse'],
  ['Fortnite.com', D + '/Fortnite/Fortnite.digest.verse']
]

// faithful port of extractVerseDoc(lines, declLine)
function extractVerseDoc(lines, declLine) {
  const out = []
  for (let i = declLine - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '') break
    if (t.startsWith('@')) {
      const dm = /^@doc\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(t)
      if (dm) out.unshift(dm[1].replace(/\\(.)/g, '$1'))
      continue
    }
    if (t.startsWith('<#') && t.endsWith('#>')) {
      out.unshift(t.slice(2, -2).trim())
      continue
    }
    if (t.startsWith('#') && !t.startsWith('#>')) {
      out.unshift(t.replace(/^#+\s?/, ''))
      continue
    }
    break
  }
  return out.join('\n').trim()
}

const out = []
for (const [srcName, fp] of FILES) {
  let raw
  try {
    raw = fs.readFileSync(fp, 'utf8')
  } catch {
    process.stderr.write('missing: ' + fp + '\n')
    continue
  }
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    // candidate declaration line: not blank, not a comment, not an attribute
    if (!t || t.startsWith('#') || t.startsWith('@') || t.startsWith('<#')) continue
    const en = extractVerseDoc(lines, i)
    if (!en) continue
    const decl = t.length > 160 ? t.slice(0, 160) + ' …' : t
    out.push({ src: srcName, line: i, decl, en })
  }
}

// content-hash key + dedup (keep first decl seen for each unique english text)
const seen = new Map()
for (const b of out) {
  const key = crypto.createHash('sha1').update(b.en).digest('hex').slice(0, 12)
  if (!seen.has(key)) seen.set(key, { key, ...b })
}
const uniq = [...seen.values()]
process.stderr.write(`candidates=${out.length} unique=${uniq.length}\n`)
process.stdout.write(JSON.stringify(uniq))
