const fs = require('fs')
const DIR = require('path').join(__dirname, '..', '.tmp-verse')
const blocks = JSON.parse(fs.readFileSync(DIR + '/blocks.json', 'utf8'))
const byKey = new Map(blocks.map((b) => [b.key, b]))
const ko = {}
for (const f of fs.readdirSync(DIR + '/ko')) Object.assign(ko, JSON.parse(fs.readFileSync(DIR + '/ko/' + f, 'utf8')))
const ticks = (s) => (s.match(/`[^`]+`/g) || []).slice().sort()

const keys = JSON.parse(fs.readFileSync(DIR + '/tick-mismatch.json', 'utf8'))
const missing = process.argv.slice(2)
for (const k of [...missing, ...keys]) {
  const b = byKey.get(k)
  console.log('===== ' + k + '  [' + (b ? b.src : '?') + ']' + (ko[k] ? '' : '  *** NO TRANSLATION ***'))
  console.log('DECL: ' + (b ? b.decl : ''))
  console.log('EN  : ' + (b ? b.en.replace(/\n/g, ' / ') : ''))
  console.log('KO  : ' + (ko[k] ? ko[k].replace(/\n/g, ' / ') : '—'))
  console.log('EN ticks: ' + JSON.stringify(ticks(b ? b.en : '')))
  console.log('KO ticks: ' + JSON.stringify(ticks(ko[k] || '')))
  console.log('')
}
