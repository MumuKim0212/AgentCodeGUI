import crypto from 'node:crypto'
import pack from './verse-doc-ko.json'

// Korean translations of the Verse / UnrealEngine / Fortnite API doc comments, keyed by
// sha1(englishDoc).slice(0,12) — the same content hash the generator emits (see
// scripts/verse-doc-*.cjs). Built once per Verse digest version; backtick code, type names
// and identifiers are kept verbatim, only the prose is translated.
const PACK = pack as Record<string, string>

let enabled = false

/** Turn Korean API docs on/off — driven by the `verseDocLang` UI pref ('ko' = on). */
export function setVerseDocKo(on: boolean): void {
  enabled = on
}

/**
 * When Korean docs are enabled, swap an English API doc block for its translation, looked up
 * by content hash. Anything not in the pack (the user's own code comments, brand-new API)
 * falls through to the original English — so a hover is never blanked or broken. Returns `en`
 * unchanged when disabled, making the whole feature a no-op behind the toggle.
 */
export function translateVerseDoc(en: string): string {
  if (!enabled || !en) return en
  const key = crypto.createHash('sha1').update(en).digest('hex').slice(0, 12)
  return PACK[key] ?? en
}
