#!/usr/bin/env node
// test/gold-standard.selftest.mjs —— GOLD-STANDARD v1（cfb.gold-standard/1）这把尺子本身的验收
// 要钉住的六件事：
//   1) 每条轴都真的在判：给一个「恰好通过」的 fixture 和一个「恰好不通过」的 fixture（M1–M8、E1、E2、R1、R2）；
//   2) fail-closed：缺线（M2）、无原文（M7）、无真机结局（E1/E2）一律记「未测」且不许算通过；
//   3) 改稿即失分：注册稿与台账稿不一致 ⇒ drift ⇒ R1 判假、状态不得为 gold；
//   4) R1 用精确回放：凭 hand-samples.jsonl 的 id + results.jsonl 同 task/sample 的结局行，弱键错配要能被拒；
//   5) R2 要独立趟：同格第二趟存在 ⇒ n=2 过；只有一趟 ⇒ n=1 不过（且不许写成「通过但样本不足」）；
//   6) 引用免检/裸引判缺：「…」里的原文不算改法句，裸引思考流算缺陷。
import nodeAssert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (target, kind) => (...args) => { const r = target[kind](...args); pass += 1; return r },
  apply: (target, thisArg, args) => { const r = target(...args); pass += 1; return r },
})
const { measureGold, THRESHOLDS, GOLD_STANDARD_VERSION } = await import('../tools/helpers/gold-standard.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-gold-standard-'))
const root = (...p) => path.join(tmp, ...p)
const write = (p, s) => { const f = root(p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f }

// ── fixture 语料：raw 里必须真的含有 GOOD 稿引用的每个片段（否则 M5 判「编的」是对的）
const RAW = [
  'repo layout: src/a.js, src/b.js, test/demo.selftest.mjs',
  'src/a.js:12  const RETRY = 0            // 关掉重试（本次故障根因）',
  'src/b.js:4   const RETRY_BACKOFF = 250  // 与本条路径无关',
  'log line: "retry disabled" seen at 03:11:02 right before the request died',
  'test/demo.selftest.mjs exits 0 when retry is on, 1 otherwise',
  'x'.repeat(900)
].join('\n')
const GOOD = [
  '这条线只有一处：把 `src/a.js` 里的 `const RETRY = 0` 改成 `const RETRY = 2`。',
  '为什么是它：日志里那句「retry disabled」只有这个常量能产生。',
  '排除：`src/b.js` 的 `RETRY_BACKOFF` 不在这条路上，别动。',
  '验收：跑 `test/demo.selftest.mjs`（看退出码）——若按上面这处改完它变绿 ⇒ 就是这处；若仍不绿 ⇒ 还有别处，先别说修好。'
].join('\n')
const item = (over = {}) => ({
  schema: 'cfb.gold/1', id: 'demo-s0-r3', family: 'demo', task: 'demo', sample: 0, round: 3, split: 'dev',
  raw: RAW, ctx: 'cwd=/work/repo', draft: GOOD, stored: GOOD, revision: 1,
  outcome: { solved: true, roundsToFix: 5, vsRaw: 'win', rawSolved: false, rawRoundsToFix: 8 },
  qualityAudit: { schema: 'mode1-output-lint/1', status: 'clean', issues: [], textSha256: 'x' },
  ...over
})

// ── 真机台账：两个 home，同 task+sample ⇒ R2 才有 n=2
const cell = (home, { id = 'demo-s0-r3', task = 'demo', draft = GOOD, raw = RAW, fixedAtRound = 5, production = { ok: true } } = {}) => {
  // 台账里 draftFile 记的是「相对仓库根」的路径 ⇒ 尺子按 root 解（真机就是这么写的）
  const df = `${home}/drafts/${id}.md`
  write(`${home}/drafts/${id}.md`, draft)
  write(`${home}/hand-samples.jsonl`, JSON.stringify({
    schema: 'cfb.hand-sample/2', id, task, sample: 0, round: 3, at: '2026-10-05T00:00:00.000Z',
    draftFile: df, pendingFile: null, raw, ctx: 'cwd=/work/repo', draft, stored: draft, rawChars: raw.length, draftChars: draft.length,
    gate: { ok: true, violations: [] }, production, qualityAudit: { status: 'clean' }, trainingEligible: true, revision: 1
  }) + '\n')
  write(`${home}/results.jsonl`, JSON.stringify({ at: '2026-10-05T00:00:00.000Z', task, variant: 'hand', sample: 0, rounds: fixedAtRound, fixedAtRound, verifiedAfterFix: true, edits: [{ path: 'src/a.js', ok: true }], status: null }) + '\n')
  write(`${home}/receipt.json`, JSON.stringify({ spend: 0.07 }) + '\n')
  write(`${home}/plan.json`, JSON.stringify({ steps: 1 }) + '\n')
}

// ── 1) 全绿 fixture：12 轴必须一条不缺地通过（含第二趟，否则 R2 不成立）
cell('.cfb-runtime/traj/tA')
cell('.cfb-runtime/traj/tC')
const g = measureGold(item(), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 } })
assert.equal(GOLD_STANDARD_VERSION, 'cfb.gold-standard/1', '版本钉住：升版要连文档一起改')
assert.ok(g.axes.M1.value <= THRESHOLDS.ratioMax, `M1 压缩力度 ${g.axes.M1.value} ≤ ${THRESHOLDS.ratioMax}`)
for (const id of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'E1', 'E2', 'R1', 'R2']) {
  assert.equal(g.axes[id].pass, true, `${id} 该过：${g.axes[id].value} · ${g.axes[id].note}`)
  assert.equal(g.axes[id].gap, 0, `${id} 过了就不许留 gap`)
}
assert.equal(g.gap, 0, '全过 ⇒ gap=0')
assert.equal(g.drift.length, 0, '台账逐字对齐 ⇒ 无漂移')
assert.equal(g.status, 'gold', '12 轴全过且无漂移才叫 gold')
assert.ok(g.margin > 0 && g.margin <= 1, `margin ∈ (0,1]：${g.margin}`)
assert.equal(g.provenance, 'tA', 'R1 要报出钉在哪一趟（可复查）')

