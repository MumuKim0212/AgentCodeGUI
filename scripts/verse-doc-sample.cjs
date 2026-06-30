// Pick a diverse sample of doc blocks (spread across the 3 digests and across length)
// and print them for review/translation. Deterministic (no RNG).
const fs = require('fs')
const DIR = require('path').join(__dirname, '..', '.tmp-verse')
const all = JSON.parse(fs.readFileSync(DIR + '/blocks.json', 'utf8'))
const PER = 12 // per source
const bySrc = {}
for (const b of all) (bySrc[b.src] ||= []).push(b)

const picked = []
for (const src of Object.keys(bySrc)) {
  const list = bySrc[src].slice().sort((a, b) => a.en.length - b.en.length)
  // spread evenly from shortest to longest
  for (let k = 0; k < PER; k++) {
    const idx = Math.floor(((k + 0.5) / PER) * list.length)
    picked.push(list[Math.min(idx, list.length - 1)])
  }
}
fs.writeFileSync(DIR + '/sample.json', JSON.stringify(picked, null, 0))
for (const b of picked) {
  console.log('### [' + b.src + '] key=' + b.key)
  console.log('DECL: ' + b.decl)
  console.log('EN  : ' + b.en.replace(/\n/g, '\n      '))
  console.log('')
}
