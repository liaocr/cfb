import fs from 'node:fs'
import { extractDraftPrefFeatures, buildGroundedHay } from '../tools/helpers/draft-pref.mjs'
const d = JSON.parse(fs.readFileSync('transfer/models/micro-dev-dataset.json', 'utf8'))
const gold = new Map()
for (const f of fs.readdirSync('transfer/gold', { recursive: true })) {
  if (!String(f).endsWith('.json')) continue
  const g = JSON.parse(fs.readFileSync('transfer/gold/' + f, 'utf8'))
  if (g?.raw) gold.set(g.id || String(f), g)
}
const ctxOf = (x) => { const g = gold.get(x.sourceId); return g ? { raw: g.raw || '', ctx: g.ctx || '' } : null }
const rows = d.stepSimpoPairs.filter((x) => x.trainingEligible)
const diff = (a, b) => Object.keys(a).reduce((s, k) => s + Math.abs(Number(a[k]) - Number(b[k])), 0)
let same = 0, tot = 0, per = {}
for (const x of rows) {
  const c = ctxOf(x); if (!c) continue
  let hp, hy
  try { hy = buildGroundedHay(c.raw, c.ctx); hp = extractDraftPrefFeatures(x.chosenText, c.raw, c.ctx, hy.anchors) } catch { continue }
  let rp
  try { rp = extractDraftPrefFeatures(x.rejectedText, c.raw, c.ctx, hy.anchors) } catch { continue }
  const dd = diff(hp, rp); tot++
  const tag = /anchor|triple/.test(x.negType) ? '送分(新)' : (x.negType === 'flywheel_real_pair' ? '飞轮真对' : '原反事实')
  per[tag] = per[tag] || { n: 0, zero: 0, sum: 0 }
  per[tag].n++; per[tag].sum += dd; if (dd < 1e-9) { per[tag].zero++; same++ }
}
console.log('可复核的 eligible 对', tot, '｜其中 pref 向量完全相同（模型看不见差别）:', same)
for (const [k, v] of Object.entries(per)) console.log(`  ${k.padEnd(10)} n=${String(v.n).padEnd(4)} pref 全同 ${v.zero} 条 (${(v.zero / v.n * 100).toFixed(0)}%)  L1 差异均值 ${(v.sum / v.n).toFixed(3)}`)
const units = d.unitSamples.filter((u) => u.family === 'flaky-timeout' && u.trainingEligible)
const cnt = {}; for (const u of units) cnt[u.slot] = (cnt[u.slot] || 0) + 1
const maj = Math.max(...Object.values(cnt))
console.log('\nflaky-timeout 折的 unit 槽位分布:', cnt, '｜多数类基线 =', (maj / units.length * 100).toFixed(1) + '%（报告里 SFT val_acc 33.33%）')
