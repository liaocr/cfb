import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runBash, execTool, resolveRepoPath } from '../tools/traj-run.mjs'
import { TRAJ_TASKS, materialize } from '../tools/traj-fixtures.mjs'
import { appendPrivateAuditEvent, buildReaderSmokeBody, parseReaderSmokeConfig, quoteSmokeRequest, runReaderSmoke } from '../tools/helpers/reader-smoke.mjs'
import { pairDevGenerations } from '../tools/helpers/eval-sft-input.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.log('FAIL ' + name); console.log(e?.stack || String(e)) }
}
const caseRow = () => ({ caseId: 'fixture-case-1', raw: 'PRIVATE_RAW_SENTINEL', ctx: 'PRIVATE_CTX_SENTINEL', reference: 'PRIVATE_REFERENCE_SENTINEL' })
const config = (extra = {}) => parseReaderSmokeConfig({
  MAX_REQUESTS: '9', MAX_USD: '5', MAX_RETRIES: '0', MAX_INPUT_TOKENS: '32768', MAX_OUTPUT_TOKENS: '64',
  REQUEST_TIMEOUT_MS: '3000', INPUT_USD_PER_MILLION: '0.3', OUTPUT_USD_PER_MILLION: '1.2',
  PRICING_SOURCE: 'https://pricing.example/rates', PRICING_VERIFIED_AT: '2026-10-14', ...extra,
}, { forExecution: true })
const streamingBody = (chunks) => ({
  getReader() {
    let i = 0
    return {
      read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
      cancel: async () => { i = chunks.length },
      releaseLock: () => {},
    }
  },
})
const response = ({ status = 200, usage = { prompt_tokens: 40, completion_tokens: 12 }, includeUsage = true, padding = '' } = {}) => {
  const bytes = Buffer.from(JSON.stringify({
    id: 'provider-call-fixture-1', model: 'fixture-model', system_fingerprint: 'fp-fixture', ...(includeUsage ? { usage } : {}),
    choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_PROVIDER_ANSWER', reasoning_content: 'PRIVATE_PROVIDER_REASONING' } }],
    error: { message: 'PRIVATE_PROVIDER_ERROR_BODY' }, ...(padding ? { padding } : {}),
  }))
  return { ok: status >= 200 && status < 300, status, body: streamingBody([bytes]) }
}