// ── 2) 每条轴单独打断一次：必须翻成 false，且不许偷偷「未测」蒙过
const flip = (label, over, axes, extra = {}) => {
  const m = measureGold(item(over), { root: tmp, lineRow: extra.lineRow === undefined ? { lineChars: 1400, splicedChars: 1400 } : extra.lineRow, ...extra })
  for (const a of axes) {
    if (extra.expectNull) assert.equal(m.axes[a].pass, null, `${label}：${a} 该记未测（fail-closed），不是通过`)
    else assert.equal(m.axes[a].pass, false, `${label}：${a} 该判假（读到 ${m.axes[a].value} · ${m.axes[a].note}）`)
  }
  assert.notEqual(m.status, 'gold', `${label}：状态不得仍是 gold`)
  return m
}
flip('稿太长', { draft: GOOD + '\n' + '补充说明一遍同样的事。'.repeat(60) }, ['M1'])
flip('比产线稿长', {}, ['M2'], { lineRow: { lineChars: 120, splicedChars: 120 } })
flip('缺判读', { draft: '把 `src/a.js` 里的 `const RETRY = 0` 改成 `const RETRY = 2`，别处不动。' }, ['M3', 'M4'])
flip('验收没命令', { draft: GOOD.replace('跑 `test/demo.selftest.mjs`（看退出码）', '自己看一眼结果') }, ['M4'])
flip('编了个标识符', { draft: GOOD + '\n另外把 `const FAKE = 99` 也改掉。' }, ['M5'])
flip('写了沙箱话术', { draft: GOOD + '\n沙箱白名单拦住了 npm，所以本轮不允许再调用工具。' }, ['M6'])
flip('两条改法', { draft: GOOD + '\n`src/b.js` 里的 `RETRY_BACKOFF` 也建议改成 500。' }, ['M8'])
flip('给了菜单', { draft: GOOD.replace('改成 `const RETRY = 2`。', '改成 `const RETRY = 2`，或者也可以直接删掉这行。') }, ['M8'])
flip('裸引思考流', { draft: GOOD + '\nLet me think about whether the fix is worth it.' }, ['M8'])
// 阈值本身要能判：造一条真机行=9 轮的格子（不带漂移，纯粹测阈）
const slowRow = { home: 'x', ledger: null, pause: null, row: { fixedAtRound: 9, verifiedAfterFix: true, rounds: 9, edits: [] }, rtf: 9, rounds: 9, edits: [], receipt: 'no', plan: 'no' }
{
  const m = measureGold(item({ outcome: { solved: true, roundsToFix: 9, vsRaw: 'tie', rawSolved: false, rawRoundsToFix: 7 } }), { root: tmp, provenance: slowRow, lineRow: { lineChars: 4000, splicedChars: 4000 } })
  assert.equal(m.axes.E1.pass, false, `真机 9 轮 > ${THRESHOLDS.rtfMax} 必须判假`)
  assert.equal(m.axes.E2.pass, false, 'tie 且比 raw 慢 ⇒ 判假')
  assert.equal(m.drift.length, 0, '这组只测阈值：自报与真机一致 ⇒ 不该报漂移')
}
flip('输给 raw', { outcome: { solved: false, roundsToFix: 6, vsRaw: 'loss', rawSolved: true, rawRoundsToFix: 7 } }, ['E2'])
flip('话术只在 stored（改稿救不了）', { draft: GOOD, stored: GOOD + '\n下一轮是第 5 轮，预算已用完。' }, [])

