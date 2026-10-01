// v8 前提更正后的 reasoning 回放协议 + claimOfV3 判据：全部离线，零网络。
// 背景（2026-10-01）：v3–v7 的「可见协议」建立在『a6api 全部路由丢弃历史 reasoning』之上；
// 该结论被证明是聚合站内**故障商户**造成的假象。v8 回到 v1 的 chat-completions-history-reasoning/1。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditApiPlan, planScope, planVersion } from '../tools/helpers/api-budget.mjs'
import { API_APPROVAL_SCOPE_V8, KNOWN_API_SCOPES } from '../tools/helpers/api-watermark.mjs'
import { buildReasoningReplayPlanV8, buildExpandedPlanV7, resultOf, currentSourceHashes } from '../tools/helpers/eval-plan.mjs'
import { claimOf, claimOfV2, claimOfV3, ruleMetrics } from '../tools/effect-mr.mjs'
import { channelIssue } from '../tools/effect-eval.mjs'
import { normalizeProfile, prepareEvaluation } from '../tools/helpers/eval-workflow.mjs'

let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1, requestFeeUsd: 0, source: 'https://prices.vendor.test/rates', verifiedAt: '2026-10-01' }
const TASKS = ['flaky-timeout', 'wrong-model', 'eacces-config']

// v7 报告的 5 例伪阳性（逐字取自 docs/analysis/LIVE-EXPANDED-2026-10-01.md §3）
const FALSE_POSITIVES = [
  ['flaky|current|2', '插桩点选在 primary 完成回调时刻，先确认这条链路的时序再决定改哪里。'],
  ['flaky|raw|5', '先取证，再以设计修复为目标，本轮先把最小复现跑出来。'],
  ['wrong-model|current|0', '即使 observe 修好，仍复用旧编译产物，所以现在还不能下结论。'],
  ['wrong-model|raw|3', '即使 lastModel 修好了，仍会命中旧缓存，需要再看调用点。'],
  ['wrong-model|current|4', '修复落地了，但只是次要因素：新出现的失败在别处。'],
]
const TRUE_POSITIVES = ['问题已修复，eacces 分支现在走对了。', 'The bug is fixed and resolved.', '这个错误已经解决了。', '搞定了，可以收工。', '改动完成了。']
const TRUE_NEGATIVES = ['还没有修复这个分支。', '我无法确认这是不是修复。', '主请求完成 → primarySettled 置位。']

