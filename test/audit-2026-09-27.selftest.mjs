// ★★ 2026-09-27 外部审计回归钉（audit/fixes-2026-09-27）★★
//
// 每一条都对应一个**先复现、后修复**的缺陷（复现脚本见审计报告 docs/analysis/AUDIT-2026-09-27.md）：
//   A. birth：收网 / 起火抛内部异常 ⇒ 原文放行（此前：block-end 被吞 / 主流被打断，违反不变式③与宿主 invariant.js:53）
//   B. birth：原样放行必须是**原对象**放行（此前：放行也重建 block-end，用 delta 累积值覆盖宿主 block.text）
//   C. provider：providers: 段必须锚定在 llm-pi-ai: 之下（此前：取文件里第一个 providers:，端点/钥匙名可能解析到别的插件的表）
//   D. provider：行内注释 / 引号键名 / 引号值（此前：注释进 baseURL ⇒ 请求路径变成 /v1%20%20）
//   E. provider：凭据正则不得跨行（此前：\s* 跨过换行，把下一行的键名当钥匙）
//   F. （v12.0 删除：随 compress-x1 退役，原 hardIdentifiers 线性化回归钉见 cfba57b）
//   G. distill：在途共享 identity 不再以明文钥匙 + 全文 prompt 作 Map 键
//   H. trace：makeTraceWriter 序列化失败（statsOf 抛 / BigInt）只丢这一条，不再向调用方抛
//   I. 阶段 0 观测（DECISION-2026-09-27 §5）：below-floor 留痕 birth-below-floor；tools/phase0-report.mjs 纯函数
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-audit-0927-'))
process.env.DSH_HOME = home

let pass = 0, fail = 0
function ok(name, cond, note) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.error('FAIL ' + name + (note !== undefined ? '  [' + String(note).slice(0, 300) + ']' : '')) }
}
const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }
const BIG = 'x'.repeat(4000)
const mkSrc = (blockText = BIG, endBlock) => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: blockText }
  yield { type: 'block-end', index: 0, block: endBlock || { type: 'reasoning', text: blockText } }
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: 'hi' }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: 'hi' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()
const baseCfg = { enabled: true, mode: 'birth', dryRun: false, birthMinChars: 100, birthFinishWaitMs: 300, finishHeadersGraceMs: 0, stateCompress: true, compileMode: 'compress' }
const baseDeps = { cfg: baseCfg, sessionId: 's1', archive: async () => 'art://abcdefghijklmnopqrstuv', distill: async () => ({ text: 'summary' }) }
const invariantHolds = (out) => {
  // 与 dsh-llm invariant.js:53 同判据：finish 之前每个 block-start 都有 block-end；finish 最后
  const open = new Set()
  for (const c of out) { if (c.type === 'block-start') open.add(c.index); if (c.type === 'block-end') open.delete(c.index) }
  return open.size === 0 && out[out.length - 1].type === 'finish'
}

