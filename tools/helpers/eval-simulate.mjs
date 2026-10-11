// 同一生产评测路径的真实 loopback 演练；固定替身回答，不是LLM/泛化验证。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { assertOfflineNamespace } from '../verify-offline.mjs'
import { prepareEvaluation, executePreparedEvaluation, reportEvaluation } from './eval-workflow.mjs'
import { loadPrepared } from './eval-workflow.mjs'
import { exportEvaluationBundle, importEvaluationBundle } from './eval-bundle.mjs'
import { createBudgetedChat } from './api-budget.mjs'
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://fixture.example.invalid/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 10000, maxResponseBytes: 1048576,
  pricing: { inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.05, requestFeeUsd: 0, source: 'https://fixture.example.invalid/pricing', verifiedAt: '2026-09-30' } }
const FIXTURE_KEY = 'offline-fixture-only', PASSWORD = 'offline-checkpoint-fixture-passphrase'
const COMMANDS = { 'flaky-timeout': 'node --trace-event-categories v8,node,node.async_hooks test/hedge.selftest.mjs', 'wrong-model': 'grep -n -C 5 "callConfig\\|host.observe" src/plugin.js', 'eacces-config': 'sed -n "1,180p" verify.mjs' }
async function fixtureServer(plan, scenario, { abortController } = {}) {
  let count = 0
  const timers = new Set()
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    const parts = []; let bytes = 0
    req.on('data', (c) => { bytes += c.length; if (bytes > 1024 * 1024) req.destroy(); else parts.push(c) })
    req.on('end', () => {
      count++; const job = plan.jobs[count - 1]
      if (scenario === 'cancellation' && count === 1) { const t = setTimeout(() => { timers.delete(t); abortController?.abort() }, 20); timers.add(t) }
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + FIXTURE_KEY || !job) { res.writeHead(400); res.end(); return }
      let body; try { body = JSON.parse(Buffer.concat(parts).toString()) } catch { res.writeHead(400); res.end(); return }
      assert.equal(body.model, plan.model)
      const payload = { model: plan.model, system_fingerprint: 'fp_dspure_app_v1', usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ finish_reason: job.kind === 'probe' ? 'stop' : 'tool_calls', message: {
        reasoning_content: '本机固定替身，不代表真实模型推理。', content: job.kind === 'probe' ? plan.canary : null,
        ...(job.kind === 'main' ? { tool_calls: [{ id: 'fixture-' + count, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: COMMANDS[job.task] }) } }] } : {}),
      } }] }
      if (count === 1) {
        if (scenario === 'wrong-model') payload.model = 'wrong-model'
        if (scenario === 'null-fingerprint') payload.system_fingerprint = null
        if (scenario === 'history-invisible') payload.choices[0].message.content = '标记不可见'
        if (scenario === 'truncated') payload.choices[0].finish_reason = 'length'
        if (scenario === 'missing-usage') delete payload.usage.completion_tokens
        if (scenario === 'http-503') { res.writeHead(503); res.end('private-proxy-body'); return }
        if (scenario === 'oversized') { res.end('z'.repeat(1048577)); return }
      }
      if (count === 2 && scenario === 'malformed-tool') payload.choices[0].message.tool_calls[0].function.arguments = '{broken'
      const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)) }
      if (scenario === 'cancellation') { const t = setTimeout(() => { timers.delete(t); send() }, 200); timers.add(t) } else send()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  // 重写到固定loopback，绝不把冻结https fixture或用户真实endpoint交给网络。
  const fetchImpl = (_url, options) => fetch(base + '/v1/chat/completions', options)
  const close = async () => { for (const t of timers) clearTimeout(t); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  return { fetchImpl, count: () => count, close }
}
export async function simulateReadyEvaluation() {
  const boundary = assertOfflineNamespace(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-ready-simulation-'))
  const make = (name) => ({ home: path.join(root, name, 'state'), receiptPath: path.join(root, name, 'public-watermark.json') })
  try {
    const healthy = make('healthy')
    prepareEvaluation({ ...healthy, profile: PROFILE, simulation: true })
    const plan = loadPrepared(healthy.home), server = await fixtureServer(plan, 'healthy')
    let summary, resumed, exported, imported
    try {
      const first = await executePreparedEvaluation({ ...healthy, apiKey: FIXTURE_KEY, fetchImpl: server.fetchImpl, stopAfter: 5 })
      assert.equal(first.requestsReserved, 5); assert.equal(first.stopped, 'operator-checkpoint')
      const checkpoint = path.join(root, 'latest.cfbstate')
      exported = exportEvaluationBundle({ ...healthy, file: checkpoint, passphrase: PASSWORD })
      fs.rmSync(healthy.home, { recursive: true, force: true })   // 只删除本演练自己生成的临时树
      let attempted = 0
      assert.throws(() => createBudgetedChat({ plan, apiKey: FIXTURE_KEY, directory: path.join(healthy.home, 'ledger'), receiptPath: healthy.receiptPath, fetchImpl: async () => { attempted++; } }), /api-budget-restore-required/)
      assert.equal(attempted, 0)
      imported = importEvaluationBundle({ ...healthy, file: checkpoint, passphrase: PASSWORD })
      summary = await executePreparedEvaluation({ ...healthy, apiKey: FIXTURE_KEY, fetchImpl: server.fetchImpl })
      assert.equal(summary.complete, true); assert.equal(summary.requestsReserved, 13); assert.equal(server.count(), 13)
      resumed = await executePreparedEvaluation({ ...healthy, apiKey: FIXTURE_KEY, fetchImpl: server.fetchImpl })
      assert.equal(resumed.complete, true); assert.equal(server.count(), 13)
      assert.equal(reportEvaluation(healthy).pairedMainResponses, 12)
    } finally { await server.close() }
    const expected = { 'wrong-model': 'channel-model-mismatch', 'null-fingerprint': 'channel-fingerprint', 'history-invisible': 'channel-history-not-visible', 'http-503': 'HTTP 503', truncated: 'response-incomplete', 'missing-usage': 'api-usage-out-of-bound', 'malformed-tool': 'response-tool-arguments', oversized: 'response-byte-limit', cancellation: 'request-aborted' }
    const faults = []
    for (const [scenario, reason] of Object.entries(expected)) {
      const workspace = make(scenario); prepareEvaluation({ ...workspace, profile: PROFILE, simulation: true })
      const ctl = new AbortController(), s = await fixtureServer(loadPrepared(workspace.home), scenario, { abortController: ctl })
      try {
        const r = await executePreparedEvaluation({ ...workspace, apiKey: FIXTURE_KEY, fetchImpl: s.fetchImpl, signal: ctl.signal })
        assert.equal(r.complete, false); assert.equal(r.stopped, reason)
        const n = s.count()
        if (scenario !== 'cancellation') assert.equal(n, scenario === 'malformed-tool' ? 2 : 1)
        else assert.ok(n <= 1)
        const again = await executePreparedEvaluation({ ...workspace, apiKey: FIXTURE_KEY, fetchImpl: s.fetchImpl })
        assert.equal(again.complete, false); assert.equal(s.count(), n)   // 坏渠道/未知不重试也不补样本
        faults.push({ scenario, stopped: r.stopped, loopbackRequests: n, extraRequestsOnResume: 0 })
      } finally { await s.close() }
    }
    return { schema: 'cfb.offline-ready-simulation/1', boundary, externalApiCalls: 0, externalModelCalls: 0, paidCostUsd: 0,
      healthy: { complete: summary.complete, pairedMainResponses: summary.pairedMainResponses, loopbackRequests: 13, checkpointAt: 5, restoredRequests: imported.requestsReserved, repeatRequests: 0, encryptedCheckpointBytes: exported.bytes }, faults,
      limitation: '固定替身共享生产执行路径，仅证明协议/预算/恢复与故障关闭；不执行返回shell，不证明LLM理解/真实计费/修复成功/独立泛化。' }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
