import fs from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

// usage: node decompress.mjs <sessionDir> [outPath]
const dir = process.argv[2]
const out = process.argv[3] ?? 'D:/dsh/research/session-runs/' + dir.split(/[\\/]/).pop() + '.jsonl'
fs.mkdirSync('D:/dsh/research/session-runs', { recursive: true })
const buf = fs.readFileSync(dir + '/session.jsonl.zstd')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Locate every frame start by scanning for the zstd magic.
const starts = []
let idx = buf.indexOf(MAGIC)
while (idx !== -1) {
  starts.push(idx)
  idx = buf.indexOf(MAGIC, idx + 1)
}
console.log('frame starts found:', starts.length)

const parts = []
let total = 0
let frame = 0
for (let i = 0; i < starts.length; i++) {
  const a = starts[i]
  const b = i + 1 < starts.length ? starts[i + 1] : buf.length
  try {
    const dec = zstdDecompressSync(buf.subarray(a, b))
    parts.push(dec)
    total += dec.length
    frame++
  } catch (e) {
    console.log('frame', i, 'decode failed:', String(e).slice(0, 120))
  }
}
const all = Buffer.concat(parts)
fs.writeFileSync(out, all)
console.log('decoded frames:', frame, '| total', total, 'bytes ->', out)
const lines = all.toString('utf8').split('\n').filter(Boolean)
console.log('lines:', lines.length)
const types = {}
for (const l of lines) {
  try { const e = JSON.parse(l); types[e.type] = (types[e.type] || 0) + 1 } catch { types['<unparsed>'] = (types['<unparsed>'] || 0) + 1 }
}
console.log('event types:', JSON.stringify(types))