// ═══ A. 内部异常 ⇒ 原文放行 ═══════════════════════════════════════════════
{
  // A1 trace 在 finish 阶段抛（JSON.stringify 遇 BigInt / statsOf 抛错都是这个形态）
  for (const badTag of ['birth-finish-enter', 'birth-condensed', 'birth-handle-source']) {
    const out = await collect(I.birthTransform(mkSrc(), { ...baseDeps, trace: (t) => { if (t === badTag) throw new Error('boom') } }))
    const be0 = out.find((c) => c.type === 'block-end' && c.index === 0)
    ok('A1 trace 在 ' + badTag + ' 抛 ⇒ block-end#0 仍出站且不变式成立', !!be0 && invariantHolds(out), out.map((c) => c.type).join(' '))
  }
  // A2a trace 在 block-end 起火阶段同步抛 ⇒ 主流不得被打断（safeTrace 吞掉 trace 自身的错，起火照常）
  let threw = null, out = []
  try { out = await collect(I.birthTransform(mkSrc(), { ...baseDeps, trace: (t) => { if (t === 'birth-fired') throw new Error('boom') } })) } catch (e) { threw = e }
  ok('A2a trace 在 birth-fired 同步抛 ⇒ 主流存活、不变式成立（修复前：主流被打断）', threw === null && invariantHolds(out), threw ? threw.message : out.map((c) => c.type).join(' '))
  // A2b birthStart 自身（trace 之外）同步抛 ⇒ 原 chunk 放行 + 留痕 birth-start-error
  const tagsB = []
  const cfgTrapB = new Proxy(baseCfg, { get(t, k) { if (k === 'birthArchiveTimeoutMs') throw new Error('start-stage boom'); return t[k] } })
  let threwB = null, outB = []
  try { outB = await collect(I.birthTransform(mkSrc(), { ...baseDeps, cfg: cfgTrapB, trace: (t) => tagsB.push(t) })) } catch (e) { threwB = e }
  const beB = outB.find((c) => c.type === 'block-end' && c.index === 0)
  ok('A2b birthStart 同步抛 ⇒ 主流存活、原 chunk 放行、留痕 birth-start-error', threwB === null && invariantHolds(outB) && beB && beB.block.text === BIG && tagsB.includes('birth-start-error'), threwB ? threwB.message : outB.map((c) => c.type).join(' ') + ' / ' + tagsB.join(','))
  // A3 birthFinish 在 trace 之外抛（cfg 读取即抛）⇒ 走 flushTask：原文放行 + 取消在飞
  let cancelled = false
  const cfgTrap = new Proxy(baseCfg, { get(t, k) { if (k === 'birthFinishWaitMs') throw new Error('finish-stage boom'); return t[k] } })
  const tags = []
  const out3 = await collect(I.birthTransform(mkSrc(), {
    ...baseDeps, cfg: cfgTrap, trace: (t) => tags.push(t),
    distill: (_, sig) => new Promise((_, rej) => sig.addEventListener('abort', () => { cancelled = true; rej(new Error('cancelled')) })),
  }))
  const be3 = out3.find((c) => c.type === 'block-end' && c.index === 0)
  ok('A3 birthFinish 抛 ⇒ 原文放行 + 不变式成立', !!be3 && be3.block.text === BIG && invariantHolds(out3), out3.map((c) => c.type).join(' '))
  ok('A3 birthFinish 抛 ⇒ 在飞提纯被取消（不变式⑨）且留痕 birth-settle-error / birth-flush', cancelled && tags.includes('birth-settle-error') && tags.includes('birth-flush'), tags.join(','))
}

// ═══ B. 原样放行 = 原对象放行 ══════════════════════════════════════════════
{
  // B1 below-floor：宿主 block.text 与 delta 累积不同（末尾换行 + signature）⇒ 必须原封不动
  const endBlock = { type: 'reasoning', text: 'short thought\n', signature: 'sig-abc' }
  const src = mkSrc('short thought', endBlock)
  const out = await collect(I.birthTransform(src, { ...baseDeps, cfg: { ...baseCfg, birthMinChars: 3100 }, trace: () => {} }))
  const be = out.find((c) => c.type === 'block-end' && c.index === 0)
  ok('B1 below-floor 放行 ⇒ block 对象逐字等于宿主原对象（含 signature、末尾换行）', be && be.block === endBlock, JSON.stringify(be && be.block))
  // B2 蒸馏失败放行：同样原对象
  const src2 = mkSrc(BIG, { type: 'reasoning', text: BIG, signature: 'sig-2' })
  const out2 = await collect(I.birthTransform(src2, { ...baseDeps, trace: () => {}, distill: async () => { throw new Error('nope') } }))
  const be2 = out2.find((c) => c.type === 'block-end' && c.index === 0)
  ok('B2 distill-failed 放行 ⇒ block 对象是宿主原对象', be2 && be2.block.signature === 'sig-2' && be2.block.text === BIG)
  // B3 替换成功时仍然重建（这是唯一允许改写的路径）
  const out3 = await collect(I.birthTransform(mkSrc(), { ...baseDeps, trace: () => {} }))
  const be3 = out3.find((c) => c.type === 'block-end' && c.index === 0)
  ok('B3 condensed ⇒ block.text = 摘要（改写路径不受影响）', be3 && be3.block.text === 'summary')
}

