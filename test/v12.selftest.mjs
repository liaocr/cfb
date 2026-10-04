// v12 自测：退役配置的兼容性 —— 旧配置不抛、不静默（retiredOptions / retiredMode / configAdjusted 可见）。
//   v12.0：compress-x1（抽取式）退役
//   v12.1：checkpoint 模式、迟到认领（deferred claim / late-memory）、memory 模式（状态记忆）、legacy v1 提示词退役
//   （v12.0 的 ② src/value.js 理论不变量随 value.js 删除一并移除；源码存于 docs/theory/CFB-THEORY-COMPLETE.md 附录 B）
import { normalizeConfig, compressPromptVersion, DEFAULTS } from '../index.js'
import { bootRecord } from '../src/boot-record.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (note !== undefined ? '  ' + note : '')) } }

// ── ① x1 退役（v12.0；v12.1 起回落目标改为缺省 v3）─────────────────────────
{
  const c = normalizeConfig({ compressPrompt: 'x1', extractiveTailChars: 400, extractiveGuideline: 'g' })
  ok('x1 ⇒ compressPrompt 回到缺省 v3', c.compressPrompt === 'v3', c.compressPrompt)
  ok('x1 ⇒ configAdjusted 留痕', c.configAdjusted && c.configAdjusted.compressPrompt && c.configAdjusted.compressPrompt.from === 'x1')
  ok('extractive* 键进 retiredOptions', c.retiredOptions.includes('extractiveTailChars') && c.retiredOptions.includes('extractiveGuideline'))
  ok('extractive* 键从生效配置删除', !('extractiveTailChars' in c) && !('extractiveGuideline' in c))
  ok('extractive* 键不误报为 unknownOptions', !(c.unknownOptions || []).some((k) => k.startsWith('extractive')), JSON.stringify(c.unknownOptions))
  ok('promptVersion 为 compress-v3', compressPromptVersion(c) === 'compress-v3h:250-450', compressPromptVersion(c))
  const d = normalizeConfig({})
  ok('缺省配置不含 extractive* 键', !Object.keys(d).some((k) => k.startsWith('extractive')))
}

// ── ② v1（legacy 蒸馏）退役 ⇒ v3 ──────────────────────────────────────────
{
  const c = normalizeConfig({ compressPrompt: 'v1' })
  ok('v1 ⇒ v3', c.compressPrompt === 'v3', c.compressPrompt)
  ok('v1 ⇒ configAdjusted 留痕', c.configAdjusted?.compressPrompt?.from === 'v1' && /v12\.1/.test(c.configAdjusted.compressPrompt.why), JSON.stringify(c.configAdjusted))
  ok('不认识的值同样回落 v3 并留痕', normalizeConfig({ compressPrompt: 'v9' }).configAdjusted?.compressPrompt?.to === 'v3')
  ok('v2 显式保留', normalizeConfig({ compressPrompt: 'v2' }).compressPrompt === 'v2')
  ok('缺省 compressPrompt = v3', DEFAULTS.compressPrompt === 'v3' && normalizeConfig({}).configAdjusted === undefined)
}

// ── ③ checkpoint 模式退役 ⇒ off ───────────────────────────────────────────
{
  const c = normalizeConfig({ mode: 'checkpoint', earlyFire: true, graceMs: 300, minRawChars: 800, keepTail: 2 })
  ok('checkpoint ⇒ mode off', c.mode === 'off', c.mode)
  ok('checkpoint ⇒ retiredMode 留痕', c.retiredMode === 'checkpoint', c.retiredMode)
  for (const k of ['earlyFire', 'graceMs', 'minRawChars', 'keepTail']) ok(k + ' 进 retiredOptions 且删除', c.retiredOptions.includes(k) && !(k in c))
  ok('checkpoint 专属键不误报 unknown', !(c.unknownOptions || []).length, JSON.stringify(c.unknownOptions))
  const n = normalizeConfig({ distill: { minRawChars: 900, graceMs: 100, timeoutMs: 9000 } })
  ok('嵌套 distill.minRawChars / graceMs 不误报 unknown', !(n.unknownOptions || []).length, JSON.stringify(n.unknownOptions))
  ok('嵌套 distill.timeoutMs 仍生效', n.timeoutMs === 9000)
}

