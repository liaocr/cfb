// 离线生命周期/跨轮丢仓/加密迁移；所有传输mock，最后整链仅lo真实HTTP。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeChat } from '../tools/effect-eval.mjs'
import { createEvidenceStore } from '../src/evidence-store.js'
import { buildMinimalPlan, summarizeMinimal } from '../tools/bounded-ab.mjs'
import { auditApiPlan, createBudgetedChat, inspectApiBudget, quoteJob } from '../tools/helpers/api-budget.mjs'
import { apiStoreDirectory, readWatermark } from '../tools/helpers/api-watermark.mjs'
import { prepareEvaluation, doctorEvaluation, reportEvaluation, loadPrepared, executePreparedEvaluation, normalizeBaseUrl, normalizeProfile, runEvaluation } from '../tools/helpers/eval-workflow.mjs'
import { exportEvaluationBundle, importEvaluationBundle } from '../tools/helpers/eval-bundle.mjs'
import { readJson, writeJson, assertSafePath } from '../tools/helpers/eval-files.mjs'
import { readyMain } from '../tools/effect-ready.mjs'
import { simulateReadyEvaluation } from '../tools/helpers/eval-simulate.mjs'
import { canSymlink } from './helpers/platform.mjs'
import { offlineNamespaceVerifiable } from '../tools/verify-offline.mjs'

let pass = 0, fail = 0, skip = 0
// fn 返回 'skip' ⇒ 记为跳过，**既不计通过也不计失败**（`verify.mjs` 靠 stdout 里的 SKIP=n 分开统计）
const test = async (name, fn) => { try { const r = await fn(); if (r === 'skip') { skip++; console.log('SKIP ' + name) } else { pass++; console.log('PASS ' + name) } } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-eval-ready-'))
const NOW = Date.parse('2026-09-30T12:00:00Z'), KEY = 'offline-key-fixture-not-a-secret', PASS = 'offline-fixture-checkpoint-passphrase'
const PRICING = { inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.05, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-09-30' }
const PROFILE = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
const fresh = () => { const dir = fs.mkdtempSync(path.join(ROOT, 'case-')); return { home: path.join(dir, 'state'), receiptPath: path.join(dir, 'public.json'), dir } }
const prepared = (o = {}) => { const w = fresh(); prepareEvaluation({ ...w, profile: PROFILE, ...o }); return { ...w, plan: loadPrepared(w.home) } }
const payload = (plan, changes = {}) => ({ model: plan.model, system_fingerprint: 'fp_dspure_app_v1', usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: plan.canary, reasoning_content: '本机固定响应', vendorDebug: 'ignored' } }], ...changes })
const mock = (plan, f = () => payload(plan)) => { let n = 0; return { count: () => n, fetchImpl: async (_url, options) => { n++; return { ok: true, status: 200, text: async () => JSON.stringify(await f(JSON.parse(options.body), n)) } } } }
const client = (w, m, extra = {}) => createBudgetedChat({ plan: w.plan, apiKey: KEY, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath, fetchImpl: m.fetchImpl, ...extra })
const exportBundle = (w, name = 'checkpoint.cfbstate') => { const file = path.join(w.dir, name); exportEvaluationBundle({ ...w, file, passphrase: PASS }); return file }
const walkText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.isDirectory() ? walkText(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name)).toString()).join('\n')

