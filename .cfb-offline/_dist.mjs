import fs from 'node:fs'
import { judge, loadAnchors, retention, hasAnchor } from '../tools/gen-ruler.mjs'
const rows = fs.readFileSync('.cfb-offline/ruler/pairs-hand.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const dist = []
for (const o of rows) {
  const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
  const load = loadAnchors(o.raw, o.ctx)
  const ids = load.filter((a) => !(/\w\.\w/.test(a) || a.includes('/')))
  const paths = load.filter((a) => /\w\.\w/.test(a) || a.includes('/'))
  dist.push({ id: o.id, nLoad: load.length, nPaths: paths.length, nIds: ids.length, idRet: +retention(ids, o.draft).toFixed(3), lostPaths: paths.filter((a) => !hasAnchor(o.draft, a)).length, draftLen: o.draft.length })
}
const q = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? [a[0], a[Math.floor(a.length * 0.25)], a[Math.floor(a.length * 0.5)], a[Math.floor(a.length * 0.75)], a[a.length - 1]] : [] }
console.log('load 总量分布 [min,q25,med,q75,max] =', JSON.stringify(q(dist.map((d) => d.nLoad))))
console.log('路径数分布 =', JSON.stringify(q(dist.map((d) => d.nPaths))))
console.log('标识符数分布 =', JSON.stringify(q(dist.map((d) => d.nIds))))
console.log('标识符保留率分布 =', JSON.stringify(q(dist.map((d) => d.idRet))))
console.log('保留率 == 1 的条数 =', dist.filter((d) => d.idRet === 1).length, '/', dist.length)
console.log('保留率 == 0 的条数 =', dist.filter((d) => d.idRet === 0).length)
console.log('有丢路径的条数 =', dist.filter((d) => d.lostPaths > 0).length)
console.log('\n保留率最低的 12 条：')
for (const d of dist.slice().sort((a, b) => a.idRet - b.idRet).slice(0, 12)) console.log('  ' + String(d.idRet).padEnd(6) + ' ids=' + String(d.nIds).padEnd(3) + ' paths=' + String(d.nPaths).padEnd(3) + ' lost=' + d.lostPaths + '  ' + d.id)
console.log('\n参考：0.5 / 0.6 / 0.75 / 1.0 各会让多少条挂在 G3 标识符上')
for (const f of [0.34, 0.5, 0.6, 0.67, 0.75, 1.0]) console.log('  floor=' + f + ' -> ' + dist.filter((d) => d.nIds >= 1 && d.idRet < f).length + ' 条')
