// 人工盲审工具的自测：证明「审核者看不到规则」、「坏行被拒」、「继承判据是 digest 而不是数据集 sha」
// （后者是 v14.24.1 我自己踩过的坑：apply 的 sha 闸把 245 条已完成审核整批判废过一次。）
import nodeAssert from 'node:assert/strict'
// 计数代理：让 verify 能读到「N passed」，与仓库其它自测同格式
let checked = 0
const assert = new Proxy(nodeAssert, { get: (t, k) => (...a) => { checked++; return t[k](...a) } })
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TOOL = path.join(ROOT, 'tools', 'review-unit-labels-manual.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-review-'))
const ds = (units) => { const f = path.join(tmp, 'micro-dev-dataset.json'); fs.writeFileSync(f, JSON.stringify({ schema: 'cfb.micro-dev-dataset/3', holdoutTouched: false, unitSamples: units }, null, 1)); return f }
const unit = (i, text, extra = {}) => ({ globalIdx: i, sourceId: `src-${i}`, unitIdx: i, totalUnits: 9, family: 'sse-truncated', text, trainingEligible: false, slot: 'NOISE', yVal: 0.05, yTempt: 0.3, labelAudit: { labelRule: 'mechanism-heuristic-only' }, ...extra })
const OUT = () => path.join(tmp, 'review.json')
const sheet = () => path.join(tmp, 'sheet.jsonl')
const run = (args, dataset) => execFileSync(process.execPath, [TOOL, ...args, '--dataset', dataset, '--out', OUT(), '--sheet', sheet()], { encoding: 'utf8' })
const read = () => JSON.parse(fs.readFileSync(OUT(), 'utf8'))

const base = [unit(0, 'The root cause is the settle gate accepting out.length > 0.'), unit(1, 'ok'), unit(2, 'Run npm test: truncated stream must settle ok:false.'), unit(3, 'Maybe the compat file is a decoy, not imported anywhere.')]
const d1 = ds(base)

// 1) 工作表必须是盲的：只带四个字段，规则槽位/旗标/规则名一律不许出现
run(['dump'], d1)
const rows = fs.readFileSync(sheet(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
assert.equal(rows.length, 3, '文本 <8 字的单元不该进工作表')
for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['document', 'family', 'id', 'position', 'text'], `工作表泄了规则信息：${Object.keys(r).join(',')}`)
assert.ok(!JSON.stringify(rows).includes('NOISE'), '工作表里出现了规则槽位 ⇒ 盲审不成立')
assert.ok(!JSON.stringify(rows).includes('mechanism-heuristic-only'), '工作表里出现了规则名 ⇒ 盲审不成立')

// 2) 合法判定入库；坏行被拒且报出原因
fs.writeFileSync(path.join(tmp, 'v.jsonl'), [
  JSON.stringify({ id: 'u0', slot: 'MECHANISM', yVal: 0.86, yTempt: 0.06, confidence: 'high', rationale: '给出 settle 判定链' }),
  JSON.stringify({ id: 'u2', slot: 'ACCEPT', yVal: 0.8, yTempt: 0.06, confidence: 'medium', rationale: '写了可执行验收命令' }),
  JSON.stringify({ id: 'u3', slot: 'NOISE', yVal: 0.05, yTempt: 0.4, confidence: 'low', rationale: '未核实是否为诱饵' }),
  JSON.stringify({ id: 'u0', slot: 'BAD-SLOT', yVal: 2, yTempt: 0, confidence: 'high', rationale: '' }),
  JSON.stringify({ id: 'u99', slot: 'OPEN', yVal: 0.7, yTempt: 0.1, confidence: 'high', rationale: '不存在的 id' }),
  '{ 这不是 JSON',
].join('\n') + '\n')
const applyOut = run(['apply', '--verdicts', path.join(tmp, 'v.jsonl'), '--scope', 'needs-review'], d1)
assert.match(applyOut, /收 3 条 \/ 退 3 条/, applyOut)
const doc = read()
assert.equal(doc.reviewProtocol, 'blind-unit-label-v3', '必须沿用 v3 盲审协议，否则构建器不认')
assert.equal(doc.reviewerKind, 'blind-human-agent-no-rule-suggestions')
assert.equal(doc.items.length, 3)
assert.equal(doc.items.find((r) => r.id === 'u3').confidence, 'low', 'low 也入库留痕（是否回灌由构建器决定）')
assert.ok(doc.datasetSha256AtReview && doc.selectionRule.includes('trainingEligible=false'))

// 3) 数据集变了但单元 digest 仍存活 ⇒ 审核必须继承（sha 闸会误废整批）
const d2 = ds(base.map((u) => ({ ...u, extraNoise: 'rebuild 之后数据集字节变了' })))
const again = run(['apply', '--verdicts', path.join(tmp, 'v.jsonl'), '--scope', 'needs-review'], d2)
assert.match(again, /收 3 条/, again)
assert.equal(read().items.length, 3, 'digest 仍存活却被丢弃 ⇒ 继承判据又退回 sha 闸了')

// 4) 单元正文被改 ⇒ digest 变 ⇒ 不重提交时那条旧审核必须丢弃（不许拿旧标注套新数据）
const d3 = ds(base.map((u) => (u.globalIdx === 0 ? { ...u, text: 'COMPLETELY DIFFERENT TEXT AFTER REWRITE.' } : u)))
fs.writeFileSync(path.join(tmp, 'v-none.jsonl'), '')
const staleDigest = doc.items.find((r) => r.id === 'u0').digest
const third = run(['apply', '--verdicts', path.join(tmp, 'v-none.jsonl'), '--scope', 'all'], d3)
assert.match(third, /继承 2\/3 条/, third)
assert.ok(read().items.every((r) => r.id !== 'u0'), '正文已改的单元不该保留旧判定')

// 5) 同一条判定在新数据集上重提交 ⇒ 以新 digest 重新入库（说明绑定的是单元而非文件）
const re = run(['apply', '--verdicts', path.join(tmp, 'v.jsonl'), '--scope', 'all'], d3)
assert.match(re, /收 3 条/, re)
assert.equal(read().items.length, 3)
assert.notEqual(read().items.find((r) => r.id === 'u0').digest, staleDigest, 'digest 没随正文更新')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`PASS=${checked} FAIL=0`)
console.log('micro-label-review.selftest: 盲审工作表不泄规则 / 坏行拒绝 / digest 继承 / 改稿丢弃 / 重提交换 digest 通过')
