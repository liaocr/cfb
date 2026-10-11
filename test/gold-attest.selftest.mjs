#!/usr/bin/env node
// test/gold-attest.selftest.mjs —— v14.24.1「盖章 + 降级链路」的验收
// 要钉住的六件事（全部在临时根上跑，绝不碰真注册表）：
//   1) 盖章只加 goldStandard 一个键：draft/raw/ctx 与 digest 逐字不变（改稿即失分，盖章绝不能顺手改稿）；
//   2) 章里钉 stampDigest ⇒ 稿一改，章自动过期 ⇒ --check 必须变红（不许让分数跟着稿子飘）；
//   3) 标准升版 ⇒ 旧章自动算过期；
//   4) 三谓词真值表：not-gold 条目从标尺侧掉到训练侧，且 use:'ruler' 也抬不回去（只能降级、不能升级）；
//   5) 未盖章条目沿用旧口径（新工具不许一夜之间把标尺池清空）；
//   6) 尺子两处脏读数已修：countSamples 不把 <x>-resume 当独立第二趟；gold-score --dedup 重复 id 只计一次。
import nodeAssert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (target, kind) => (...args) => { const r = target[kind](...args); pass += 1; return r },
  apply: (target, thisArg, args) => { const r = target(...args); pass += 1; return r },
})
const HERE = path.resolve(import.meta.dirname, '..')
const { goldRulerOk, goldBenchOk, goldTrainOk, goldUse, loadGold, goldDigest } = await import('../tools/helpers/three-mode.mjs')
const { countSamples, GOLD_STANDARD_VERSION } = await import('../tools/helpers/gold-standard.mjs')
const { rulerIdSet } = await import('../tools/helpers/traj-corpus.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-attest-'))
const P = (...p) => path.join(tmp, ...p)
const wr = (p, s) => { const f = P(p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f }
const RAW = 'src/a.js:12  const RETRY = 0            // 关掉重试\n' + 'x'.repeat(1200)
const DRAFT = '这条线只有一处：把 `src/a.js` 里的 `const RETRY = 0` 改成 `const RETRY = 2`。\n排除：`src/b.js` 不在这条路上。\n验收：跑 `test/a.selftest.mjs`（看退出码）——若按上面这处改完它变绿 ⇒ 就是这处；若仍不绿 ⇒ 还有别处，先别说修好。'
const entry = { schema: 'cfb.gold/1', id: 'demo-s0-r3', family: 'demo', task: 'demo', sample: 0, round: 3, plan: 'tX', split: 'dev', at: '2026-10-05T00:00:00.000Z', raw: RAW, ctx: 'cwd=/work', calls: 4, draft: DRAFT, stored: DRAFT, gates: {}, outcome: { solved: true, roundsToFix: 4, vsRaw: 'win', rawSolved: false, rawRoundsToFix: 7 }, validated: true, use: 'ruler', digest: 'ignore-me' }
const file = wr('transfer/gold/demo/demo-s0-r3.json', JSON.stringify({ ...entry, digest: goldDigest(entry) }, null, 2) + '\n')
const run = (args = []) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(HERE, 'tools', 'gold-attest.mjs'), ...args], { env: { ...process.env, CFB_ROOT: tmp }, encoding: 'utf8' }) } } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } } }
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))

// ── 1) 盖章：只多一个键，稿与 digest 一个字都不动
const before = read()
const r1 = run([])
assert.equal(r1.code, 0, '首次盖章应成功：' + r1.out.slice(0, 200))
const after = read()
assert.equal(JSON.stringify(after.draft), JSON.stringify(before.draft), 'draft 必须逐字不动')
assert.equal(after.raw, before.raw, 'raw 必须逐字不动')
assert.equal(after.digest, before.digest, 'digest 必须不变（hash 只含 raw/ctx/draft ⇒ 盖章不作废历史基准）')
assert.deepEqual(Object.keys(after).filter((k) => k !== 'goldStandard'), Object.keys(before).filter((k) => k !== 'goldStandard'), '除新键外键集合不变')
assert.equal(after.goldStandard.version, GOLD_STANDARD_VERSION, '章里要写标准版本')
assert.equal(after.goldStandard.stampDigest, before.digest, '章要钉住"盖章当时那份稿"的 digest')
assert.match(r1.out, /标尺侧（goldRulerOk）1 → 0/, '要说清降级后果：' + r1.out.split('\n')[2])
assert.match(r1.out, /训练侧（goldTrainOk）0 → 1/, '降级不等于作废：料进训练侧')

