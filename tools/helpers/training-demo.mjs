// 无网完整训练演练：实际小模型SGD、续训等价、模拟远程任务只走loopback。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { assertOfflineNamespace } from '../verify-offline.mjs'
import { normalizeTrainingExample, gateTrainingRelease } from '../../src/training-core.js'
import { openTrainingAuthorities } from './training-workflow.mjs'
import { buildTrainingDataset } from './training-data.mjs'
import { prepareTrainingPlan } from './training-plan.mjs'
import { trainReferenceModel } from './training-reference.mjs'
import { runRemoteTraining } from './training-remote.mjs'
export function trainingFixtureRows(n = 8) {
  return Array.from({ length: n }, (_, i) => normalizeTrainingExample({ schema: 'cfb.training-example/1', uid: 'fixture-' + i, family: 'fixture-family-' + i, lineage: 'fixture-origin-' + i, objective: 'sft',
    source: { kind: 'fixture', id: 'training-fixture-' + i, sha256: crypto.createHash('sha256').update('fixture-' + i).digest('hex'), trainingAllowed: true, license: 'fixture-only' },
    messages: [{ role: 'user', content: '完整输入：检查独立配置 config-' + i + '.txt，保留全部原文与验收边界。' }],
    target: '定位结果 ' + i + '：config-' + i + '.txt 的配置已核对。下一步只修改这个配置；用新的独立验收确认原症状消失，未验证前不宣称完成。' }))
}
export async function trainingDemo() {
  const boundary = assertOfflineNamespace(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-training-demo-'))
  try {
    const authority = openTrainingAuthorities(path.join(root, 'private'), { verifyReview: () => true, authorize: () => true })
    const rows = authority.reviews.approveBatch(trainingFixtureRows(), { mode: 'fixture', reviewer: 'offline-fixture', checks: { identifierSafe: true, completeNative: true, goalVerified: true, criterionFrozen: true } })
    const input = path.join(root, 'records.jsonl'); fs.writeFileSync(input, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const dataset = path.join(root, 'dataset'), manifest = await buildTrainingDataset({ input, output: dataset, reviews: authority.reviews })
    const profile = { schema: 'cfb.training-profile/1', backend: 'reference-byte', recipe: { maxSteps: 20, checkpointEvery: 5, learningRate: 1 }, model: { id: null, path: null, revision: null, licenseAccepted: false } }
    const plan = await prepareTrainingPlan({ dataset, reviews: authority.reviews, profile, file: path.join(root, 'plan.json') })
    const resumedDirectory = path.join(root, 'resumed'), resumedMarker = path.join(root, 'resumed.public.json')
    const partial = await trainReferenceModel({ plan, reviews: authority.reviews, directory: resumedDirectory, markerPath: resumedMarker, stopAfter: 5 })
    assert.equal(partial.steps, 5)
    const resumed = await trainReferenceModel({ plan, reviews: authority.reviews, directory: resumedDirectory, markerPath: resumedMarker })
    const uninterrupted = await trainReferenceModel({ plan, reviews: authority.reviews, directory: path.join(root, 'uninterrupted'), markerPath: path.join(root, 'uninterrupted.public.json') })
    assert.equal(resumed.sha256, uninterrupted.sha256); assert.ok(resumed.trainLoss < resumed.initialLoss)
    const cached = await trainReferenceModel({ plan, reviews: authority.reviews, directory: resumedDirectory, markerPath: resumedMarker }); assert.equal(cached.cached, true)
    const remoteProfile = { ...profile, backend: 'remote-finetune', model: { id: 'fixture-base', path: null, revision: 'a'.repeat(40), licenseAccepted: true }, limits: { maxUsd: 1 },
      provider: { protocol: 'files-finetuning-jobs/1', baseUrl: 'https://training.example.invalid/v1', apiKeyEnv: 'MODEL_TRAINING_KEY', supportsFineTuning: true, models: ['fixture-base'], pricing: { trainingUsdPerMillion: 0.01, fixedJobFeeUsd: 0, source: 'https://training.example.invalid/pricing', verifiedAt: '2026-09-30' } } }
    const remotePlan = await prepareTrainingPlan({ dataset, reviews: authority.reviews, profile: remoteProfile, file: path.join(root, 'remote-plan.json') })
    const approval = authority.governance.approve(remotePlan, { mode: 'fixture', owner: 'offline-fixture', maxUsd: 1 })
    let requests = 0, create = 0, uploaded = []
    const server = http.createServer((req, res) => {
      const b = []; req.on('data', (v) => b.push(v)); req.on('end', () => {
        requests++; const body = Buffer.concat(b).toString(); let reply
        if (req.url === '/v1/files') { uploaded.push(body); reply = { id: 'file-' + requests } }
        else if (req.method === 'POST') { create++; reply = { id: 'ftjob-fixture', status: 'running' } }
        else reply = { id: 'ftjob-fixture', status: 'succeeded', fine_tuned_model: 'fixture-trained-compiler' }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    let remote, repeated
    try {
      const fetchImpl = (url, o) => fetch('http://127.0.0.1:' + server.address().port + new URL(url).pathname, o)
      const opts = { plan: remotePlan, reviews: authority.reviews, approval, directory: path.join(root, 'remote-state'), markerPath: path.join(root, 'remote.public.json'), apiKey: 'offline-training-fixture', live: true, fetchImpl, now: Date.parse('2026-09-30T12:00:00Z') }
      remote = await runRemoteTraining(opts); repeated = await runRemoteTraining(opts)
      assert.equal(requests, 4); assert.equal(create, 1); assert.equal(repeated.cached, true)
      assert.ok(uploaded.every((b) => !b.includes('custody/test') && !b.includes('reviewRef') && !b.includes('"family"')))
    } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
    const rejected = gateTrainingRelease([{ split: 'test', taskId: 'fixture', criterion: 'goal', family: 'fixture', before: false, after: true }], { simulated: true })
    assert.equal(rejected.ok, false)
    return { schema: 'cfb.offline-training-demo/1', boundary, externalApiCalls: 0, paidTrainingJobs: 0, costUsd: 0,
      dataset: { reviewed: manifest.reviewed, groups: manifest.groups, counts: manifest.counts, testUploaded: false },
      reference: { actualGradientSteps: resumed.steps, initialLoss: resumed.initialLoss, finalTrainLoss: resumed.trainLoss, resumeBitwiseEqual: resumed.sha256 === uninterrupted.sha256, repeatedGradientSteps: 0, testRead: resumed.testRead },
      remoteFixture: { httpRequests: requests, uploads: 2, submissions: create, statusQueries: 1, extraRequestsOnRepeat: 0, candidateOnly: true },
      release: rejected, limitations: ['只实训了无依赖byte测试模型，不是LoRA/LLM效果。', '远程为真实loopback HTTP替身，不证明供应商有微调/计费能力。', '数据与判据代理自写、参考已知，不是独立泛化。'] }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