try {
  await test('01 规范化同址Markdown；不是把label当地址或猜端点', () => {
    assert.equal(normalizeBaseUrl('[https://api.a6api.com/v1](https://api.a6api.com/v1)'), 'https://api.a6api.com/v1')
    assert.throws(() => normalizeBaseUrl('[https://safe.test](https://evil.test)'), /profile-endpoint-label/)
  })
  await test('02 HTTPS、无query/userinfo/fragment；完整completion URL不重复拼接', () => {
    for (const u of ['http://host.test/v1', 'https://u:p@host.test/v1', 'https://host.test/v1?key=x', 'https://host.test/v1#x', 'https://host.test/v1/chat/completions']) assert.throws(() => normalizeBaseUrl(u), /profile-endpoint/)
  })
  await test('03 profile只有环境引用，拒绝明文和GitHub/PAT引用', () => {
    assert.equal(normalizeProfile(PROFILE).execution.apiKeyEnv, 'DEEPSEEK_API_KEY')
    assert.throws(() => normalizeProfile({ ...PROFILE, apiKey: 'fixture' }), /profile-schema/)
    assert.throws(() => normalizeProfile({ ...PROFILE, apiKeyEnv: 'GITHUB_PAT' }), /profile-execution/)
    assert.throws(() => normalizeProfile({ ...PROFILE, arbitrary: 'sk-' + 'X'.repeat(32) }), /profile-schema-or-secret/)
  })
  await test('04 文件读取拒绝.git/.secrets/.env与悬空symlink', () => {
    const w = fresh(); for (const p of ['.git/config', '.secrets/keys.env', '.env']) assert.throws(() => assertSafePath(path.join(w.dir, p)), /eval-path-protected/)
    const link = path.join(w.dir, 'linked')
    // 符号链接在 Windows 需要开发者模式/管理员；本平台建不出来时该安全检查无法验证，显式跳过。
    if (!canSymlink()) { console.log('  (跳过悬空 symlink 拒绝断言：当前平台无法创建符号链接)'); return }
    fs.symlinkSync(path.join(w.dir, 'missing'), link)
    assert.throws(() => assertSafePath(link), /eval-path-symlink/)
  })
  await test('05 prepare缺价/钥匙仍可冻结；不创建预算或保存环境值', () => {
    const w = fresh(), r = prepareEvaluation({ ...w, profile: { ...PROFILE, pricing: null }, env: { DEEPSEEK_API_KEY: KEY } })
    assert.equal(r.prepared, true); assert.equal(r.status, 'blocked'); assert.equal(r.networkTouched, false)
    assert.equal(fs.existsSync(path.join(w.home, 'ledger')), false); assert.equal(fs.existsSync(w.receiptPath), false)
    assert.ok(!walkText(w.home).includes(KEY))
  })
  await test('06 doctor纯只读：没有计划不创建目录、不读凭据文件', () => {
    const w = fresh(), d = doctorEvaluation(w)
    assert.equal(d.status, 'blocked'); assert.equal(d.networkTouched, false); assert.equal(fs.existsSync(w.home), false)
  })
  await test('07 预检通过仅表示preflight-ready，不能假称通道已验证', () => {
    const w = prepared(), d = doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY }, now: NOW })
    assert.equal(d.status, 'live-preflight-ready'); assert.equal(d.channel, 'not-live-verified'); assert.equal(d.requestsReserved, null)
    assert.ok(!JSON.stringify(d).includes(KEY))
    assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY, CFB_OFFLINE: '1' }, now: NOW }).status, 'blocked')
    assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, now: NOW }).status, 'blocked')
  })
  await test('08 来源日期真实/新鲜；样例、过期、未来报价不能live', () => {
    const w = prepared(); assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY }, now: NOW + 9 * 86400000 }).status, 'blocked')
    assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY }, now: NOW - 86400000 }).status, 'blocked')
    const zero = prepared({ profile: { ...PROFILE, pricing: { ...PRICING, inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } }); assert.equal(doctorEvaluation({ ...zero, env: { DEEPSEEK_API_KEY: KEY }, now: NOW }).status, 'blocked')
    for (const verifiedAt of ['2026-99-31', '2026-09-31']) assert.throws(() => quoteJob(w.plan.jobs[0].body, { ...PRICING, verifiedAt }), /api-pricing-required/)
  })
  await test('09 环境模型/endpoint漂移或坏URL只阻塞，不泄露参数', () => {
    const w = prepared()
    for (const env of [{ DEEPSEEK_MODEL: 'other' }, { DEEPSEEK_BASE_URL: 'not-a-url' }]) assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY, ...env }, now: NOW }).status, 'blocked')
  })
  await test('10 篡改执行环境引用为GITHUB不会读取/使用PAT', () => {
    const w = prepared(), p = readJson(path.join(w.home, 'plan.json')); p.execution.apiKeyEnv = 'GITHUB_PAT'; writeJson(path.join(w.home, 'plan.json'), p)
    let read = false; const env = { get GITHUB_PAT() { read = true; return KEY } }
    const r = doctorEvaluation({ ...w, env, now: NOW }); assert.equal(r.status, 'blocked'); assert.equal(read, false)
  })
  await test('11 固定13格及raw/current工具与可见协议对齐，不接受偷改输出预算', () => {
    const p = buildMinimalPlan({ pricing: PRICING }), jobs = JSON.parse(JSON.stringify(p.jobs)); jobs[2].body.max_tokens--
    assert.throws(() => auditApiPlan({ ...p, jobs }), /api-matrix-protocol/)
    assert.throws(() => auditApiPlan({ ...p, limits: { ...p.limits, retries: 1 } }), /api-approval-changed/)
  })
  await test('12 RAW或计划带高置信密钥材料在保存/发请求前拒绝', () => {
    const p = buildMinimalPlan({ pricing: PRICING }), jobs = JSON.parse(JSON.stringify(p.jobs)); jobs[1].body.messages[1].content += ' sk-' + 'A'.repeat(32)
    assert.throws(() => auditApiPlan({ ...p, jobs }), /api-plan-secret-material/)
  })
  await test('13 不读取sourceHashes里塞入的任意路径；源码漂移只返回blocked', () => {
    const w = prepared(), p = readJson(path.join(w.home, 'plan.json')); p.sourceHashes['/protected-secret-that-must-not-be-read'] = 'a'.repeat(64); writeJson(path.join(w.home, 'plan.json'), p)
    assert.equal(doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: KEY }, now: NOW }).status, 'blocked')
  })
  await test('14 伪造/重复sample不算收益或完整12；完整配对不能由单边充数', () => {
    const p = buildMinimalPlan({ pricing: PRICING }), rows = p.jobs.filter((j) => j.kind === 'main').map((j) => ({ task: j.task, variant: j.variant, sample: j.sample, action: 'bash', rule: { falseDone: 0, bump: 0, reEdit: 0, repeat: 0, next: 1, avoid: 1 } }))
    assert.equal(summarizeMinimal(p, rows).complete, true)
    const r = summarizeMinimal(p, [...rows, rows[0]]); assert.equal(r.complete, false); assert.equal(r.pairedMainResponses, 10)
  })
  await test('15 HMAC仓身份稳定且不是私钥；新仓不同身份', () => {
    const w = fresh(), dir = path.join(w.dir, 'store'), a = createEvidenceStore({ directory: dir, sessionId: 'fixture' }), b = createEvidenceStore({ directory: dir, sessionId: 'fixture' })
    assert.match(a.authorityId, /^[a-f0-9]{64}$/); assert.equal(a.authorityId, b.authorityId)
    assert.notEqual(a.authorityId, createEvidenceStore({ directory: path.join(w.dir, 'other'), sessionId: 'fixture' }).authorityId)
    assert.notEqual(a.authorityId, fs.readFileSync(path.join(a.directory, 'authority.key')).toString('hex'))
  })
  await test('16 fetch前收据已显示pending/预占；不含canary/钥匙/请求正文', async () => {
    const w = prepared(); let n = 0
    const m = mock(w.plan, () => { n++; const marker = readWatermark(w.receiptPath); assert.equal(marker.requests, 1); assert.equal(marker.jobs[0].status, 'pending'); assert.ok(!JSON.stringify(marker).includes(w.plan.canary)); assert.ok(!JSON.stringify(marker).includes(KEY)); return payload(w.plan) })
    const b = client(w, m); await b.run('probe'); assert.equal(n, 1); assert.equal(readWatermark(w.receiptPath).jobs[0].status, 'accepted')
  })
  await test('17 跨轮私有树丢失：公开收据阻止重新初始化，fetch=0', async () => {
    const w = prepared(), m = mock(w.plan), b = client(w, m); await b.run('probe'); fs.rmSync(w.home, { recursive: true, force: true })
    const next = mock(w.plan); assert.throws(() => client(w, next), /api-budget-restore-required/); assert.equal(next.count(), 0); assert.equal(fs.existsSync(w.home), false)
    assert.equal(doctorEvaluation(w).checks[0].id, 'api-budget-restore-required')
  })
  await test('18 换data directory不恢复新额度', async () => {
    const w = prepared(), m = mock(w.plan), b = client(w, m); await b.run('probe')
    assert.throws(() => createBudgetedChat({ plan: w.plan, apiKey: KEY, directory: path.join(w.dir, 'new-ledger'), receiptPath: w.receiptPath, fetchImpl: m.fetchImpl }), /api-budget-restore-required/)
    assert.equal(m.count(), 1)
  })
  await test('19 私有签名key丢失不生成替代key把旧预算清零', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe')
    const key = path.join(apiStoreDirectory(path.join(w.home, 'ledger')), 'authority.key'); fs.unlinkSync(key)
    assert.throws(() => client(w, m), /api-budget-restore-required/); assert.equal(fs.existsSync(key), false); assert.equal(m.count(), 1)
  })
  await test('20 收据丢失而仓存在同样停止，不自动生成更旧收据', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe'); fs.unlinkSync(w.receiptPath)
    assert.throws(() => client(w, m), /api-budget-restore-required/); assert.equal(m.count(), 1)
  })
  await test('21 回滚已认证旧head也不能越过公开watermark', async () => {
    const w = prepared(), m = mock(w.plan), b = client(w, m), head = path.join(apiStoreDirectory(path.join(w.home, 'ledger')), '.head-api-budget.json'), old = fs.readFileSync(head)
    await b.run('probe'); fs.writeFileSync(head, old)
    assert.throws(() => client(w, m), /api-watermark-conflict/); assert.equal(m.count(), 1)
  })
  await test('22 已开始计划不能改价/改模型/变稿；prepare不能擦掉原plan', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe'); const before = fs.readFileSync(path.join(w.home, 'plan.json'))
    assert.throws(() => prepareEvaluation({ ...w, profile: { ...PROFILE, model: 'other' } }), /api-plan-changed/)
    assert.deepEqual(fs.readFileSync(path.join(w.home, 'plan.json')), before)
  })
  await test('23 provider的工具参数不是合法JSON，不缓存为有效样本', async () => {
    const w = prepared(), m = mock(w.plan, (_body, n) => n === 1 ? payload(w.plan) : payload(w.plan, { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: '固定响应', tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{broken' } }] } }] })), b = client(w, m)
    await b.run('probe'); await assert.rejects(b.run(w.plan.jobs[1].key), /response-tool-arguments/); assert.equal(b.cached(w.plan.jobs[1].key), null); assert.equal(m.count(), 2)
  })
  await test('24 密钥回显只留安全错误码，不留原正文/额外usage/vendor字段', async () => {
    const w = prepared(), m = mock(w.plan, () => payload(w.plan, { choices: [{ finish_reason: 'stop', message: { content: KEY, reasoning_content: '固定响应' } }] })), b = client(w, m)
    await assert.rejects(b.run('probe'), /response-secret-material/); assert.ok(!walkText(w.home).includes(KEY)); assert.equal(b.cached('probe'), null)
  })
  await test('25 成功缓存只保留定义好的message与两项usage字段', async () => {
    const w = prepared(), m = mock(w.plan, () => payload(w.plan, { usage: { prompt_tokens: 200, completion_tokens: 20, vendorDebug: 'ignored' } })), b = client(w, m)
    const r = await b.run('probe'); assert.deepEqual(Object.keys(r.usage).sort(), ['completion_tokens', 'prompt_tokens']); assert.equal(r.message.vendorDebug, undefined)
  })
  await test('26 超大响应按UTF-8字节拦，语义失败不重试', async () => {
    let n = 0; const chat = makeChat({ baseUrl: PROFILE.baseUrl, apiKey: KEY, maxResponseBytes: 10, fetchImpl: async () => { n++; return { ok: true, text: async () => '汉'.repeat(4) } } })
    await assert.rejects(chat({}), /response-byte-limit/); assert.equal(n, 1)
  })
  await test('27 流式读取早停/cancel，不能先下载全体超限响应', async () => {
    let cancelled = false, reads = 0
    const reader = { read: async () => { reads++; return { value: Buffer.alloc(20), done: false } }, cancel: async () => { cancelled = true }, releaseLock: () => {} }
    const chat = makeChat({ baseUrl: PROFILE.baseUrl, apiKey: KEY, maxRetries: 0, maxResponseBytes: 10, fetchImpl: async () => ({ ok: true, body: { getReader: () => reader }, headers: { get: () => null } }) })
    await assert.rejects(chat({}), /response-byte-limit/); assert.equal(reads, 1); assert.equal(cancelled, true)
  })
  await test('28 已探针后鉴权上下文变更不能跨池续跑，钥匙本身未保存', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe')
    await assert.rejects(client(w, m, { apiKey: 'different-fixture-key' }).run(w.plan.jobs[1].key), /api-auth-context-changed/); assert.equal(m.count(), 1)
    assert.ok(!walkText(w.home).includes(KEY))
    const d = doctorEvaluation({ ...w, env: { DEEPSEEK_API_KEY: 'different-fixture-key' }, now: NOW }); assert.equal(d.status, 'blocked')
  })
  await test('29 report不读钥匙不调用transport，单边不算配对', async () => {
    const w = prepared(), m = mock(w.plan), b = client(w, m); await b.run('probe'); await b.run(w.plan.jobs[1].key)
    const r = reportEvaluation(w); assert.equal(r.validMainResponses, 1); assert.equal(r.pairedMainResponses, 0); assert.equal(r.actualCostUsd, null); assert.equal(m.count(), 2)
  })
  await test('30 迁移必须加密且使用环境口令，包不包含可见canary/authority明文', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe')
    assert.throws(() => exportEvaluationBundle({ ...w, file: path.join(w.dir, 'bad'), passphrase: 'short' }), /passphrase-required/)
    const f = exportBundle(w); assert.ok(!fs.readFileSync(f).toString().includes(w.plan.canary)); assert.ok(!fs.readFileSync(f).toString().includes(KEY))
  })
  await test('31 错口令/篡改/截断包拒绝，目标不被创建', () => {
    const w = prepared(), f = exportBundle(w), target = path.join(w.dir, 'restored')
    assert.throws(() => importEvaluationBundle({ home: target, receiptPath: w.receiptPath, file: f, passphrase: 'wrong-fixture-passphrase' }), /eval-bundle-auth/)
    const corrupt = path.join(w.dir, 'corrupt.cfbstate'), b = fs.readFileSync(f); b[b.length - 1] ^= 1; fs.writeFileSync(corrupt, b)
    assert.throws(() => importEvaluationBundle({ home: target, receiptPath: w.receiptPath, file: corrupt, passphrase: PASS }), /eval-bundle-auth/)
    fs.writeFileSync(corrupt, Buffer.from('CFBSTATE1\n')); assert.throws(() => importEvaluationBundle({ home: target, receiptPath: w.receiptPath, file: corrupt, passphrase: PASS }), /eval-bundle-format/)
    assert.equal(fs.existsSync(target), false)
  })
  await test('32 不打包未知文件、凭据文件或symlink，不覆盖已有包', () => {
    const w = prepared(); fs.writeFileSync(path.join(w.home, 'credentials.txt'), 'fixture')
    assert.throws(() => exportBundle(w), /eval-bundle-unexpected-path/)
    fs.unlinkSync(path.join(w.home, 'credentials.txt')); const f = exportBundle(w)
    assert.throws(() => exportBundle(w), /EEXIST/)
    const link = path.join(w.home, 'link')
    if (canSymlink()) { fs.symlinkSync(f, link); assert.throws(() => exportBundle(w, 'new.cfbstate'), /eval-bundle-symlink/) }
    else console.log('  (跳过导出包 symlink 拒绝断言：当前平台无法创建符号链接)')
  })
  await test('33 旧合法checkpoint不越过较新公开watermark，不写旧预算', async () => {
    const w = prepared(), m = mock(w.plan), b = client(w, m), old = exportBundle(w, 'old.cfbstate')
    await b.run('probe'); const target = path.join(w.dir, 'old-restore')
    assert.throws(() => importEvaluationBundle({ home: target, receiptPath: w.receiptPath, file: old, passphrase: PASS }), /eval-bundle-stale-watermark/)
    assert.equal(fs.existsSync(target), false); assert.equal(m.count(), 1)
  })
  await test('34 新包恢复仓身份/计数/缓存，下一job只新增1次，探针不再发', async () => {
    const w = prepared(), m = mock(w.plan); await client(w, m).run('probe'); const f = exportBundle(w), target = path.join(w.dir, 'restored')
    const r = importEvaluationBundle({ home: target, receiptPath: w.receiptPath, file: f, passphrase: PASS }); assert.equal(r.requestsReserved, 1)
    const b = createBudgetedChat({ plan: w.plan, apiKey: KEY, directory: path.join(target, 'ledger'), receiptPath: w.receiptPath, fetchImpl: m.fetchImpl })
    assert.equal(b.cached('probe').model, w.plan.model); await b.run(w.plan.jobs[1].key); assert.equal(m.count(), 2)
  })
  await test('35 非空目标不覆盖；包文件/输出路径受保护与不入自身状态树', () => {
    const w = prepared(), f = exportBundle(w)
    assert.throws(() => importEvaluationBundle({ home: w.home, receiptPath: w.receiptPath, file: f, passphrase: PASS }), /eval-import-target-not-empty/)
    assert.throws(() => exportEvaluationBundle({ ...w, file: path.join(w.home, 'self.cfbstate'), passphrase: PASS }), /eval-bundle-output-inside-state/)
  })
  await test('36 run无明确live不能执行；缺key预检拒绝，不创建收据', async () => {
    const w = prepared(); await assert.rejects(runEvaluation({ ...w, env: {}, live: false }), /explicit-live-required/)
    await assert.rejects(runEvaluation({ ...w, env: {}, live: true, now: NOW }), /eval-preflight-blocked/)
    assert.equal(fs.existsSync(w.receiptPath), false)
  })
  await test('37 CLI帮助/拒绝明文参数不反射秘密，未触及任何供应商', async () => {
    const output = []; await readyMain(['--help'], { env: { DEEPSEEK_API_KEY: KEY }, output: (v) => output.push(v) })
    assert.ok(!output.join('').includes(KEY)); await assert.rejects(readyMain(['prepare', '--api-key', KEY], { env: {}, output: () => {} }), (e) => e.message === 'eval-option')
  })
  await test('39 自动checkpoint在fetch前已有pending，回复后已有accepted；丢仓可直接恢复', async () => {
    const w = prepared(), file = path.join(w.dir, 'auto.cfbstate')
    let sawPending = false
    const m = mock(w.plan, () => {
      const home = path.join(w.dir, 'pending-copy'), receiptPath = path.join(w.dir, 'pending-copy.json')
      const restored = importEvaluationBundle({ home, receiptPath, file, passphrase: PASS })
      assert.equal(restored.requestsReserved, 1)
      const view = inspectApiBudget({ plan: w.plan, directory: path.join(home, 'ledger'), receiptPath }).snapshot()
      assert.equal(view.entries[0].status, 'pending'); sawPending = true
      return payload(w.plan)
    })
    const r = await executePreparedEvaluation({ ...w, apiKey: KEY, fetchImpl: m.fetchImpl, checkpointFile: file, passphrase: PASS, stopAfter: 1 })
    assert.equal(r.requestsReserved, 1); assert.equal(m.count(), 1); assert.equal(sawPending, true)
    fs.rmSync(w.home, { recursive: true, force: true })
    importEvaluationBundle({ ...w, file, passphrase: PASS })
    assert.equal(inspectApiBudget({ plan: w.plan, directory: path.join(w.home, 'ledger'), receiptPath: w.receiptPath }).snapshot().entries[0].status, 'accepted')
  })
  await test('40 已认证回复后的备份故障不能降成provider失败或擦掉缓存', async () => {
    const w = prepared(), m = mock(w.plan)
    const b = client(w, m, { onStateCommitted: () => { if (readWatermark(w.receiptPath).jobs[0]?.status === 'accepted') throw new Error('fixture-backup-error') } })
    await assert.rejects(b.run('probe'), /api-checkpoint-write-failed/)
    assert.equal(m.count(), 1); assert.equal(b.cached('probe').model, w.plan.model); assert.equal(b.snapshot().halted, null)
  })
  await test('41 状态hook必须同步落盘，不忽略Promise后抢先发请求', () => {
    const w = prepared(), m = mock(w.plan)
    assert.throws(() => client(w, m, { onStateCommitted: async () => {} }), /api-async-state-hook/)
    assert.equal(m.count(), 0)
  })
  await test('42 尚未定价也可report/加密搬迁；不造免费价或初始化预算', () => {
    const w = prepared({ profile: { ...PROFILE, pricing: null } })
    const r = reportEvaluation(w); assert.equal(r.validMainResponses, 0); assert.equal(r.requestsReserved, 0); assert.equal(r.actualCostUsd, null)
    const f = exportBundle(w), home = path.join(w.dir, 'unpriced-copy'), receiptPath = path.join(w.dir, 'copy.json')
    const imported = importEvaluationBundle({ home, receiptPath, file: f, passphrase: PASS }); assert.equal(imported.requestsReserved, 0)
    assert.equal(loadPrepared(home).pricing, null); assert.equal(fs.existsSync(receiptPath), false)
    assert.throws(() => auditApiPlan(loadPrepared(home)), /api-pricing-required/)
  })
  await test('43 并发/遗留备份锁不覆盖新包、不自动抢锁，输出文件保持不变', () => {
    const w = prepared(), file = exportBundle(w), before = fs.readFileSync(file), lock = file + '.lock'
    fs.writeFileSync(lock, '')
    assert.throws(() => exportEvaluationBundle({ ...w, file, passphrase: PASS, replace: true }), /eval-checkpoint-busy/)
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(lock), true)
  })
  await test('38 整链本机HTTP：13请求、第5请求断点/丢仓/加密恢复、9故障无重发', async () => {
    // simulateReadyEvaluation 先断言「只有 loopback 的 Linux 网络命名空间」（证据来自 /proc/net/route）。
    // 拿不到该证据就显式跳过（**含联网的 Linux** —— v14.25.1 起判据与 assertOfflineNamespace 同源，
    // 不再出现「联网 Linux 上必红一项」），且跳过不计通过：全量验收仍是 `npm run verify:offline`。
    if (!offlineNamespaceVerifiable()) { console.log('  (跳过整链本机HTTP：需要「只有 lo、零外部路由」的隔离证据；请在 `npm run verify:offline` 内跑，当前平台 ' + process.platform + ')'); return 'skip' }
    const r = await simulateReadyEvaluation(); assert.equal(r.externalApiCalls, 0); assert.equal(r.paidCostUsd, 0)
    assert.equal(r.healthy.loopbackRequests, 13); assert.equal(r.healthy.restoredRequests, 5); assert.equal(r.healthy.repeatRequests, 0)
    assert.equal(r.faults.length, 9); assert.ok(r.faults.every((f) => f.extraRequestsOnResume === 0))
  })
} finally { fs.rmSync(ROOT, { recursive: true, force: true }) }
console.log(`\n合计: ${pass} 通过 / ${fail} 失败` + (skip ? ` / 跳过 ${skip}` : '') + `\nSKIP=${skip}`)
if (fail) process.exitCode = 1