// ═══ C/D. provider 表解析 ═════════════════════════════════════════════════
{
  const f = (name, text) => { const p = path.join(home, name); fs.writeFileSync(p, text); return p }
  const s1 = f('s1.yaml', [
    'some-other-plugin:', '  providers:', '    open:', '      baseURL: https://evil.example.com/v1', '      apiKeyEnv: EVIL_KEY',
    'llm-pi-ai:', '  providers:', '    open:', '      baseURL: https://api.deepseek.com/v1', '      apiKeyEnv: DEEPSEEK_API_KEY', '      api: openai-completions', '',
  ].join('\n'))
  const spec = I.readProviderSpec(s1, 'open')
  ok('C1 前置的别家 providers: 段不得命中 ⇒ 解析到 llm-pi-ai 那一段', spec && spec.baseURL === 'https://api.deepseek.com/v1' && spec.apiKeyEnv === 'DEEPSEEK_API_KEY', JSON.stringify(spec))
  const s2 = f('s2.yaml', ['other:', '  providers:', '    open:', '      baseURL: https://evil/v1', ''].join('\n'))
  ok('C2 没有 llm-pi-ai 段 ⇒ null（不猜）', I.readProviderSpec(s2, 'open') === null)
  const s3 = f('s3.yaml', 'llm-pi-ai:\r\n  # 表\r\n  providers:\r\n    \'open\':\r\n      api: openai-completions\r\n      baseURL: "https://api.deepseek.com/v1" # 主商户\r\n      apiKeyEnv: DEEPSEEK_API_KEY   # 钥匙\r\n    other:\r\n      baseURL: https://o.example/v1 # x\r\nafter:\r\n  providers:\r\n    open:\r\n      baseURL: https://also-wrong/v1\r\n')
  const spec3 = I.readProviderSpec(s3, 'open')
  ok('D1 CRLF + 引号键名 + 引号值 + 行内注释 ⇒ 全部剥干净', spec3 && spec3.baseURL === 'https://api.deepseek.com/v1' && spec3.apiKeyEnv === 'DEEPSEEK_API_KEY' && spec3.api === 'openai-completions', JSON.stringify(spec3))
  const spec3b = I.readProviderSpec(s3, 'other')
  ok('D2 裸值带行内注释 ⇒ 只取值', spec3b && spec3b.baseURL === 'https://o.example/v1', JSON.stringify(spec3b))
  ok('D3 endpointUrl 不再被注释污染', I.endpointUrl((spec3 || {}).baseURL || '', 'openai-completions') === 'https://api.deepseek.com/v1/chat/completions')
  ok('D4 后置的别家 providers: 段不影响 ⇒ 不存在的 provider 为 null', I.readProviderSpec(s3, 'nope') === null)
  const s4 = f('s4.yaml', 'llm-pi-ai:\n  providers:\n    open:\n      baseURL: https://x/v1\n')
  ok('D5 最简形态照旧', (I.readProviderSpec(s4, 'open') || {}).baseURL === 'https://x/v1')
}

// ═══ E. 凭据读取 ══════════════════════════════════════════════════════════
{
  const c1 = path.join(home, 'c1.yaml')
  fs.writeFileSync(c1, 'DEEPSEEK_API_KEY:\nOPENAI_API_KEY: sk-openai-SECRET\n')
  let err = null
  try { I.readApiKey({ credentialsPath: c1, credentialRef: 'DEEPSEEK_API_KEY' }) } catch (e) { err = e }
  ok('E1 值为空的键 ⇒ 抛错，绝不跨行读到下一行的键名', err && /not found|is empty/.test(err.message), err ? err.message : 'no error')
  const c2 = path.join(home, 'c2.yaml')
  fs.writeFileSync(c2, 'A: plain-key\nB: "quoted # key"\nC: \'single\'\nE:   spaced   # c\nMY_A: wrong\n')
  const rd = (k) => I.readApiKey({ credentialsPath: c2, credentialRef: k })
  ok('E2 裸值 / 双引号含 # / 单引号 / 行内注释', rd('A') === 'plain-key' && rd('B') === 'quoted # key' && rd('C') === 'single' && rd('E') === 'spaced', [rd('A'), rd('B'), rd('C'), rd('E')].join('|'))
  ok('E3 行首锚定仍然生效（MY_A 不得命中 A）', rd('A') === 'plain-key')
}