// ── 2) 稿一改 ⇒ 章自动过期 ⇒ --check 变红
const staleCheck = () => run(['--check'])
assert.equal(staleCheck().code, 0, '刚盖完章 --check 应干净')
const moved = { ...after, draft: after.draft + '\n顺手多加了一句。' }
moved.digest = goldDigest(moved)
fs.writeFileSync(file, JSON.stringify(moved, null, 2) + '\n')
const r2 = staleCheck()
assert.equal(r2.code, 1, '稿变了但章还是旧稿的 ⇒ --check 必须失败')
assert.match(r2.out, /章过期（须真机重测）/, '要指明出路是重测而不是改字段：' + r2.out.slice(-260))
// 重盖章（真机重测之后必须重盖，章才会跟上新稿）⇒ --check 恢复干净
assert.equal(run([]).code, 0, '重盖章应成功')
assert.equal(staleCheck().code, 0, '重盖章后 --check 应重新干净')
assert.notEqual(read().goldStandard.stampDigest, before.digest, '新章钉的是新 digest')

// ── 3) 标准升版 ⇒ 旧章过期
const g3 = read(); g3.goldStandard.version = 'cfb.gold-standard/0'; fs.writeFileSync(file, JSON.stringify(g3, null, 2) + '\n')
assert.match(run(['--check']).out, /标准升版/, '升版要被抓出来，旧结论不许继续沿用')

// ── 4) 三谓词真值表（盖章只能降级）
const cases = [
  [{ use: 'ruler', goldStandard: { status: 'gold' } }, true, true, false],
  [{ use: 'ruler', goldStandard: { status: 'provisional-gold' } }, false, true, true],
  [{ use: 'ruler', goldStandard: { status: 'not-gold' } }, false, false, true],
  [{ use: 'ruler' }, true, true, false],                                    // 未盖章 ⇒ 沿用旧口径
  [{ use: 'train' }, false, false, true],
  [{ use: 'both', goldStandard: { status: 'gold' } }, true, true, true]
]
for (const [g, ruler, bench, train] of cases) {
  assert.equal(goldRulerOk(g), ruler, `goldRulerOk ${JSON.stringify(g)}`)
  assert.equal(goldBenchOk(g), bench, `goldBenchOk ${JSON.stringify(g)}`)
  assert.equal(goldTrainOk(g), train, `goldTrainOk ${JSON.stringify(g)}`)
}
assert.equal(goldUse({ goldStandard: { status: 'not-gold' } }), 'ruler', 'use 字段不被盖章改写（谁写谁负责）')
assert.deepEqual([...rulerIdSet([{ id: 'a', use: 'ruler', goldStandard: { status: 'not-gold' } }, { id: 'b', use: 'ruler', goldStandard: { status: 'gold' } }])], ['b'], '判分标尺侧只认盖章 gold')
// 有人想用 use 把 not-gold 抬回标尺 ⇒ 抬不动
assert.equal(goldRulerOk({ use: 'ruler', goldStandard: { status: 'not-gold' } }), false, '盖章只能降级')

// ── 5) 未盖章条目不被新工具一夜清零
const bare = loadGold(P('transfer/gold'))
assert.ok(bare.length === 1 && bare[0].goldStandard, 'loadGold 读得到的条目应带章')