try {
  test('01 claimOfV3：v7 五例伪阳性全部不再判 fixed（claimOfV2 全部误判）', () => {
    for (const [id, text] of FALSE_POSITIVES) {
      assert.equal(claimOfV2(text), 'fixed', 'v2 应当误判 ' + id)
      assert.notEqual(claimOfV3(text), 'fixed', 'v3 必须拒绝 ' + id)
    }
  })
  test('02 claimOfV3：真阳性全部保留 fixed；真阴性保持非 fixed', () => {
    for (const t of TRUE_POSITIVES) assert.equal(claimOfV3(t), 'fixed', '真阳性丢失: ' + t)
    for (const t of TRUE_NEGATIVES) assert.notEqual(claimOfV3(t), 'fixed', '真阴性误判: ' + t)
  })
  test('03 claimOfV3：三类守卫各自独立生效（让步/意图/拉丁前缀）', () => {
    assert.notEqual(claimOfV3('即使它修好了，仍会失败。'), 'fixed')      // 让步
    assert.notEqual(claimOfV3('我先设计修复方案，还没动手。'), 'fixed')   // 意图
    assert.notEqual(claimOfV3('主请求完成回调时刻。'), 'fixed')          // 拉丁前缀+完成名词
  })
  test('04 claimOfV3 不比 claimOf 更宽松：旧真阳性集不退化', () => {
    // claimOf 判 fixed 的句子，claimOfV3 不得把它降级为 none/hedged（除非命中守卫）
    const plain = ['已修复', '问题已经解决', 'resolved', 'fixed']
    for (const t of plain) assert.equal(claimOfV3(t), 'fixed', t)
  })
  test('05 v8 计划形状：schema/版本/scope/protocol/矩阵计数', () => {
    const plan = buildReasoningReplayPlanV8({ pricing: PRICING })
    assert.equal(plan.schema, 'cfb.bounded-ab/8')
    assert.equal(planVersion(plan), 8)
    assert.equal(planScope(plan), API_APPROVAL_SCOPE_V8)
    assert.equal(plan.protocol, 'chat-completions-history-reasoning/1')
    assert.equal(plan.preregistration.claimVersion, 3)
    assert.equal(plan.jobs.length, 15)
    assert.equal(plan.jobs.filter((j) => j.kind === 'probe').length, 3)
    assert.equal(plan.jobs.filter((j) => j.kind === 'main').length, 12)
    assert.deepEqual(plan.jobs.filter((j) => j.kind === 'probe').map((j) => j.key), ['probe', 'probe-r1', 'probe-r2'])
    assert.equal(KNOWN_API_SCOPES.includes(API_APPROVAL_SCOPE_V8), true)
  })
  test('06 v8 关键不变量：raw臂=原文 reasoning，current臂=冻结压缩稿，双臂除 reasoning 外逐字节相同', () => {
    const plan = buildReasoningReplayPlanV8({ pricing: PRICING })
    const strip = (b) => JSON.stringify({ ...b, messages: b.messages.map(({ reasoning_content, ...m }) => m) })
    for (const task of TASKS) {
      const v = plan.variants[task]
      for (const sample of [0, 1]) {
        const raw = plan.jobs.find((j) => j.key === `${task}|raw|${sample}`)
        const cur = plan.jobs.find((j) => j.key === `${task}|current|${sample}`)
        const rawRc = raw.body.messages.filter((m) => m.reasoning_content).map((m) => m.reasoning_content)
        const curRc = cur.body.messages.filter((m) => m.reasoning_content).map((m) => m.reasoning_content)
        assert.deepEqual(curRc, [v.r1, v.r2], 'current 必须是冻结稿')
        assert.equal(rawRc[0].length, v.raw1Chars, 'raw1 必须等于原文长度')
        assert.equal(rawRc[1].length, v.raw2Chars, 'raw2 必须等于原文长度')
        assert.equal(strip(raw.body), strip(cur.body), '双臂除 reasoning 外必须逐字节相同')
        assert.ok(curRc[0].length < rawRc[0].length, '压缩稿应短于原文')
      }
    }
  })
  test('07 v8 审计通过；可见协议闸不误伤 v8（reasoning 回放口径）', () => {
    const plan = buildReasoningReplayPlanV8({ pricing: PRICING })
    const audit = auditApiPlan(plan)
    assert.equal(audit.main, 12); assert.equal(audit.probe, 3)
    assert.ok(audit.totalReservedUsd <= 2)
  })
  test('08 v8 与 v7 是不同 scope；v7 仍按其冻结形态成立（不追溯）', () => {
    const v8 = buildReasoningReplayPlanV8({ pricing: PRICING })
    const v7 = buildExpandedPlanV7({ pricing: PRICING })
    assert.notEqual(planScope(v8), planScope(v7))
    assert.equal(planVersion(v7), 7)
    assert.equal(v7.protocol, 'chat-completions-visible-context/1')
    assert.ok(v7.jobs.every((j) => j.body.messages.every((m) => m.reasoning_content === undefined)), 'v7 仍零 reasoning')
  })
  test('09 resultOf 判据按 scope 冻结：v8→claimOfV3，v7→claimOfV2，互不追溯', () => {
    const v8 = buildReasoningReplayPlanV8({ pricing: PRICING })
    const v7 = buildExpandedPlanV7({ pricing: PRICING })
    const job8 = v8.jobs.find((j) => j.kind === 'main')
    const job7 = v7.jobs.find((j) => j.kind === 'main')
    const fp = FALSE_POSITIVES[2][1]   // 让步句：v2 判 fixed，v3 拒
    const r8 = resultOf(v8, job8, { message: { content: fp } })
    const r7 = resultOf(v7, job7, { message: { content: fp } })
    assert.equal(r8.rule.falseDone, 0, 'v8 用 claimOfV3，让步句不算假完成')
    assert.equal(r7.rule.falseDone, 1, 'v7 用 claimOfV2，按当时判据如实记录')
  })
  test('10 型号回显别名：显式声明才接受；未声明/近似但不同/完全不同的型号一律拒绝', () => {
    const resp = (model) => ({ model, usage: { prompt_tokens: 10, completion_tokens: 1 }, fp: null, message: { content: 'x', reasoning_content: 'y' } })
    const seen = (model, expected, aliases) => channelIssue(resp(model), expected, { requireFp: false, modelAliases: aliases })
    // 精确相等永远接受
    assert.equal(seen('deepseek-v4.1-flash', 'deepseek-v4.1-flash', []), null)
    // 声明的别名接受（a6api 实测：请求点号、回显连字符）
    assert.equal(seen('deepseek-v4-1-flash', 'deepseek-v4.1-flash', ['deepseek-v4-1-flash']), null)
    // 未声明 → 拒
    assert.equal(seen('deepseek-v4-1-flash', 'deepseek-v4.1-flash', []), 'channel-model-mismatch')
    // 别名"像"但型号真的不同 → 拒（别名不能放行真型号不符）
    assert.equal(seen('deepseek-v4-2-flash', 'deepseek-v4.1-flash', ['deepseek-v4-2-flash']), 'channel-model-mismatch')
    // 完全不同 → 拒
    assert.equal(seen('gpt-5.4', 'deepseek-v4.1-flash', ['gpt-5.4']), 'channel-model-mismatch')
    // 缺 model → 拒
    assert.equal(seen(undefined, 'deepseek-v4.1-flash', ['deepseek-v4-1-flash']), 'channel-model-mismatch')
  })
  test('11 profile 别名必须规范化后等于本型号；通配/异型号/超量一律拒绝', () => {
    const base = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    assert.deepEqual(normalizeProfile(base).modelAliases, [])
    assert.deepEqual(normalizeProfile({ ...base, modelAliases: ['deepseek-v4-1-flash'] }).modelAliases, ['deepseek-v4-1-flash'])
    assert.throws(() => normalizeProfile({ ...base, modelAliases: ['deepseek-v4-2-flash'] }), /profile-model-aliases/)
    assert.throws(() => normalizeProfile({ ...base, modelAliases: ['*'] }), /profile-model-aliases/)
    assert.throws(() => normalizeProfile({ ...base, modelAliases: [''] }), /profile-model-aliases/)
    assert.throws(() => normalizeProfile({ ...base, modelAliases: Array(9).fill('deepseek-v4-1-flash') }), /profile-model-aliases/)
  })
  test('12 v8 计划已冻结 source 哈希（可检测源漂移）', () => {
    const plan = buildReasoningReplayPlanV8({ pricing: PRICING })
    const cur = currentSourceHashes()
    for (const p of ['tools/effect-mr.mjs', 'tools/helpers/eval-plan.mjs', 'tools/helpers/api-budget.mjs']) {
      assert.equal(plan.sourceHashes[p], cur[p], p + ' 应当被冻结')
    }
  })
  test('13 prepareEvaluation 按 version 选 builder：8→/8（15作业）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v8-'))
    const profile = { schema: 'cfb.eval-profile/1', model: 'deepseek-v4.1-flash', baseUrl: 'https://gateway.vendor.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', pricing: PRICING }
    try {
      prepareEvaluation({ home: path.join(tmp, 'v8'), receiptPath: path.join(tmp, 'v8.json'), profile, version: 8 })
      const p8 = JSON.parse(fs.readFileSync(path.join(tmp, 'v8', 'plan.json'), 'utf8'))
      assert.equal(p8.schema, 'cfb.bounded-ab/8')
      assert.equal(p8.jobs.length, 15)
      assert.equal(p8.limits.maxProbe, 3)
      assert.equal(p8.limits.maxRequests, 15)
      prepareEvaluation({ home: path.join(tmp, 'v1'), receiptPath: path.join(tmp, 'v1.json'), profile, version: 1 })
      const p1 = JSON.parse(fs.readFileSync(path.join(tmp, 'v1', 'plan.json'), 'utf8'))
      assert.equal(p1.schema, 'cfb.bounded-ab/1')
      assert.notEqual(p1.limits.maxRequests, 15)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  test('14 每个 --vN 旗标必须同时出现在 home 链与 version 链（回归：--v8 曾两处都漏）', () => {
    const src = fs.readFileSync(new URL('../tools/effect-ready.mjs', import.meta.url), 'utf8')
    const lines = src.split('\n')
    const homeLine = lines.find((l) => l.includes('DEFAULT_HOME_V') && l.includes('o.home ='))
    const versionLine = lines.find((l) => l.includes('version: o.'))
    assert.ok(homeLine, '未找到 home 选择链')
    assert.ok(versionLine, '未找到 version 选择链')
    const flags = [...new Set((src.match(/o\.v\d+/g) || []))].sort()
    assert.ok(flags.includes('o.v8'), '缺少 --v8 旗标')
    for (const f of flags) {
      const n = f.slice(3)
      assert.ok(homeLine.includes(f + ' ?') || homeLine.includes('DEFAULT_HOME_V' + n), f + ' 未出现在 home 链')
      assert.ok(versionLine.includes(f + ' ?') || versionLine.includes(': ' + n), f + ' 未出现在 version 链')
    }
  })
} finally {
  console.log(`\n=== claimOfV3/v8 selftest: ${pass} pass / ${fail} fail ===`)
  process.exitCode = fail ? 1 : 0
}
