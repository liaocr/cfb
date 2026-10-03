// test/training-ready.selftest.mjs —— 离线训练数据纯内核（src/training-core.js）与 cfb-cycle export-train 自测
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { setCycleDir, cmdExportTrain, GOLD_DIR, TRAIN_PAIRS } from '../tools/cfb-cycle.mjs'

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n  ${e.stack || e.message}`) }
}

const sampleSft = (uid, family, lineage, prompt, target) => ({
  schema: I.TRAINING_SCHEMA,
  uid,
  family,
  lineage,
  objective: 'sft',
  messages: [{ role: 'user', content: prompt }],
  target,
  source: { kind: 'operator', id: uid, sha256: I.evidenceDigest({ uid, prompt, target }), trainingAllowed: true, license: 'internal' },
})

const samplePref = (uid, family, lineage, prompt, chosen, rejected) => ({
  schema: I.TRAINING_SCHEMA,
  uid,
  family,
  lineage,
  objective: 'preference',
  messages: [{ role: 'user', content: prompt }],
  chosen,
  rejected,
  source: { kind: 'historical', id: uid, sha256: I.evidenceDigest({ uid, prompt, chosen, rejected }), trainingAllowed: true, license: 'internal' },
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-train-core-'))
try {
  await test('normalizeTrainingExample：SFT 与偏好对模式校验、敏感凭据拦截与确定性摘要', () => {
    const sft = I.normalizeTrainingExample(sampleSft('u1', 'fam-a', 'lin-1', '请压缩思维链 A', '压缩稿 A'))
    assert.equal(sft.objective, 'sft')
    assert.equal(typeof sft.digest, 'string')
    const pref = I.normalizeTrainingExample(samplePref('u2', 'fam-b', 'lin-2', '请压缩思维链 B', '好稿 B', '差稿 B'))
    assert.equal(pref.objective, 'preference')
    // 含 sk- 密钥的样本被拒绝
    assert.throws(() => I.normalizeTrainingExample(sampleSft('u3', 'fam-c', 'lin-3', 'Authorization: Bearer sk-1234567890abcdefghijklmnop', '稿')), /training-secret-material/)
    // chosen === rejected 被拒绝
    assert.throws(() => I.normalizeTrainingExample(samplePref('u4', 'fam-c', 'lin-4', 'prompt', '同一份稿', '同一份稿')), /training-target/)
  })

  await test('splitTrainingGroups：按 family / lineage / input / target 连通分量无泄漏切分 train / selection / test', () => {
    const records = [
      I.normalizeTrainingExample(sampleSft('g1', 'fam-1', 'l1', 'input-1', 'target-1')),
      // 与 g1 共享 target-1，即使写成不同 family 也必须被连通分量锁在同一 split！
      I.normalizeTrainingExample(sampleSft('g2', 'fam-1b', 'l2', 'input-2', 'target-1')),
      I.normalizeTrainingExample(samplePref('g3', 'fam-2', 'l3', 'input-3', 'chosen-3', 'rejected-3')),
      I.normalizeTrainingExample(samplePref('g4', 'fam-3', 'l4', 'input-4', 'chosen-4', 'rejected-4')),
      I.normalizeTrainingExample(sampleSft('g5', 'fam-4', 'l5', 'input-5', 'target-5')),
    ]
    const split = I.splitTrainingGroups(records, { seed: 'unit-seed' })
    assert.equal(split.schema, 'cfb.training-split/1')
    assert.equal(split.assignment[records[0].digest], split.assignment[records[1].digest], '共享 target 的两条样本必须在同一连通分量')
    assert.ok(split.counts.train >= 1 && split.counts.selection >= 1 && split.counts.test >= 1)
  })

  await test('freezeTrainingEvaluation / gateTrainingRelease：训练发布闸门要求非模拟、留出集全正、零退化', () => {
    const suite = I.freezeTrainingEvaluation({
      id: 'eval-1',
      evaluatorDigest: 'e'.repeat(64),
      items: [
        { split: 'train', taskId: 't0', family: 'fam-0', criterion: 'next' },
        { split: 'selection', taskId: 't1', family: 'fam-1', criterion: 'next' },
        { split: 'test', taskId: 't2', family: 'fam-2', criterion: 'next' },
      ],
    })
    const effects = [
      { split: 'train', taskId: 't0', family: 'fam-0', criterion: 'next', before: false, after: true },
      { split: 'selection', taskId: 't1', family: 'fam-1', criterion: 'next', before: false, after: true },
      { split: 'test', taskId: 't2', family: 'fam-2', criterion: 'next', before: false, after: true },
    ]
    assert.equal(I.gateTrainingRelease(effects, { simulated: true, suite }).reason, 'training-simulation-not-release')
    assert.equal(I.gateTrainingRelease(effects, { simulated: false, suite }).ok, true)
  })

  await test('cfb-cycle export-train：从金标注册表与飞轮偏好对直接无泄漏导出 train/selection/test.jsonl', () => {
    setCycleDir(tmp)
    for (const [fam, id] of [['fam-a', 'ga'], ['fam-b', 'gb'], ['fam-c', 'gc'], ['fam-d', 'gd']]) {
      const dir = path.join(GOLD_DIR(), fam)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        schema: 'cfb.gold/1', id, family: fam, split: 'dev', plan: 't1', validated: true,
        raw: `raw reasoning for ${fam}`, ctx: `ctx for ${fam}`, draft: `draft for ${fam}`,
      }))
    }
    fs.mkdirSync(path.dirname(TRAIN_PAIRS), { recursive: true })
    fs.writeFileSync(TRAIN_PAIRS, JSON.stringify({
      round: 1, task: 'fam-e', chosenText: '赢稿 E', rejectedText: '输稿 E', hypothesis: { lever: 'policy', value: 'p1' },
    }) + '\n')
    const outDir = path.join(tmp, 'exported')
    const res = cmdExportTrain(['--out', outDir])
    assert.equal(res.ok, true)
    assert.equal(res.examples, 5)
    assert.ok(fs.existsSync(path.join(outDir, 'train.jsonl')))
    assert.ok(fs.existsSync(path.join(outDir, 'selection.jsonl')))
    assert.ok(fs.existsSync(path.join(outDir, 'test.jsonl')))
    assert.ok(fs.existsSync(path.join(outDir, 'split.json')))
  })
} finally {
  setCycleDir(null)
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exitCode = 1