await test('F-01 newline/CRLF/shell mini-language injection is rejected; read-only argv commands still work', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-shell-fix-')), repo = path.join(tmp, 'repo'), marker = path.join(tmp, 'outside-owned.txt')
  const task = TRAJ_TASKS.find((t) => t.id === 'perf-regression')
  try {
    materialize(task, repo)
    const pythonPayload = `python3 -c "from pathlib import Path; Path('${marker}').write_text('owned')"`
    for (const payload of [`grep -n max src/config.js\n${pythonPayload}`, `grep -n max src/config.js\r\n${pythonPayload}`]) {
      assert.match(runBash(task, repo, payload), /拒绝.*换行/)
      assert.equal(fs.existsSync(marker), false)
    }
    const quoted = `grep -n 'max; ${pythonPayload}' src/config.js`
    runBash(task, repo, quoted)
    assert.equal(fs.existsSync(marker), false, 'quoted shell metacharacters remain literal argv, never shell syntax')
    for (const cmd of [
      `find . -type f -exec python3 -c "from pathlib import Path; Path('${marker}').write_text('owned')" \\;`,
      `awk 'BEGIN {system("touch ${marker}")}'`,
      `sed -n '1e touch ${marker}' src/config.js`,
    ]) {
      runBash(task, repo, cmd)
      assert.equal(fs.existsSync(marker), false, cmd)
    }
    assert.match(runBash(task, repo, 'grep -n max src/config.js | head -n 1'), /maxOutputTokens/)
    assert.equal(runBash(task, repo, 'find . -type f').trim().split('\n').sort().join(','), './CHANGELOG.md,./README.md,./src/config.js')
    assert.equal(fs.readFileSync(path.join(repo, 'src/config.js'), 'utf8').includes('maxOutputTokens'), true)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

await test('F-01 lexical and symlink paths cannot escape the fixture repository', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-path-fix-')), repo = path.join(tmp, 'repo'), outside = path.join(tmp, 'secret.txt')
  const task = TRAJ_TASKS.find((t) => t.id === 'perf-regression')
  try {
    materialize(task, repo); fs.writeFileSync(outside, 'HOST_SECRET_SENTINEL')
    fs.symlinkSync(outside, path.join(repo, 'outside-link'))
    assert.equal(resolveRepoPath(repo, '../secret.txt'), null)
    assert.equal(resolveRepoPath(repo, 'outside-link'), null)
    assert.doesNotMatch(execTool(task, repo, 'read_file', { path: 'outside-link' }), /HOST_SECRET_SENTINEL/)
    assert.doesNotMatch(runBash(task, repo, 'cat outside-link'), /HOST_SECRET_SENTINEL/)
    assert.match(runBash(task, repo, 'cat /etc/passwd'), /No such file or directory|该沙箱未提供此路径/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

await test('F-02 malformed budgets reject; every retry reserves a request and worst-case cost before dispatch', async () => {
  assert.throws(() => parseReaderSmokeConfig({ MAX_REQUESTS: '1oops' }), /config-invalid:MAX_REQUESTS/)
  assert.throws(() => parseReaderSmokeConfig({ MAX_USD: 'NaN' }), /config-invalid:MAX_USD/)
  assert.throws(() => parseReaderSmokeConfig({ MAX_RETRIES: '-1' }), /config-invalid:MAX_RETRIES/)
  assert.throws(() => parseReaderSmokeConfig({}, { forExecution: true }), /config-required:MAX_REQUESTS/)
  const c = config({ MAX_REQUESTS: '1', MAX_RETRIES: '1' }), events = [], logged = []
  let calls = 0
  const result = await runReaderSmoke({
    cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example/v1', apiKey: 'fixture-only', config: c,
    fetchImpl: async (_url, options) => { events.push('fetch'); calls++; assert.equal(options.redirect, 'error'); return response({ status: 503 }) },
    onReserve: (r) => { events.push('reserve'); logged.push(['reservation', r]) },
    onResult: (r) => logged.push(['result', r]),
  })
  assert.equal(calls, 1, 'MAX_REQUESTS=1 blocks the in-loop retry')
  assert.deepEqual(events, ['reserve', 'fetch'])
  assert.equal(result.budget.requestsReserved, 1)
  assert.equal(result.recordedAttempts, 1)
  assert.equal(result.status, 'halted')
  assert.equal(result.stopReason, 'reader-smoke-request-budget-exhausted')
  assert.ok(logged[0][1].reservedUsd > 0, 'worst-case USD reserved before fetch')
  const noMoney = config({ MAX_USD: '0.000000001' }); calls = 0
  const denied = await runReaderSmoke({ cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: noMoney, fetchImpl: async () => { calls++; return response() } })
  assert.equal(calls, 0, 'cost cap rejected before provider dispatch')
  assert.equal(denied.budget.requestsReserved, 0)
  assert.equal(denied.stopReason, 'reader-smoke-usd-budget-exhausted')

  const retryCase = caseRow(), retryConfig = config({ MAX_REQUESTS: '5', MAX_RETRIES: '1' })
  const body = buildReaderSmokeBody({ model: 'fixture/model', ctx: retryCase.ctx, reasoning: retryCase.raw })
  body.max_tokens = retryConfig.maxOutputTokens; body.stream = false; body.extra_body = { thinking: { type: 'enabled' } }
  const oneQuote = quoteSmokeRequest(body, retryConfig)
  const retryCostCap = { ...retryConfig, maxUsd: oneQuote.reservedUsd * 1.5 }
  calls = 0
  const deniedRetry = await runReaderSmoke({ cases: [retryCase], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: retryCostCap, fetchImpl: async () => { calls++; return response({ status: 503 }) } })
  assert.equal(calls, 1, 'the first failure reservation prevents a second attempt that would exceed MAX_USD')
  assert.equal(deniedRetry.stopReason, 'reader-smoke-usd-budget-exhausted')
  assert.ok(Math.abs(deniedRetry.budget.reservedUsd - oneQuote.reservedUsd) < 1e-9)
})

await test('F-02 request token cap, max_tokens, timeout, and unknown usage all fail closed', async () => {
  let calls = 0
  const small = config({ MAX_INPUT_TOKENS: '1' })
  const tooLarge = await runReaderSmoke({ cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: small, fetchImpl: async () => { calls++; return response() } })
  assert.equal(calls, 0); assert.equal(tooLarge.stopReason, 'reader-smoke-input-token-limit')

  const c = config(), missingUsage = await runReaderSmoke({
    cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: c,
    fetchImpl: async (_url, options) => { calls++; assert.equal(JSON.parse(options.body).max_tokens, c.maxOutputTokens); return response({ includeUsage: false }) },
  })
  assert.equal(calls, 1, 'successful response without usage halts all further requests')
  assert.equal(missingUsage.stopReason, 'reader-smoke-usage-unavailable')

  calls = 0
  const overUsage = await runReaderSmoke({
    cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: c,
    fetchImpl: async () => { calls++; return response({ usage: { prompt_tokens: 10000, completion_tokens: 12 } }) },
  })
  assert.equal(calls, 1); assert.equal(overUsage.stopReason, 'reader-smoke-provider-usage-over-reservation')

  calls = 0
  const timeout = await runReaderSmoke({
    cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: config({ REQUEST_TIMEOUT_MS: '5' }),
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { calls++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })),
  })
  assert.equal(calls, 1); assert.equal(timeout.stopReason, 'request-timeout')

  calls = 0
  const oversized = await runReaderSmoke({
    cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: config({ MAX_RESPONSE_BYTES: '1024' }),
    fetchImpl: async () => { calls++; return response({ padding: 'x'.repeat(2048) }) },
  })
  assert.equal(calls, 1); assert.equal(oversized.stopReason, 'reader-smoke-response-too-large')
})

await test('F-03 persisted audit is private and allowlisted: hashes/usage only, no raw prompt or provider text', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-private-audit-')), file = path.join(tmp, 'smoke.jsonl'), fd = fs.openSync(file, 'wx', 0o600)
  fs.fchmodSync(fd, 0o600)
  try {
    const c = config(), result = await runReaderSmoke({
      cases: [caseRow()], model: 'fixture/model', baseUrl: 'https://provider.example', apiKey: 'fixture-only', config: c,
      fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(JSON.parse(options.body).model, 'fixture/model'); return response() },
      onReserve: (r) => appendPrivateAuditEvent(fd, 'reservation', r),
      onResult: (r) => appendPrivateAuditEvent(fd, 'result', { ...r, raw: 'PRIVATE_RAW_SENTINEL', providerBody: 'PRIVATE_PROVIDER_ANSWER' }),
    })
    assert.equal(result.status, 'complete'); assert.equal(result.recordedAttempts, 3)
    assert.ok(result.results[0].responseSha256)
    assert.equal(Object.hasOwn(result.results[0], 'content'), false)
    appendPrivateAuditEvent(fd, 'run', { status: result.status, expectedSlots: result.expectedSlots, recordedAttempts: result.recordedAttempts, requestsReserved: result.budget.requestsReserved, usdReserved: result.budget.reservedUsd, maxRequests: result.budget.maxRequests, maxUsd: result.budget.maxUsd, maxRetries: c.maxRetries, maxInputTokens: c.maxInputTokens, maxOutputTokens: c.maxOutputTokens, timeoutMs: c.timeoutMs, maxResponseBytes: c.maxResponseBytes, inputUsdPerMillion: c.pricing.inputUsdPerMillion, outputUsdPerMillion: c.pricing.outputUsdPerMillion, requestFeeUsd: c.pricing.requestFeeUsd, pricingSource: c.pricing.source, pricingVerifiedAt: c.pricing.verifiedAt })
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  try {
    const saved = fs.readFileSync(file, 'utf8')
    for (const secret of ['PRIVATE_RAW_SENTINEL', 'PRIVATE_CTX_SENTINEL', 'PRIVATE_REFERENCE_SENTINEL', 'PRIVATE_PROVIDER_ANSWER', 'PRIVATE_PROVIDER_REASONING', 'PRIVATE_PROVIDER_ERROR_BODY', 'provider-call-fixture-1']) assert.equal(saved.includes(secret), false, secret)
    assert.match(saved, /requestSha256/); assert.match(saved, /responseSha256/); assert.match(saved, /prompt_tokens/); assert.match(saved, /pricing\.example\/rates/); assert.match(saved, /timeoutMs/)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

await test('F-04 evaluator requires exact ID coverage, unique rows, and raw+ctx equality', () => {
  const marker = '\n\n[思考过程]\n'
  const dev = [
    { id: 'a', user: '[题面]\nctx-a' + marker + 'raw-a', assistant: 'teacher-a' },
    { id: 'b', user: '[题面]\nctx-b' + marker + 'raw-b', assistant: 'teacher-b' },
  ]
  const gen = [
    { id: 'a', raw: 'raw-a', ctx: 'ctx-a', draft: 'student-a' },
    { id: 'b', raw: 'raw-b', ctx: 'ctx-b', draft: 'student-b' },
  ]
  const paired = pairDevGenerations(dev, gen)
  assert.equal(paired.expected, 2); assert.equal(paired.observed, 2); assert.equal(paired.pairs.length, 2)
  assert.throws(() => pairDevGenerations(dev, [gen[0]]), /missing-generation-ids/)
  assert.throws(() => pairDevGenerations(dev, [gen[0], gen[0]]), /duplicate-generation-ids/)
  assert.throws(() => pairDevGenerations(dev, [...gen, { ...gen[0], id: 'unknown' }]), /unknown-generation-ids/)
  assert.throws(() => pairDevGenerations(dev, [gen[0], { ...gen[1], raw: 'stale-raw' }]), /generation-raw-mismatch/)
  assert.throws(() => pairDevGenerations(dev, [gen[0], { ...gen[1], ctx: 'stale-ctx' }]), /generation-ctx-mismatch/)
  assert.throws(() => pairDevGenerations([...dev, dev[0]], [...gen, gen[0]]), /duplicate-dev-ids/)
})

await test('F-04 CLI regression: repeated passing ID plus missing dev ID is rejected before scoring', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-eval-sft-')), sft = path.join(tmp, 'sft'), genFile = path.join(tmp, 'gen.jsonl'), out = path.join(tmp, 'out.json')
  fs.mkdirSync(sft)
  const mark = '\n\n[思考过程]\n'
  fs.writeFileSync(path.join(sft, 'dev.jsonl'), [
    { id: 'case-a', user: '[题面]\nctx-a' + mark + 'raw-a', assistant: 'teacher-a' },
    { id: 'case-b', user: '[题面]\nctx-b' + mark + 'raw-b', assistant: 'teacher-b' },
  ].map(JSON.stringify).join('\n') + '\n')
  const repeated = { id: 'case-a', raw: 'raw-a', ctx: 'ctx-a', draft: 'easy-pass' }
  fs.writeFileSync(genFile, [repeated, repeated].map(JSON.stringify).join('\n') + '\n')
  try {
    const child = spawnSync(process.execPath, ['tools/eval-sft.mjs', '--sft', sft, '--gen', genFile, '--out', out], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout + child.stderr, /duplicate-generation-ids/)
    assert.match(child.stdout + child.stderr, /missing-generation-ids/)
    assert.equal(fs.existsSync(out), false, 'invalid pairing cannot emit a score report')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

await test('F-05 both legacy Kaggle entrypoints are inert; direct train_gen and old runbook route fail closed', () => {
  const script = path.join(ROOT, 'deploy/kaggle/start.py')
  const inert = spawnSync('python3', [script], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH || '/usr/bin:/bin' } })
  assert.equal(inert.status, 0, inert.stdout + inert.stderr)
  assert.match(inert.stdout, /retired/)
  assert.doesNotMatch(inert.stdout + inert.stderr, /kernels push|GPU.*started/i)
  const blocked = spawnSync('python3', [script, '--execute'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH || '/usr/bin:/bin' } })
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr)
  assert.match(blocked.stderr, /legacy launcher retired/)
  const startSource = fs.readFileSync(script, 'utf8')
  assert.doesNotMatch(startSource, /subprocess|urllib\.request|pip install|KAGGLE_KEY|raw\.githubusercontent\.com/)

  const direct = path.join(ROOT, 'deploy/kaggle/train_gen.py')
  const directRun = spawnSync('python3', [direct], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH || '/usr/bin:/bin' } })
  assert.equal(directRun.status, 2, directRun.stdout + directRun.stderr)
  assert.match(directRun.stdout, /Retired/)
  const directSource = fs.readFileSync(direct, 'utf8')
  assert.doesNotMatch(directSource, /subprocess|urllib|pip install|git clone|torch\.cuda|kaggle_secrets|shell\s*=\s*True/)

  const runbook = fs.readFileSync(path.join(ROOT, 'docs/KAGGLE-GENERATIVE-COMPRESSOR-RUN.md'), 'utf8')
  assert.match(runbook, /train_gen\.py.*tombstone/s)
  assert.doesNotMatch(runbook, /curl\s+[^\n]*train_gen\.py[^\n]*\|\s*python/)
  const notebook = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/micro-generator/kaggle-generative-compressor.ipynb'), 'utf8'))
  assert.equal(notebook.cells.filter((cell) => cell.cell_type === 'code').length, 0, 'retired Kaggle notebook has no executable cells')
  assert.match(notebook.cells.map((cell) => (cell.source || []).join('')).join('\n'), /已退役/)

})

console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