// ── 3) fail-closed：没测的不算过（这是本轮定死的那条）
const noLine = measureGold(item(), { root: tmp, lineRow: null })
assert.equal(noLine.axes.M2.pass, null, 'C6 缺产线读数 ⇒ M2 未测')
assert.equal(noLine.status, 'provisional-gold', '缺凭据 ⇒ 顶多 provisional，绝不是 gold')
assert.equal(noLine.pass, false, '未测 ⇒ pass 仍为假（fail-closed：没测不算过）')
const bare = measureGold({ id: 'no-ledger-s0-r1', draft: GOOD }, { root: tmp })   // 故意用一个没有台账的 id：只有未测，不许借别的格子蒙过
assert.equal(bare.axes.M7.pass, null, '无原文 ⇒ G2 未测，不许「视为通过」')
assert.equal(bare.status, 'not-gold', '连 M5/M8 这些都没得测 ⇒ 不许升格')
assert.equal(bare.axes.E1.pass, null, '无真机结局 ⇒ E1 未测')
assert.equal(bare.axes.E2.pass, null, '无真机结局 ⇒ E2 未测')
assert.ok(bare.unmeasured.includes('E1') && bare.unmeasured.includes('M2'), `未测清单要列全：${bare.unmeasured}`)

// ── 4) 改稿即失分：注册稿与台账稿不一致 ⇒ drift ⇒ R1 假、不许 gold
cell('.cfb-runtime/traj/tB', { id: 'drift-s0-r3', draft: GOOD + '\n（台账里发出去的是短版）' })
const drifted = measureGold(item({ id: 'drift-s0-r3' }), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 } })
assert.ok(drifted.drift.some((d) => d.includes('draft≠台账所发')), `要报出「分数不属于这份稿」：${drifted.drift}`)
assert.equal(drifted.axes.R1.pass, false, '台账对不上 ⇒ R1 判假')
assert.notEqual(drifted.status, 'gold', '改过稿却没重跑 ⇒ 不得称金标')

// ── 4b) 注册表 raw 被 padding 撑长 ⇒ 压缩率会做假；M1 必须只认台账那份原文
cell('.cfb-runtime/traj/tE', { id: 'cut-s0-r3', raw: RAW, draft: GOOD })
const padded = RAW + '\n' + 'p'.repeat(6000)
const LONG = GOOD + '\n' + '补充说明一遍同样的事。'.repeat(60)   // ≈1000 字：对台账原文是超线的长稿，对 padding 过的副本却是「压得很狠」
const cut = measureGold(item({ id: 'cut-s0-r3', raw: padded, draft: LONG }), { root: tmp, lineRow: { lineChars: 4000, splicedChars: 4000 } })
assert.ok(cut.axes.M1.value > 0.6, `按台账算的比值要暴露出来：${cut.axes.M1.value}（按副本算只有 ${(LONG.length / padded.length).toFixed(2)}）`)
assert.ok(cut.drift.some((dd) => dd.includes('raw 长度与台账不符')), '副本与原文长度不符要被点名：' + cut.drift.join(' | '))
assert.match(cut.axes.M1.note, /分母取较短那份/, 'M1 要说清分母用了哪份原文：' + cut.axes.M1.note)
assert.equal(cut.axes.M1.pass, false, '按台账全文算超线 ⇒ M1 判假（副本撑长不算数）')

// ── 5) 自报分数不作数：注册表 rtf=5，但真机结局行是 5 ⇒ 一致；改成台账没有的行 ⇒ 未测
const noLedger = measureGold(item({ id: 'ghost-s0-r1' }), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 } })
assert.equal(noLedger.axes.R1.value, 0, '台账里查无此 id ⇒ R1=0')
assert.ok(/hand-samples/.test(noLedger.axes.R1.note), '要指出去哪查：' + noLedger.axes.R1.note.slice(0, 60))
assert.ok(noLedger.drift.some((d) => d.includes('无真机结局行可回放')), '自报 rtf 必须被点出来')

// ── 6) R2：只有一趟 ⇒ n=1 判假；补第二趟 ⇒ 过（同格重复不是新证据 ⇒ 同 home 再加行不许抬 n）
const single = measureGold(item(), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 }, samples: 1 })
assert.equal(single.axes.R2.pass, false, 'n=1 ⇒ R2 不过')
assert.match(single.axes.R2.note, /not-gold/, 'n=1 是已测失败，应标 not-gold（未测才 provisional）')
assert.equal(single.status, 'not-gold', 'R2 已测但不足两趟 ⇒ not-gold，而非 provisional-gold')
const zero = measureGold(item(), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 }, samples: 0 })
assert.match(zero.axes.R2.note, /n=0/, '零样本的说明不得误报成 n=1')
assert.equal(zero.status, 'not-gold', 'R2 n=0 也不得升成 provisional 或 gold')
const two = measureGold(item(), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 }, samples: 2 })
assert.equal(two.axes.R2.pass, true, '两趟独立样本 ⇒ R2 过')

// ── 7) 「…」引用免检，但引用必须是原文（M5 仍要核）
const quoted = measureGold(item({ draft: GOOD + '\n主模型当时说过「先看看仓库结构和这个自测脚本。」' }), { root: tmp, lineRow: { lineChars: 1400, splicedChars: 1400 } })
assert.equal(quoted.axes.M8.value, 1, '「…」里的转述不算第二条改法')
assert.equal(quoted.axes.M5.pass, false, '但引了 raw 里没有的话 ⇒ M5 判假（引用也要逐字）')

console.log('gold-standard.selftest: 12 轴逐一判真/判假 + fail-closed + 漂移与回放口径通过')
console.log(`PASS=${pass} FAIL=0`)