// ── ④ memory 模式 / 迟到认领退役 ⇒ compress ────────────────────────────────
{
  const c = normalizeConfig({ stateMemory: true, stateCompress: true, birthDeferredClaim: true, lateClaimPartial: true, stateEvidenceLimit: 60, emitterMinSavingsChars: 100 })
  for (const k of ['stateMemory', 'stateCompress', 'birthDeferredClaim', 'lateClaimPartial', 'stateEvidenceLimit', 'emitterMinSavingsChars']) {
    ok(k + ' 进 retiredOptions 且删除', c.retiredOptions.includes(k) && !(k in c))
  }
  ok('stateMemory:true ⇒ configAdjusted 写明现在跑 compress', c.configAdjusted?.stateMemory?.to === 'compress')
  ok('stateMemory:false 不留 configAdjusted', normalizeConfig({ stateMemory: false }).configAdjusted === undefined)
  ok('无 compileMode 派生字段', !('compileMode' in c) && !('compileModeConflict' in c))
  ok('birthDeferredClaim:true 不再阻止 timeoutMs 抬高', c.timeoutMs >= c.birthFinishWaitMs + c.finishHeadersGraceMs + 2000, String(c.timeoutMs))
}

// ── ⑤ BOOT：单一路径 ────────────────────────────────────────────────────
{
  const b = bootRecord(normalizeConfig({}), { selfId: 's', deps: 'd' })
  ok('BOOT compilerMode = compress-v3', b.compilerMode === 'compress-v3h:250-450', b.compilerMode)
  ok('BOOT 无 memory / checkpoint 字段', !('stateMemory' in b) && !('compileMode' in b) && !('keepTail' in b) && !('earlyFire' in b))
  ok('BOOT 报告 identifierGate', b.birth && b.birth.identifierGate === true, JSON.stringify(b.birth))
  ok('DEFAULTS 不含退役键', !['stateMemory', 'stateCompress', 'birthDeferredClaim', 'earlyFire', 'keepTail', 'minRawChars'].some((k) => k in DEFAULTS))
}

// v14.10：台账整句正则改成「分段预筛 + 原正则」—— 必须与 text.matchAll(原正则) 逐字相同（含边界：空串、只有终止符、无终止符长句、\n 结尾、连续终止符）
{
  const { __ledgerInternals: L } = await import('../src/messages.js')
  const texts = ['不选 A。验收：跑 npm test！未解\n对不上？排除：x\n\n搁置。。！', '验收', '。', '', '\n\n', 'x'.repeat(3000) + '预期' + 'y'.repeat(2000) + '。' + 'z'.repeat(1000), '改完后预期 ok\n不动它\n', '已排除 a。已排除 b。c 搁置', '排除:1 排除：2！', 'no keyword here\n' + 'w'.repeat(4000)]
  let same = 0, total = 0
  for (const t of texts) for (const [re, kw] of [[L.LEDGER_ACCEPT_RE, L.LEDGER_ACCEPT_KW], [L.LEDGER_OPEN_RE, L.LEDGER_OPEN_KW], [L.LEDGER_REJECT_RE, L.LEDGER_REJECT_KW]]) {
    total++; const a = [...t.matchAll(re)].map((m) => m[0]), b = [...L.sentenceMatches(t, re, kw)].map((m) => m[0]); if (JSON.stringify(a) === JSON.stringify(b)) same++
  }
  ok('台账分段匹配与原正则逐字等价', same === total, same + '/' + total)
  const t0 = Date.now(); for (const m of L.sentenceMatches('q'.repeat(20000) + '\n', L.LEDGER_REJECT_RE, L.LEDGER_REJECT_KW)) void m
  ok('无关键词的 2 万字长段线性时间（< 50ms）', Date.now() - t0 < 50, Date.now() - t0 + 'ms')
}

console.log('v12 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)
