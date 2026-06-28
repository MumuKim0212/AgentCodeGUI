// Build a side-by-side EN/KO review page for the sampled Verse doc blocks → Desktop.
const fs = require('fs')
const DIR = require('path').join(__dirname, '..', '.tmp-verse')
const OUT = (process.env.USERPROFILE || '').split('\\').join('/') + '/Desktop/verse-번역-품질-검수.html'

const sample = JSON.parse(fs.readFileSync(DIR + '/sample.json', 'utf8'))
const ko = JSON.parse(fs.readFileSync(DIR + '/ko.json', 'utf8'))

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// `code` → <code>, keep newlines as <br>
const md = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')

const SRC_COLOR = { 'Verse.org': '#8b9cff', 'UnrealEngine.com': '#6fd3c7', 'Fortnite.com': '#ffb86b' }

const cards = sample
  .map((b, i) => {
    const kt = ko[b.key]
    const color = SRC_COLOR[b.src] || '#9aa'
    return `<div class="card">
  <div class="head">
    <span class="badge" style="--c:${color}">${esc(b.src)}</span>
    <span class="num">#${i + 1}</span>
    <span class="hash">${esc(b.key)}</span>
  </div>
  <div class="decl"><code>${esc(b.decl)}</code></div>
  <div class="cols">
    <div class="col en"><div class="lbl">원문 (EN)</div><div class="doc">${md(b.en)}</div></div>
    <div class="col ko"><div class="lbl">한국어 (KO)</div><div class="doc">${kt ? md(kt) : '<span class="missing">— 번역 없음 —</span>'}</div></div>
  </div>
</div>`
  })
  .join('\n')

const have = sample.filter((b) => ko[b.key]).length
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>Verse 호버 번역 품질 검수</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #16181d; color: #e6e8ee;
    font: 14px/1.6 "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b91a0; margin: 0 0 24px; font-size: 13px; }
  .legend { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; font-size: 12px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .card { background: #1d2026; border: 1px solid #2b2f38; border-radius: 12px;
    padding: 16px 18px; margin-bottom: 16px; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .badge { font-size: 11px; font-weight: 600; color: var(--c);
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
    background: color-mix(in srgb, var(--c) 12%, transparent);
    padding: 2px 8px; border-radius: 999px; }
  .num { color: #6b7180; font-size: 12px; }
  .hash { color: #4d525e; font-size: 11px; margin-left: auto; font-family: ui-monospace, monospace; }
  .decl { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 12px;
    color: #c8cedd; background: #15171c; border: 1px solid #2b2f38; border-radius: 8px;
    padding: 8px 10px; margin-bottom: 12px; overflow-x: auto; white-space: pre; }
  .decl code { color: #c8cedd; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .col { background: #15171c; border: 1px solid #262a32; border-radius: 8px; padding: 10px 12px; }
  .col.ko { border-color: #2f3a52; }
  .lbl { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    color: #6b7180; margin-bottom: 6px; }
  .col.ko .lbl { color: #8b9cff; }
  .doc { font-size: 13.5px; }
  code { font-family: ui-monospace, "Cascadia Code", monospace; font-size: .92em;
    color: #ffb86b; background: #ffb86b14; padding: 1px 4px; border-radius: 4px; }
  .missing { color: #ff6b6b; }
  @media (max-width: 820px) { .cols { grid-template-columns: 1fr; } }
</style></head><body>
<h1>Verse 호버 주석 — 한국어 번역 품질 검수</h1>
<p class="sub">샘플 ${sample.length}개 (3개 다이제스트에서 길이별로 고르게 추출) · 번역 ${have}/${sample.length} · 백틱 코드·타입명·식별자는 번역하지 않고 보존</p>
<div class="legend">
  <span><i class="dot" style="background:#8b9cff"></i>Verse.org</span>
  <span><i class="dot" style="background:#6fd3c7"></i>UnrealEngine.com</span>
  <span><i class="dot" style="background:#ffb86b"></i>Fortnite.com</span>
</div>
${cards}
</body></html>`

fs.writeFileSync(OUT, html, 'utf8')
console.log('wrote: ' + OUT)
console.log('cards: ' + sample.length + ', translated: ' + have)
