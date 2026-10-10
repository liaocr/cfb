import fs from 'node:fs'
import { judge, anchorsOf, causePairs, loadAnchors, splitSentences } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync('.cfb-offline/ruler/pairs-hand.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const big = rows.slice().sort((a, b) => b.raw.length - a.raw.length)[0]
console.log('largest raw', big.raw.length, 'draft', big.draft.length)
const t = (label, fn) => { const s = Date.now(); const v = fn(); console.log('  ' + label + ': ' + (Date.now() - s) + 'ms', Array.isArray(v) ? 'n=' + v.length : ''); return v }
const ar = t('anchorsOf(raw)', () => anchorsOf(big.raw))
t('anchorsOf x3', () => { anchorsOf(big.raw); anchorsOf(big.raw); anchorsOf(big.raw) })
t('splitSentences(raw)', () => splitSentences(big.raw))
t('causePairs(raw)', () => causePairs(big.raw))
t('loadAnchors(raw,ctx)', () => loadAnchors(big.raw, big.ctx))
t('judge(full)', () => judge({ raw: big.raw, ctx: big.ctx, draft: big.draft }))
const mid = rows.slice().sort((a, b) => b.raw.length - a.raw.length)[3]
const s2 = Date.now(); judge({ raw: mid.raw, ctx: mid.ctx, draft: mid.draft }); console.log('  judge(mid ' + mid.raw.length + '): ' + (Date.now() - s2) + 'ms')
console.log('anchor count', ar.length, 'sample', JSON.stringify(ar.slice(0, 12)))