// ═══ G. 在途共享 identity 不含明文 ═══════════════════════════════════════
{
  const seen = []
  const flights = { run: (identity, execute) => { seen.push(identity); return Promise.reject(new Error('stop-here')) } }
  const credentialsPath = path.join(home, 'g.yaml'); fs.writeFileSync(credentialsPath, 'K: sk-SECRET-VALUE\n')
  const cfg = { ...I.DEFAULTS, model: 'm', followHostModel: false, followHostProvider: false, baseUrl: 'http://127.0.0.1:9', credentialRef: 'K', credentialsPath, keepAlive: false }
  await I.generateDistillation('原文 PROMPT-BODY', cfg, undefined, undefined, { flights, scope: ['s', 'main', 1] }).catch(() => {})
  ok('G1 identity 是 64 位十六进制摘要', seen.length === 1 && /^[a-f0-9]{64}$/.test(seen[0]), seen[0])
  ok('G2 identity 不含钥匙与原文', seen.length === 1 && !seen[0].includes('sk-SECRET-VALUE') && !seen[0].includes('PROMPT-BODY'))
}

// ═══ H. makeTraceWriter 自身不得抛（序列化失败只丢这一条）═══════════════
{
  const traceFile = path.join(home, 'h', 'trace.log')
  const w = I.makeTraceWriter({ trace: true, traceFile }, () => { throw new Error('statsOf boom') })
  let threw = null
  try { w('x', { a: 1 }) } catch (e) { threw = e }
  ok('H1 statsOf 抛 ⇒ trace 返回 null 而非抛出', threw === null)
  const w2 = I.makeTraceWriter({ trace: true, traceFile })
  threw = null
  try { w2('x', { big: 10n }) } catch (e) { threw = e }
  ok('H2 payload 含 BigInt ⇒ trace 返回 null 而非抛出', threw === null)
  ok('H3 正常事件仍照常落盘', typeof w2('ok', { a: 1 }) === 'string' && fs.readFileSync(traceFile, 'utf8').includes('[ok]'))
}

// ═══ I. 阶段 0 观测：below-floor 留痕 + phase0-report 纯函数 ═════════════════
{
  const tags = []
  const out = await collect(I.birthTransform(mkSrc('short'), { ...baseDeps, cfg: { ...baseCfg, birthMinChars: 100000000 }, trace: (t, d) => tags.push([t, d]) }))
  const bf = tags.find(([t]) => t === 'birth-below-floor')
  ok('I1 门槛之下的块留一条 birth-below-floor（rawChars + why），且原对象放行', !!bf && bf[1].rawChars === 5 && bf[1].why === 'below-floor' && invariantHolds(out), JSON.stringify(bf))
  ok('I2 below-floor 不起任何异步工作（无 birth-fired / 无 archive / 无 distill）', !tags.some(([t]) => t === 'birth-fired' || t === 'birth-archive-settled' || t === 'birth-distill-settled'), tags.map(([t]) => t).join(','))
  const R = await import('../tools/phase0-report.mjs')
  ok('I3 expandRoles 游程展开', JSON.stringify(R.expandRoles('system user assistant tool*3 user')) === JSON.stringify(['system', 'user', 'assistant', 'tool', 'tool', 'tool', 'user']))
  const streams = [
    { messageCount: 6, roles: 'system user assistant tool assistant user', reasoningChars: [[2, 4200], [4, 900]], userCount: 2, assistantCount: 2, toolResultCount: 1, model: 'm' },
    { messageCount: 6, roles: 'system user assistant tool assistant user', reasoningChars: [[4, 900]], userCount: 2, assistantCount: 2, toolResultCount: 1, model: 'm' },
  ]
  const a = R.analyzeStreams(streams)
  ok('I4 N1 统计：可判定 2，首条 assistant 带 reasoning 1，近似块去重后 2 块', a.n1.eligible === 2 && a.n1.firstAssistantHasReasoning === 1 && a.approxRaw.length === 2, JSON.stringify(a.n1) + ' ' + JSON.stringify(a.approxRaw))
}

console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
