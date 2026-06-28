// Split the unique doc blocks into N chunks for parallel translation.
// Each chunk file is an array of { key, src, decl, en } so a translator agent has context.
const fs = require('fs')
const DIR = require('path').join(__dirname, '..', '.tmp-verse')
const N = Number(process.argv[2] || 16)

const all = JSON.parse(fs.readFileSync(DIR + '/blocks.json', 'utf8'))
// stable order by key so re-runs are deterministic
all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

const chunks = Array.from({ length: N }, () => [])
all.forEach((b, i) => chunks[i % N].push({ key: b.key, src: b.src, decl: b.decl, en: b.en }))

fs.mkdirSync(DIR + '/chunks', { recursive: true })
const manifest = []
chunks.forEach((c, i) => {
  const nn = String(i).padStart(2, '0')
  fs.writeFileSync(DIR + '/chunks/chunk-' + nn + '.json', JSON.stringify(c))
  manifest.push({ chunk: nn, count: c.length, keys: c.map((x) => x.key) })
})
fs.writeFileSync(DIR + '/manifest.json', JSON.stringify(manifest))
console.log('total=' + all.length + ' chunks=' + N + ' per~=' + Math.ceil(all.length / N))
