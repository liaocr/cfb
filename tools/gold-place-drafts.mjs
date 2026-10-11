/**
 * 模式 1 续跑用的草稿投放器：把「已知最好的那一版稿」放到暂停格子前面，让生产闸链去判它（本工具不发任何请求、零花费）。
 *   node tools/gold-place-drafts.mjs [outDir]           # 默认 .cfb-runtime/traj/t103
 * 取稿优先级（刻意保守，宁缺毋滥）：
 *   1) 同 id 的在册条目 ⇒ 逐字用它（这样 R1 的 draft 对齐天然成立，跑出来的分数直接归到这份稿头上）；
 *   2) 没有同 id（暂停轮次与在册格不同）⇒ 用同 family + 同 sample 里「章上 gap 最小」的那版（gold 优先）；
 *   3) 都没有 ⇒ 什么都不放。现编一份稿去骗闸是最坏的选择：闸过了也说明不了什么。
 * 已就位（drafts/<id>.md 存在）的格子跳过，可反复调用。
 */
/** t103 草稿投放：把「已知最好的那一版稿」放到暂停格子前，让闸链去判它。
 *  1) 同 id 的在册条目 ⇒ 逐字用它（这样 R1 的 draft 对齐天然成立）；
 *  2) 没有同 id（暂停轮次不同）⇒ 用同 family+同 sample 里 gap 最小（章上的 gap）的那版稿；
 *  3) 都没有 ⇒ 什么都不放（宁缺毋滥，不现编稿去骗闸）。 */
import fs from 'node:fs'; import path from 'node:path'
const ROOT = process.env.CFB_ROOT ? path.resolve(process.env.CFB_ROOT) : path.resolve(import.meta.dirname, '..')
const OUT = path.resolve(ROOT, process.argv[2] || '.cfb-runtime/traj/t103')
const PD = path.join(OUT, 'pending')
const load = (dir) => { const o = []; const d = path.join(ROOT, 'transfer', dir); if (!fs.existsSync(d)) return o
  for (const f of fs.readdirSync(d)) { if (!fs.statSync(path.join(d, f)).isDirectory()) continue
    for (const x of fs.readdirSync(path.join(d, f))) { if (!x.endsWith('.json')) continue; const j = JSON.parse(fs.readFileSync(path.join(d, f, x), 'utf8')); if (j?.draft) o.push({ ...j, where: dir, gap: j.goldStandard?.gap ?? 9, status: j.goldStandard?.status || 'unstamped' }) } }
  return o }
const pool = [...load('gold'), ...load('gold-rejected')]
const byId = new Map(pool.map((g) => [g.id, g])); const key = (id) => id.replace(/-s\d+-r\d+$/, '')
const byFam = new Map()
for (const g of pool) { const k = `${key(g.id)}|s${g.sample ?? 0}`; const arr = byFam.get(k) || []; arr.push(g); byFam.set(k, arr) }
fs.mkdirSync(path.join(OUT, 'drafts'), { recursive: true })
if (!fs.existsSync(PD)) { console.log('（无 pending 目录 ⇒ 没有待投放的格子）'); process.exit(0) }
let n = 0
for (const f of fs.readdirSync(PD)) {
  if (!f.endsWith('.json')) continue
  const id = f.replace(/\.json$/, ''); const dst = path.join(OUT, 'drafts', `${id}.md`)
  if (fs.existsSync(dst)) { console.log(`  跳过 ${id}（稿已就位）`); continue }
  let src = byId.get(id) || null, how = '同 id 逐字'
  if (!src) { const arr = (byFam.get(`${key(id)}|s${(id.match(/-s(\d+)-r\d+$/) || [])[1] ?? 0}`) || []).sort((a, b) => (a.status === 'gold' ? 0 : 1) - (b.status === 'gold' ? 0 : 1) || a.gap - b.gap); src = arr[0] || null; how = src ? `同 family/sample 里 gap 最小（${src.id}，章=${src.status}/gap=${src.gap}）` : null }
  if (!src) { console.log(`  ✗ ${id}：池里没有可用稿 ⇒ 不投放（宁缺毋滥）`); continue }
  fs.writeFileSync(dst, String(src.draft).trim() + '\n'); n++
  console.log(`  ✓ ${id} ← ${src.where}/${src.id}（${src.draft.length} 字 · ${how}）`)
}
console.log(`投放 ${n} 份稿到 ${path.relative(ROOT, OUT)}/drafts/`)