// ── 6a) countSamples：-resume 不算独立第二趟
const home = (h, rows, { consumed = true, err = false } = {}) => {
  const f = P(`.cfb-runtime/traj/${h}/results.jsonl`); fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, rows.map(([task, sample, variant]) => JSON.stringify({ task, sample, variant, rounds: 6, fixedAtRound: 5, verifiedAfterFix: true, edits: [], ...(err ? { error: 'upstream-no-reasoning' } : {}) })).join('\n') + '\n')
  if (consumed) fs.writeFileSync(P(`.cfb-runtime/traj/${h}/hand-samples.jsonl`), rows.map(([task, sample]) => JSON.stringify({ schema: 'cfb.hand-sample/2', task, sample, round: 3, draft: DRAFT, raw: RAW })).join('\n') + '\n')
  return f
}
home('tZ', [['demo', 0, 'hand']], { consumed: false, err: true })
assert.equal(countSamples(null, 'demo', 'demo', 0, tmp), 0, '空跑（无台账行 + 带停机错误）一条都不算 —— t103 就是这个坑')
home('tX', [['demo', 0, 'hand']])
assert.equal(countSamples(null, 'demo', 'demo', 0, tmp), 1, '真消费过稿的一趟算 1')
home('tX-resume', [['demo', 0, 'hand']])
assert.equal(countSamples(null, 'demo', 'demo', 0, tmp), 1, '同一趟的 resume 只是续跑，不是独立证据')
home('tY', [['demo', 0, 'hand']])
assert.equal(countSamples(null, 'demo', 'demo', 0, tmp), 2, '换一趟真跑才算第二样本')

// ── 6b) gold-score --dedup：同 id 在两条池各存一份 ⇒ 只计一次
wr('transfer/gold-rejected/demo/demo-s0-r3.json', fs.readFileSync(file))
const score = (extra = []) => execFileSync(process.execPath, [path.join(HERE, 'tools', 'gold-score.mjs'), ...extra], { env: { ...process.env, CFB_ROOT: tmp }, encoding: 'utf8' })
const dup = score([])
assert.match(dup, /合计 2 行 \/ 1 个唯一 id/, `未去重时行数与 id 数都要打出来：${dup.split('\n').pop()}`)
const dd = score(['--dedup'])
assert.match(dd, /2 行 → 1 个唯一 id/, '--dedup 要合并重复 id：' + dd.split('\n').find((l) => l.includes('dedup')))
assert.match(dd, /合计 1 行 \/ 1 个唯一 id/, '去重后合计按唯一 id 计票')

// ── 7) 活体完整性：真注册表的章必须新鲜（谁改了 draft 没重盖章，这里就红）
{
  const r = execFileSync(process.execPath, [path.join(HERE, 'tools', 'gold-attest.mjs'), '--check'], { encoding: 'utf8' })
  assert.match(r, /全部盖章且新鲜/, '真注册表若有条目改过稿没重盖章，这条必须红：' + r.split('\n').slice(-3).join(' / '))
  const pool = loadGold(path.join(HERE, 'transfer', 'gold'))   // HERE 已是仓库根
  const stamped = pool.filter((g) => g.goldStandard)
  assert.equal(stamped.length, pool.length, `在册 ${pool.length} 条应全部带章（实际 ${stamped.length}）`)
  for (const g of stamped) assert.ok(['gold', 'provisional-gold', 'not-gold'].includes(g.goldStandard.status), `${g.id} 的章状态非法：${g.goldStandard.status}`)
  assert.ok(stamped.filter((g) => g.goldStandard.status === 'gold').length >= 1, '标尺池不许为空（为空说明标准被改严到无人达标 ⇒ 要显式改判据，不许让它悄悄空着）')
}

console.log('gold-attest.selftest: 盖章幂等 / 过期检测 / 三谓词真值表 / 降级链路 / 样本与去重口径 / 真注册表章新鲜度 通过')
console.log(`PASS=${pass} FAIL=0`)
