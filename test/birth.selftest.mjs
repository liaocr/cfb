// birth.selftest.mjs — 出生即压缩（mode: 'birth'）：流式双轨并发拦截器（Stream-Tee）自测
// 纯本地：零网络、零会话、零 API 调用。
// ★ 结构合法性由**真实的** dsh-llm invariant.js 当裁判；
// ★ 最终消息由**真实的** dsh-llm BlockAssembler 装配裁定（不再用替身）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  birthTransform, birthHoldNew, birthSettle, birthStart, birthFinish,
  deriveArtHandle, requestOnce, requestStream, prewarmTargetUrl, provenanceOf,
  makeTraceWriter, settledTraceData, mapMessagesToSeqs, DEFAULTS,
} from '../index.js'
import os from 'node:os'

let pass = 0, failn = 0, skipn = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { failn++; fails.push(name); console.log('  FAIL  ' + name + (extra === undefined ? '' : '  :: ' + extra)) }
}
// ★ 2026-09-22：跨包断言在**缺少兄弟包**时必须报 SKIP，绝不报 FAIL。
//   理由：T13 校验的是"我们的句柄公式与真实 store 逐字一致"——没有 store 就没法校验，
//   报 FAIL 会把"没跑"伪装成"跑失败"，正是本仓库反复禁止的「样本 != 总体」。
function skip(name, why) { skipn++; console.log('  SKIP  ' + name + (why ? '  :: ' + why : '')) }

// ── chunk 工厂 ──
const BS = (index, blockType) => ({ type: 'block-start', index, blockType })
const RD = (index, text) => ({ type: 'reasoning-delta', index, text })
const TD = (index, text) => ({ type: 'text-delta', index, text })
const TC = (index, id, name, args) => ({ type: 'tool-call-delta', index, id, name, argumentsDelta: args })
const BE = (index, block) => ({ type: 'block-end', index, block })
const FIN = (kind) => ({ type: 'finish', reason: { kind: kind || 'end' } })
const USAGE = () => ({ type: 'usage', inputTokens: 1, outputTokens: 2 })
function mkStream(chunks) { return (async function* () { for (const c of chunks) yield c })() }
async function collect(it) { const out = []; for await (const c of it) out.push(c); return out }
const types = (cs) => cs.map((c) => c.type + (c.index === undefined ? '' : ':' + c.index)).join(' ')
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const noTrace = () => {}

// 可压缩的推理文本（~3000 字符）
function bulkReasoning() {
  const out = []
  for (let i = 0; i < 80; i++) out.push('CHECK module alpha verified ok step ' + (i % 5))
  return out.join('\n')
}
// 蒸馏产物（短小、信息密度高）
const SUMMARY = '【已归档决策】alpha 模块 5 个校验步骤全部通过，当前处在收尾阶段。\n' +
  '【已否决分支·不可重开】逐行重排方案已否决。\n【已证伪路径·归档】并行化尝试失败。'

const mkCfg = (over = {}) => Object.assign({
  birthMinChars: 100, birthArchive: true,
  birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 1500, birthMinSavedChars: 50,
}, over)

// ── 真实不变式加载 ──
// 2026-09-19 公测可移植性：原为作者机器上的字面路径。改为【探测】：显式 DSH_LLM_DIR >
//   $DSH_HOME 推导 > 常见全局安装位置。全部失败 ⇒ 下面 catch 里 WARN 并按替身继续
//   （本来就是 try/catch 可选加载，测试不会因此挂）。
let listener = null
function findDshLlm() {
  const cands = []
  if (process.env.DSH_LLM_DIR) cands.push(String(process.env.DSH_LLM_DIR))
  const base = 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm'
  for (const p of [
    (process.env.APPDATA || '') + '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
    (process.env.USERPROFILE || process.env.HOME || '') + '/.npm-global/' + base,
    (process.env.USERPROFILE || process.env.HOME || '') + '/AppData/Roaming/npm/' + base,
    '/usr/local/lib/' + base,
    '/usr/lib/' + base,
  ]) if (p) cands.push(p)
  for (const c of cands) { try { if (c && fs.existsSync(c + '/lib/index.js')) return c } catch { /* keep probing */ } }
  return null
}
const LLM_DIR = findDshLlm()
const INV = LLM_DIR ? pathToFileURL(LLM_DIR + '/lib/invariant.js').href : null
try {
  if (!INV) throw new Error('未找到 dsh-llm 安装位置（可设 DSH_LLM_DIR 指定）')
  const m = await import(INV)
  const fail = (msg) => { throw new Error('INVARIANT: ' + msg) }
  await m.apply({
    invariants: { register: (_n, installFn) => installFn({ on: (n, f) => { if (n === 'llm/stream') listener = f } }, fail) },
  })
} catch (e) { console.log('  WARN  真实不变式未加载: ' + ((e && e.message) || e)) }
const invariantLoaded = !!listener
async function invCheck(chunks, deps) {
  if (!invariantLoaded) return null
  try { await collect(listener({}, () => birthTransform(mkStream(chunks), deps))); return null }
  catch (e) { return String((e && e.message) || e) }
}

// ── 真实装配器（拿不到才退回忠实替身）──
let BA = null
try {
  if (!LLM_DIR) throw new Error('未找到 dsh-llm 安装位置（可设 DSH_LLM_DIR 指定）')
  const m = await import(pathToFileURL(LLM_DIR + '/lib/index.js').href)
  BA = m.BlockAssembler || null
} catch (e) { console.log('  WARN  真实 BlockAssembler 未加载: ' + ((e && e.message) || e)) }
function fakeAssemble(chunks) {
  const partials = new Map(); const order = []
  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (!p) { p = { blockType, text: '' }; order.push(index); partials.set(index, p) }
    return p
  }
  for (const c of chunks) {
    if (c.type === 'block-start') { ensure(c.index, c.blockType); continue }
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const p = ensure(c.index, c.type === 'text-delta' ? 'text' : 'reasoning')
      if (p.block) continue
      p.text += c.text; continue
    }
    if (c.type === 'block-end') { const p = ensure(c.index, c.block.type); if (!p.block) p.block = c.block }
  }
  return order.map((i) => { const p = partials.get(i); return p.block || { type: p.blockType, text: p.text } })
}
function assemble(chunks) {
  if (!BA) return fakeAssemble(chunks)
  const a = new BA()
  for (const c of chunks) a.push(c)
  if (typeof a.blocks === 'function') return a.blocks()
  if (typeof a.interruptedBlocks === 'function') return a.interruptedBlocks()
  return fakeAssemble(chunks)
}
const reasoningOf = (blocks) => blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')

// ═══ T1 无非推理块 → 逐块原样透传 ═══
{
  const src = [BS(0, 'text'), TD(0, 'hello'), BE(0, { type: 'text', text: 'hello' }), FIN()]
  const got = await collect(birthTransform(mkStream(src), { cfg: mkCfg(), trace: noTrace }))
  ok('T1 无非推理块 → 逐块原样透传', JSON.stringify(got) === JSON.stringify(src), types(got))
  ok('T1 真实不变式通过', (await invCheck(src, { cfg: mkCfg(), trace: noTrace })) === null)
}

// ═══ T2 流式双轨：delta 实时 + BE0 扣住 + 交叉关闭顺序 ═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }),
               BS(1, 'text'), TD(1, 'answer'), BE(1, { type: 'text', text: 'answer' }), FIN()]
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => 'art://ARCH2', sessionId: () => 'sess-test',
    distill: async () => ({ text: SUMMARY }),
  }
  const got = await collect(birthTransform(mkStream(src), deps))
  ok('T2 ★ 交叉关闭顺序：BE0 在 BE1 之后放行（方案一时序）',
     types(got) === 'block-start:0 reasoning-delta:0 block-start:1 text-delta:1 block-end:1 block-end:0 finish', types(got))
  const rd = got.find((c) => c.type === 'reasoning-delta')
  ok('T2 ★ delta 实时透传原文（思考框零延迟）', !!rd && rd.text === raw, rd ? (rd.text.length + ' vs ' + raw.length) : 'no delta')
  const be0 = got.filter((c) => c.type === 'block-end' && c.index === 0)[0]
  ok('T2 ★ block-end:0 落在 finish 之前（不变式要求）',
     got.indexOf(be0) < got.findIndex((c) => c.type === 'finish') && got.indexOf(be0) > got.findIndex((c) => c.type === 'block-end' && c.index === 1))
  ok('T2 ★ block-end:0.block.text = 蒸馏稿 + 句柄',
     !!be0 && be0.block.text === SUMMARY, be0 && be0.block.text)
  ok('T2 真实不变式通过', (await invCheck(src, deps)) === null)
}

// ═══ T3 真实装配器：最终消息 = 蒸馏稿（不是原文）═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }), FIN()]
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => 'art://ARCH3', sessionId: () => 'sess-test',
    distill: async () => ({ text: SUMMARY }),
  }
  const rawAsm = reasoningOf(assemble(src))
  ok('T3 对照：原样源流经装配器 ⇒ 原文（模型有效）', rawAsm === raw)
  const got = await collect(birthTransform(mkStream(src), deps))
  const rt = reasoningOf(assemble(got))
  ok('T3 ★ 装配后的推理 = 蒸馏稿（不是原文）', rt === SUMMARY, rt.length + ' vs ' + raw.length)
  // 阴性对照：若 block-end 没被改写，装配结果会退回原文
  const broken = got.map((c) => (c.type === 'block-end' && c.block ? { ...c, block: { ...c.block, text: raw } } : c))
  ok('T3 ★ 阴性对照：不改写 block-end ⇒ 装配退回原文（断言非空转）', reasoningOf(assemble(broken)) === raw)
}

// ═══ T4 收尾预算：蒸馏卡死 → 熔断 → raw + 句柄 ═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }),
               BS(1, 'text'), TD(1, 'x'), BE(1, { type: 'text', text: 'x' }), FIN()]
  const deps = {
    cfg: mkCfg({ birthFinishWaitMs: 300 }), trace: noTrace,
    archive: async () => 'art://ARCH4', sessionId: () => 'sess-test',
    distill: () => new Promise(() => {}),   // 永不返回
  }
  const t0 = Date.now()
  const got = await collect(birthTransform(mkStream(src), deps))
  const dt = Date.now() - t0
  const be0 = got.filter((c) => c.type === 'block-end' && c.index === 0)[0]
  ok('T4 ★ 到点熔断（不再干等）', dt >= 250 && dt < 1200, dt + 'ms')
  ok('T4 ★ 熔断后原样放行 raw + 句柄（模型必须看得见自己的推理）', !!be0 && be0.block.text === raw)
  ok('T4 finish 仍最后', got[got.length - 1].type === 'finish')
  ok('T4 真实不变式通过', (await invCheck(src, deps)) === null)
}

// ═══ T5 保本线 50：净省不足 ⇒ 不替换 ═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }), FIN()]
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => 'art://ARCH5', sessionId: () => 'sess-test',
    distill: async () => ({ text: raw.slice(0, raw.length - 30) }),  // 只省 30 < 50 保本线 ⇒ 必须走 no-gain
  }
  const got = await collect(birthTransform(mkStream(src), deps))
  const be0 = got.filter((c) => c.type === 'block-end')[0]
  ok('T5 ★ 净省 <50 → no-gain，原样放行 raw + 句柄',
     be0.block.text === raw,
     'saved=' + (raw.length - be0.block.text.length))
  // 等价性：净省刚过线（≥50）⇒ 采用
  const dist2 = raw.slice(0, raw.length - 200)
  const deps2 = Object.assign({}, deps, { distill: async () => ({ text: dist2 }) })
  const got2 = await collect(birthTransform(mkStream(src), deps2))
  ok('T5 ★ 净省 ≥50 → 采用蒸馏稿', got2.filter((c) => c.type === 'block-end')[0].block.text.indexOf(SUMMARY) < 0)
}

// ═══ T6 蒸馏抛错 ⇒ raw + 句柄（零 rules 兜底）═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }), FIN()]
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => 'art://ARCH6', sessionId: () => 'sess-test',
    distill: async () => { throw new Error('http 500 boom') },
  }
  const got = await collect(birthTransform(mkStream(src), deps))
  ok('T6 ★ 蒸馏失败 → raw + 句柄', got.filter((c) => c.type === 'block-end')[0].block.text === raw)
  ok('T6 真实不变式通过', (await invCheck(src, deps)) === null)
}

// ═══ T7 归档失败 ⇒ raw（无句柄：resolve() 必然 404）═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }), FIN()]
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => null, sessionId: () => 'sess-test',
    distill: async () => ({ text: SUMMARY }),
  }
  const got = await collect(birthTransform(mkStream(src), deps))
  ok('T7 ★ 归档失败 → 绝不用预计算句柄，纯原文放行',
     got.filter((c) => c.type === 'block-end')[0].block.text === raw)
}

// ═══ T8 below-floor：不归档、不提纯、立即放行 ═══
{
  let archived = 0, distilled = 0
  const src = [BS(0, 'reasoning'), RD(0, 'short'), BE(0, { type: 'reasoning', text: 'short' }), FIN()]
  const deps = {
    cfg: mkCfg({ birthMinChars: 500 }), trace: noTrace,
    archive: async () => { archived++; return 'art://X' }, sessionId: () => 'sess-test',
    distill: async () => { distilled++; return { text: 'x' } },
  }
  const got = await collect(birthTransform(mkStream(src), deps))
  ok('T8 ★ below-floor → 零归档零提纯（不白付 I/O 与 token）', archived === 0 && distilled === 0, 'a=' + archived + ' d=' + distilled)
  ok('T8 ★ 立即原样放行（句柄不附加）', got.filter((c) => c.type === 'block-end')[0].block.text === 'short')
}

// ═══ T9 多推理块：并行兑现（总耗时 ≈ 单块）═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }),
               BS(1, 'reasoning'), RD(1, raw), BE(1, { type: 'reasoning', text: raw }), FIN()]
  let active = 0, maxActive = 0
  const deps = {
    cfg: mkCfg(), trace: noTrace,
    archive: async () => 'art://ARCH9', sessionId: () => 'sess-test',
    distill: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(200); active--; return { text: SUMMARY } },
  }
  const t0 = Date.now()
  const got = await collect(birthTransform(mkStream(src), deps))
  const dt = Date.now() - t0
  ok('T9 ★ 两块蒸馏并发（不是串行等待）', maxActive === 2, 'maxActive=' + maxActive)
  ok('T9 ★ 总耗时 ≈ 单块（并行兑现）', dt < 900, dt + 'ms')
  ok('T9 ★ 两块都被替换 + finish 最后',
     got.filter((c) => c.type === 'block-end').length === 2 && got[got.length - 1].type === 'finish' &&
     got.filter((c) => c.type === 'block-end').every((c) => c.block.text === SUMMARY))
  ok('T9 真实不变式通过', (await invCheck(src, deps)) === null)
}

// ═══ T10 abort：绝不等待，立即原始放行 ═══
{
  const raw = bulkReasoning()
  const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }),
               BS(1, 'text'), TD(1, 'partial'), BE(1, { type: 'text', text: 'partial' }), FIN('aborted')]
  const deps = {
    cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace: noTrace,
    archive: async () => 'art://ARCH10', sessionId: () => 'sess-test',
    distill: () => new Promise(() => {}),   // 永不返回
  }
  const t0 = Date.now()
  const got = await collect(birthTransform(mkStream(src), deps))
  const dt = Date.now() - t0
  const be0 = got.filter((c) => c.type === 'block-end' && c.index === 0)[0]
  ok('T10 ★ abort 不等待收尾（<300ms，预算 1500ms）', dt < 300, dt + 'ms')
  ok('T10 ★ 原始放行（raw 打头）+ finish 保留 aborted',
     !!be0 && be0.block.text.indexOf(raw) === 0 &&
     got[got.length - 1].type === 'finish' && got[got.length - 1].reason.kind === 'aborted')
  ok('T10 真实不变式通过', (await invCheck(src, deps)) === null)
}

// ═══ T11 源流抛错：原文已实时冲出，错误原样抛出 ═══
{
  const raw = bulkReasoning()
  const src = (async function* () { yield BS(0, 'reasoning'); yield RD(0, raw); throw new Error('source exploded') })()
  const deps = { cfg: mkCfg(), trace: noTrace, archive: async () => 'art://X', sessionId: () => 's', distill: async () => ({ text: SUMMARY }) }
  const got = []
  let err = null
  try { for await (const c of birthTransform(src, deps)) got.push(c) } catch (e) { err = String((e && e.message) || e) }
  ok('T11 ★ 源流错误原样抛出（不被吞）', err === 'source exploded', String(err))
  ok('T11 ★ 抛错前原文已实时冲出', got.some((c) => c.type === 'reasoning-delta' && c.text === raw))
}

// ═══ T12 tool-call / usage 原样透传 ═══
{
  const src = [BS(0, 'text'), TD(0, 't'), BE(0, { type: 'text', text: 't' }),
               BS(1, 'tool-call'), TC(1, 'id1', 'read', '{"a":1}'), BE(1, { type: 'tool-call', id: 'id1' }),
               USAGE(), FIN()]
  const got = await collect(birthTransform(mkStream(src), { cfg: mkCfg(), trace: noTrace }))
  ok('T12 tool-call/usage 原样透传', JSON.stringify(got) === JSON.stringify(src))
  ok('T12 真实不变式通过', (await invCheck(src, { cfg: mkCfg(), trace: noTrace })) === null)
}

// ═══ T13 句柄公式与真实 store 逐字一致 ═══
{
  const sid = 'sess-xcheck', text = 'hello world 你好'
  // 兄弟包位置候选（跨 checkout / 独立分发都要能找到；找不到就 SKIP）
  const cands = []
  if (process.env.CMB_STORE_PATH) cands.push(process.env.CMB_STORE_PATH)
  cands.push(new URL('../../dsh-context-memory-bundle/store/dshb-store.js', import.meta.url).href)
  // verify.mjs 会把 DSH_HOME 换成临时目录，原值经 CFB_REAL_DSH_HOME 传入（只读探测用）
  for (const h of [process.env.CFB_REAL_DSH_HOME, process.env.DSH_HOME]) {
    if (h && String(h).trim()) cands.push(path.join(String(h).trim(), 'profiles/web/node_modules/@dsh-external/dsh-context-memory-bundle/store/dshb-store.js'))
  }
  cands.push(path.join(os.homedir(), '.dsh', 'profiles/web/node_modules/@dsh-external/dsh-context-memory-bundle/store/dshb-store.js'))
  let found = null
  for (const c of cands) {
    try {
      // ⚠ 必须**先落成真实路径再判存在**：new URL(...).href 永远是合法 file: URL，
      //   直接采信就等于"跳过存在性检查"，缺包时会退化成 LOAD-ERR 而不是 SKIP。
      const p = c.startsWith('file:') ? fileURLToPath(c) : c
      if (fs.existsSync(p)) { found = pathToFileURL(p).href; break }
    } catch { /* next */ }
  }
  if (!found) {
    skip('T13 ★ deriveArtHandle ≡ dshb-store.deriveHandle', '兄弟包 dsh-context-memory-bundle 不在本机（设 CMB_STORE_PATH 可指定）')
  } else {
    let verdict = 'STORE-NOT-LOADED'
    try {
      const m = await import(found)
      const C = m.default || m.DshbStore || m.Store
      const sha = (await import('node:crypto')).createHash('sha256').update(text, 'utf8').digest('hex')
      const theirs = C.prototype.deriveHandle.call(null, sid, sha)
      const mine = deriveArtHandle(sid, text)
      verdict = mine === theirs ? 'MATCH' : ('MISMATCH ' + mine + ' vs ' + theirs)
    } catch (e) { verdict = 'LOAD-ERR ' + ((e && e.message) || e) }
    ok('T13 ★ deriveArtHandle ≡ dshb-store.deriveHandle', verdict === 'MATCH', verdict)
  }
}

// ═══ T14 终审参数已锁进 DEFAULTS ═══
{
  ok('T14 ★ birthFinishWaitMs = 1500（终审锁定）', DEFAULTS.birthFinishWaitMs === 1500, String(DEFAULTS.birthFinishWaitMs))
  ok('T14 ★ birthMinSavedChars = 50（终审锁定）', DEFAULTS.birthMinSavedChars === 50, String(DEFAULTS.birthMinSavedChars))
}

// ═══ T15 零 rules 污染：birth 段不出现 compressByRules ═══
{
  // v11.8：birth 实现独立成 src/birth.js；规则引擎已整体移除 ⇒ 全部 src/ 都不得再出现它
  const seg = fs.readFileSync(new URL('../src/birth.js', import.meta.url), 'utf8')
  ok('T15 ★ birth 实现段非空（可定位）', seg.includes('export function birthStart') && seg.length > 1000, String(seg.length))
  const srcDir = new URL('../src/', import.meta.url)
  const withRules = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js') && fs.readFileSync(new URL(f, srcDir), 'utf8').includes('compressByRules('))
  ok('T15 ★ 零 rules 兜底（src/ 内无 compressByRules 调用）', withRules.length === 0, withRules.join(','))
}

// ═══ T16 两段式 API：block-end 处同步起火（不阻塞），finish 处收网 ═══
{
  const raw = bulkReasoning()
  const entry = { index: 0, text: raw, end: { type: 'block-end', index: 0, block: { type: 'reasoning', text: raw } } }
  let distillStarted = false
  const deps = { cfg: mkCfg(), trace: noTrace, archive: async () => 'art://ARCH16', sessionId: () => 's', deriveHandle: (s, t) => 'art://PRE16',
                 distill: async () => { distillStarted = true; return { text: SUMMARY } } }
  const t0 = Date.now()
  const task = birthStart(entry, deps)
  const syncMs = Date.now() - t0
  ok('T16 ★ birthStart 同步返回（<5ms，内存算句柄）', syncMs < 5 && !!task && task.belowFloor === false, syncMs + 'ms')
  ok('T16 ★ 句柄已内存秒算（无需等写盘）', task.handle === 'art://PRE16', String(task.handle))
  const chunks = await birthFinish(task, deps)
  ok('T16 ★ 收网后采用蒸馏稿 + 落盘句柄',
     chunks.chunks.filter((c) => c.type === 'block-end')[0].block.text === SUMMARY,
     JSON.stringify(chunks.chunks).slice(0, 160))
}

// ── T17 ★ 短路信号（2026-09-21 外部审计第一批）──────────────────────────────
//   命题：归档【终局失败】或提纯【终局失败】时，收网必须立刻返回，
//         不再为一个注定走原文的结果陪跑到 birthFinishWaitMs。
{
  const raw = bulkReasoning()
  const entry = { index: 0, text: raw, end: BE(0, { type: 'reasoning', text: raw }) }
  const events = []
  const trace = (tag, o) => events.push({ tag, o })

  // T17a：归档失败 + 提纯【永不返回】⇒ 必须立刻放行（旧行为：等满 1500ms）
  {
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace,
      archive: async () => null,
      distill: () => new Promise(() => {}),
    }
    const task = birthStart(entry, deps)
    const t0 = Date.now()
    const r = await birthFinish(task, deps)
    const ms = Date.now() - t0
    ok('T17a ★ 归档终局失败 ⇒ 立即短路（不等满 1500ms）', ms < 400, ms + 'ms')
    ok('T17a ★ 放行原文（拿不到句柄 ⇒ 绝不替换）', r.text === raw, r.why)
    const pt = events.filter((e) => e.tag === 'birth-passthrough').pop()
    ok('T17a ★ 原因标注为短路（archive-failed-early）',
       pt && pt.o.why === 'archive-failed-early' && pt.o.short === 'archive-failed-early',
       JSON.stringify(pt && pt.o))
    ok('T17a ★ 留痕 waitedMs（指标拆分用）', pt && typeof pt.o.waitedMs === 'number', JSON.stringify(pt && pt.o))
  }

  // T17b：提纯失败 + 归档【永不返回】⇒ 必须立刻放行
  {
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace,
      archive: () => new Promise(() => {}),
      distill: async () => { throw new Error('boom') },
    }
    const task = birthStart(entry, deps)
    const t0 = Date.now()
    const r = await birthFinish(task, deps)
    const ms = Date.now() - t0
    ok('T17b ★ 提纯终局失败 ⇒ 立即短路（不等满 1500ms）', ms < 400, ms + 'ms')
    ok('T17b ★ 仍放行原文', r.text === raw, r.why)
    const pt = events.filter((e) => e.tag === 'birth-passthrough').pop()
    ok('T17b ★ 原因标注为短路（distill-failed-early）', pt && pt.o.why === 'distill-failed-early',
       JSON.stringify(pt && pt.o))
  }

  // T17c：短路只停止「等待」，绝不取消归档本体 —— 提纯失败后归档仍须落地
  {
    let archiveDone = false
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace,
      archive: async () => { await sleep(120); archiveDone = true; return 'art://PRE17' },
      distill: async () => { throw new Error('boom') },
    }
    const task = birthStart(entry, deps)
    const r = await birthFinish(task, deps)
    ok('T17c ★ 提纯失败已短路放行', r.why === 'distill-failed-early', r.why)
    ok('T17c ★ 归档未被短路取消（后台继续）', task.diskState === null, 'diskState=' + String(task.diskState))
    await sleep(200)
    ok('T17c ★ 归档最终仍然落地（不因取消压缩而取消归档）',
       archiveDone && task.diskState && task.diskState.ok === true, JSON.stringify(task.diskState))
  }

  // T17d：正常路径不受短路影响（归档 ok + 提纯 ok ⇒ 仍然替换）
  {
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace,
      archive: async () => 'art://PRE17D',
      distill: async () => ({ text: SUMMARY }),
    }
    const task = birthStart(entry, deps)
    const r = await birthFinish(task, deps)
    ok('T17d ★ 成功路径不受短路影响（仍走 condensed）', r.why === 'condensed' && r.text === SUMMARY, r.why)
    ok('T17d ★ 未误标短路', task.shortReason === null, String(task.shortReason))
  }
}

// ── T18 ★ 放弃应用 ⇒ 取消在飞提纯（2026-09-21 外部审计 P0-2）──────────────────
{
  const raw = bulkReasoning()
  const entry = { index: 0, text: raw, end: BE(0, { type: 'reasoning', text: raw }) }

  // T18a：放弃应用 ⇒ 取消在飞提纯（省连接槽）。v12.1 起这是唯一契约（下轮收网 / 迟到暂存已删除，
  //   放行后仍在跑的提纯没有任何消费者 ⇒ 不取消就是白烧）。
  {
    const seen = []
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 120 }), trace: noTrace,
      archive: async () => 'art://PRE18',
      distill: (r, signal) => new Promise((_res, rej) => {
        seen.push(signal ? 'signal-given' : 'no-signal')
        if (signal) signal.addEventListener('abort', () => { seen.push('aborted'); rej(Object.assign(new Error('cancelled'), { cancelled: true })) }, { once: true })
      }),
    }
    const task = birthStart(entry, deps)
    // birthStart 是**同步**的（T16 钉住 <5ms），提纯在下一个微任务才起飞 ⇒ 这里必须让一拍
    await Promise.resolve(); await Promise.resolve()
    ok('T18a ★ birthStart 把 signal 交给提纯', seen[0] === 'signal-given', JSON.stringify(seen))
    const r = await birthFinish(task, deps)
    ok('T18a ★ 超时后放行原文', r.why === 'distill-timeout' && r.text === raw, r.why)
    await sleep(20)
    ok('T18a ★★ 放行 ⇒ 取消在飞提纯', seen.includes('aborted'), JSON.stringify(seen))
  }

  // T18b：提纯【已经落地】⇒ 绝不许取消（那是已经付过的钱）
  {
    const seen = []
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 1500 }), trace: noTrace,
      archive: async () => 'art://PRE18B',
      distill: async (r, signal) => {
        seen.push('started')
        if (signal) signal.addEventListener('abort', () => seen.push('aborted'), { once: true })
        return { ok: true, text: '', meta: null }
      },
    }
    const task = birthStart(entry, deps)
    await task.distillP
    const r = await birthFinish(task, deps)
    ok('T18b ★ 提纯已落地 ⇒ 结果已计入判定', task.distillState && task.distillState.ok === false, JSON.stringify(task.distillState))
    ok('T18b ★ 已落地的提纯不被取消', !seen.includes('aborted'), JSON.stringify(seen))
  }

  // T18c：开关可关（为将来的「历史回收」消费者留口）
  {
    const seen = []
    const deps = {
      cfg: mkCfg({ birthFinishWaitMs: 120, birthCancelOnGiveUp: false }), trace: noTrace,
      archive: async () => 'art://PRE18C',
      distill: (r, signal) => new Promise(() => { if (signal) signal.addEventListener('abort', () => seen.push('aborted'), { once: true }) }),
    }
    const task = birthStart(entry, deps)
    await birthFinish(task, deps)
    await sleep(20)
    ok('T18c ★ birthCancelOnGiveUp:false ⇒ 不取消（给历史回收留口）', !seen.includes('aborted'), JSON.stringify(seen))
  }

  // T18d：阶段探针字段存在（requestOnce 的新 meta）
  {
    const r = await requestOnce('http://127.0.0.1:9/nope', { timeoutMs: 60 })
      .then(() => null, (e) => e)
    ok('T18d ★ requestOnce 连接失败仍返回带阶段字段的错误', !!r, String(r && r.message))
  }
}

// ── T19 ★ 预热目标 URL（2026-09-21 实机探针：404 会吃掉连接池）─────────────────
{
  ok('T19 ★ /v1 结尾的 base ⇒ 预热打 origin（不是 /v1/）',
     prewarmTargetUrl('https://a6.a6api.com/v1') === 'https://a6.a6api.com/',
     String(prewarmTargetUrl('https://a6.a6api.com/v1')))
  ok('T19 ★ 带尾斜杠也归一',
     prewarmTargetUrl('https://a6.a6api.com/v1/') === 'https://a6.a6api.com/',
     String(prewarmTargetUrl('https://a6.a6api.com/v1/')))
  ok('T19 ★ 带端口保留端口',
     prewarmTargetUrl('https://h.example:8443/v1') === 'https://h.example:8443/',
     String(prewarmTargetUrl('https://h.example:8443/v1')))
  ok('T19 ★ 空 base ⇒ null（放弃预热，而不是打一个相对 URL）',
     prewarmTargetUrl('') === null && prewarmTargetUrl(null) === null,
     String(prewarmTargetUrl('')))
  // ⚠ 用字面子串而不是正则 —— 第一版正则写坏了，恒过（空测试）。这里钉死调用点。
  const src = fs.readFileSync(new URL('../src/transport.js', import.meta.url), 'utf8')
  const LEGACY = "replace(/\\/+$/, '') + '/'"
  ok('T19 ★ 调用点必须走 prewarmTargetUrl（不许再手拼 base）',
     src.includes('const url = prewarmTargetUrl(base)'), 'call site not using prewarmTargetUrl')
  // 旧写法只允许出现在 prewarmTargetUrl 的【非绝对 URL 回落分支】里，恰好 1 次。
  // 若有人把它加回调用点，计数变 2 ⇒ 当场挂。
  const hits = src.split(LEGACY).length - 1
  ok('T19 ★ 旧写法只出现在 prewarmTargetUrl 的回落分支（恰好 1 处）', hits === 1, 'occurrences=' + hits)
}


// ── T20 ★ 流式 SSE 解析（2026-09-21 观测型迁移）─────────────────────────────
//   真实端点验证见 deploy/probe/_probe-stream-phases.mjs；这里钉死【解析边界】，
//   全部离线：起一个本地 http server 喂手工构造的字节流。
{
  const httpMod = await import('node:http')
  const srv = httpMod.createServer((req, res) => {
    const mode = new URL(req.url, 'http://x').searchParams.get('m')
    if (mode === 'ok') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')   // role-only ⇒ 不算内容
      res.write('data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}\n\n')          // 空串 ⇒ 不算
      res.write(': keep-alive\n\n')                                                                 // 心跳 ⇒ 不算
      // ② 故意把一个多字节 UTF-8 字符劈成两个 TCP chunk
      const frame = Buffer.from('data: {"choices":[{"delta":{"content":"中"}}]}\n\n', 'utf8')
      const cut = frame.indexOf(Buffer.from('中', 'utf8')) + 1
      res.write(frame.subarray(0, cut))
      setTimeout(() => { res.write(frame.subarray(cut)); res.write('data: [DONE]\n\n'); res.end() }, 30)
      return
    }
    if (mode === 'trunc') {   // ③ 连接断开，没有 [DONE]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n')
      setTimeout(() => res.destroy(), 30)
      return
    }
    res.writeHead(500); res.end('nope')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port

  const a = await requestStream('http://127.0.0.1:' + port + '/?m=ok', { body: '{}', timeoutMs: 5000 })
  ok('T20 ★ 跨 chunk 的多字节 UTF-8 不被劈坏', a.events.some((e) => e.data.includes('中')), JSON.stringify(a.events.map(e=>e.data)))
  ok('T20 ★ 心跳与注释不产生事件', a.events.every((e) => !e.data.includes('keep-alive')), 'n=' + a.events.length)
  ok('T20 ★ role-only / 空 content 都在事件里（由调用方判定不算内容）',
     a.events.length === 3, 'events=' + a.events.length)
  ok('T20 ★ [DONE] 被识别', a.meta.done === true, String(a.meta.done))
  ok('T20 ★ 阶段字段齐全（headersAt/firstEventAt/completedAt）',
     a.meta.headersAt !== null && a.meta.firstEventAt !== null && a.meta.completedAt !== null,
     JSON.stringify({ h: a.meta.headersAt, f: a.meta.firstEventAt, c: a.meta.completedAt }))

  const b = await requestStream('http://127.0.0.1:' + port + '/?m=trunc', { body: '{}', timeoutMs: 5000 })
    .then(() => null, (e) => e)
  ok('T20 ★ 连接断开 ⇒ 走 reject（不冒充正常完成）', !!b, String(b && b.message))
  ok('T20 ★ 断开时 truncated 已标记', b && b.meta && b.meta.truncated === true, JSON.stringify(b && b.meta && b.meta.truncated))
  ok('T20 ★ 没有 [DONE] 时 done=false', b && b.meta && b.meta.done === false, JSON.stringify(b && b.meta && b.meta.done))

  srv.close()
}

// ── T21 ★ 预热默认关闭（三组对照实测：预热比不预热慢）───────────────────────
{
  ok('T21 ★ DEFAULTS.prewarm === false（总时间对照支持关闭）', DEFAULTS.prewarm === false, String(DEFAULTS.prewarm))
  ok('T21 ★ DEFAULTS.distillStream === false（流式必须显式打开）', DEFAULTS.distillStream === false, String(DEFAULTS.distillStream))
}

// ── T22 ★ 消息溯源（2026-09-21 外部审计 P0-3）────────────────────────────────
{
  const mk = (role, content) => ({ role, content: [{ type: 'text', text: content }] })
  const p = provenanceOf([
    mk('system', 'S'),
    mk('user', '真用户问题'),
    mk('assistant', '回答'),
    mk('user', '宿主注入的 runtime context 一'),
    mk('user', '宿主注入的 runtime context 二'),
    mk('assistant', ''),
    { role: 'user', content: [{ type: 'text', text: '<cot-ledger>看板内容</cot-ledger>' }] },
  ])
  ok('T22 ★ 逐条溯源给出 role/字符数', p.items.length === 7 && p.items[1].role === 'user' && p.items[1].chars === 5,
     JSON.stringify(p.items.slice(0, 3)))
  ok('T22 ★ 连续 user 游程被单独列出（from=3,to=4,n=2）',
     p.runs.some((r) => r.role === 'user' && r.n === 2 && r.from === 3 && r.to === 4),
     JSON.stringify(p.runs))
  ok('T22 ★ 看板被识别（不冒充人类发言）',
     p.items[6].isLedger === true && p.items[6].head === undefined,
     JSON.stringify(p.items[6]))
  ok('T22 ★ 人类 user 带开头片段（用于区分注入）',
     p.items[1].head === '真用户问题' && p.items[3].head === '宿主注入的 runtime context 一',
     JSON.stringify([p.items[1].head, p.items[3].head]))
  ok('T22 ★ 不修改入参（只观测，绝不删/改/合并）',
     p.items.length === 7, 'items=' + p.items.length)
  ok('T22 ★ 空数组不炸', provenanceOf([]).items.length === 0 && provenanceOf(null).runs.length === 0, 'ok')
}

// ── T23 ★ 端到端 trace 测试（2026-09-21 外部审计要求）────────────────────────
//   只测 meta 里有字段，挡不住"字段没进白名单"——本文件刚栽过一次。
//   这里走【真实 trace writer】写一条，再【从磁盘读回】解析，断言字段真的落盘了。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cot-trace-'))
  const file = path.join(dir, 'trace.log')
  const stats = { seen: 1 }
  const trace = makeTraceWriter({ trace: true, traceFile: file }, () => stats)

  const streamMeta = {
    model: 'M', endpoint: 'p|openai-completions', style: 'chat', thinkingOff: true,
    promptChars: 1234, maxOutputTokens: 1200, connectMs: 12, ttfbMs: 2400, firstByteMs: null,
    totalMs: 3000, chunks: 90, reused: true, status: 200, bytes: 5000, cancelled: false,
    finish: 'stop', reasoningChars: 0, stream: true, eventCount: 90, badFrame: 0, outputChars: 174,
    toFirstEventMs: 2400, toFirstContentMs: 2400, contentSpanMs: 506, toCompleteMs: 3000,
  }
  const written = trace('birth-distill-settled', settledTraceData(0, 3002, { ok: true, text: 'x'.repeat(174), meta: streamMeta }))
  ok('T23 ★ trace writer 确实写了行', typeof written === 'string' && written.includes('birth-distill-settled'), String(written).slice(0, 60))

  const back = fs.readFileSync(file, 'utf8').trim().split('\n').pop()
  // 稳健解析：格式是 "[ISO] [tag] {json}" ⇒ 取最后一个 "] " 之后的部分
  ok('T23 ★ 行格式为 [时间] [标签] {json}', back.indexOf('] [birth-distill-settled] ') > 0, back.slice(0, 40))
  const json = JSON.parse(back.slice(back.lastIndexOf('] ') + 2))
  for (const k of ['toFirstContentMs', 'contentSpanMs', 'toCompleteMs', 'eventCount', 'outputChars', 'stream', 'reused', 'chunks']) {
    ok('T23 ★ 落盘后有 ' + k, json[k] !== undefined, 'value=' + JSON.stringify(json[k]))
  }
  ok('T23 ★ 阶段值正确（不是 undefined 占位）',
     json.toFirstContentMs === 2400 && json.contentSpanMs === 506 && json.toCompleteMs === 3000,
     JSON.stringify([json.toFirstContentMs, json.contentSpanMs, json.toCompleteMs]))
  ok('T23 ★ stats 被附加到每行', json.stats && json.stats.seen === 1, JSON.stringify(json.stats))

  // ★ 失败/取消路径也必须带出阶段字段（真机首条 settled 就是在这里丢了 meta）
  const failLine = trace('birth-distill-settled', settledTraceData(0, 6019, {
    ok: false, error: 'cancelled',
    meta: Object.assign({}, streamMeta, { cancelled: true, toFirstContentMs: null, contentSpanMs: null }),
  }))
  const fj = JSON.parse(failLine.slice(failLine.lastIndexOf('] ') + 2))
  ok('T23 ★ 失败路径仍带 ttfbMs/chunks（不再是空记录）', fj.ttfbMs === 2400 && fj.chunks === 90, JSON.stringify([fj.ttfbMs, fj.chunks]))
  ok('T23 ★ 失败路径标出 cancelled', fj.cancelled === true, String(fj.cancelled))
  ok('T23 ★ 失败路径 reason 保留', fj.reason === 'cancelled', String(fj.reason))

  const t2 = makeTraceWriter({ trace: false, traceFile: path.join(dir, 'never.log') }, () => stats)
  ok('T23 ★ trace:false ⇒ 不写任何文件', t2('x', {}) === null && !fs.existsSync(path.join(dir, 'never.log')), 'ok')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── T24 ★ 出站消息 → 源事件 seq 映射（2026-09-21 外部审计 P0-3）──────────────
{
  const events = {
    0: { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'S' }] } } },
    1: { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    2: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
    3: { type: 'assistant/message', data: { message: { content: [] } } },
    4: { type: 'user/message', data: { role: 'user', content: [] } },
    5: { type: 'tool/result', data: { message: { role: 'tool', content: [] } } },
  }
  const fake = { surface: { nodes: [0, 1, 2, 3, 4, 5] }, eventAt: (s) => events[s] || null }
  const r = mapMessagesToSeqs(fake, 5)
  ok('T24 ★ 映射跳过空内容 assistant（seq=3）', r.map && r.map.indexOf(3) === -1, JSON.stringify(r.map))
  ok('T24 ★ 映射保留空 user（seq=4）—— user 无条件投影', r.map && r.map.includes(4), JSON.stringify(r.map))
  ok('T24 ★ 条数与出站消息一致 ⇒ aligned', r.note === 'aligned', r.note + ' map=' + JSON.stringify(r.map))
  ok('T24 ★ 顺序与 surface.nodes 一致', JSON.stringify(r.map) === JSON.stringify([0, 1, 2, 4, 5]), JSON.stringify(r.map))
  ok('T24 ★ 无 surface ⇒ 明确报 no-surface（不瞎猜）', mapMessagesToSeqs({}, 0).note === 'no-surface', 'ok')
  ok('T24 ★ 不炸（null session）', mapMessagesToSeqs(null, 3).map === null, 'ok')

  // ★★ 最危险的假阳性（外部审计）：数量不一致时**绝不能**按下标硬配 seq ★★
  const r2 = mapMessagesToSeqs(fake, 4)   // 实际会映射出 5 条，故意报 4
  ok('T24 ★ 数量不一致 ⇒ note 为 mapping-mismatch', r2.note === 'mapping-mismatch', r2.note)
  ok('T24 ★ 不一致时带上实际/期望数量（便于定位）', r2.count === 5 && r2.expected === 4,
     JSON.stringify({ c: r2.count, e: r2.expected }))
  ok('T24 ★ 不一致时不谎报 aligned（调用方据此拒绝写 seq）', r2.note !== 'aligned', r2.note)
}

// ── T25 ★ provenanceOf 记录内容块结构（chars:0 ≠ 空消息）─────────────────────
{
  const p = provenanceOf([
    { role: 'user', content: [{ type: 'image', data: 'x' }, { type: 'text', text: '' }] },
    { role: 'user', content: '' },
    { role: 'user', content: null },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }], tool_calls: [{ id: 'c1' }] },
  ])
  ok('T25 ★ 非文本块被如实记录（chars=0 但有 image 块）',
     p.items[0].chars === 0 && p.items[0].blockTypes.includes('image') && p.items[0].nonTextBlocks === 1,
     JSON.stringify(p.items[0]))
  ok('T25 ★ 字符串 content 记为 string', p.items[1].contentType === 'string' && p.items[1].chars === 0, JSON.stringify(p.items[1]))
  ok('T25 ★ null content 记为 null（与空数组区分）', p.items[2].contentType === 'null', JSON.stringify(p.items[2]))
  ok('T25 ★ 工具关联被记录', p.items[3].hasToolCalls === 1, JSON.stringify(p.items[3]))

  // ★★ 真机裁决：tool-result 的文本在【嵌套 content】里，chars:0 是探针读不到，不是空消息 ★★
  const tr = provenanceOf([{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', isError: false,
    content: [{ type: 'text', text: 'doc corrected' }] }] }])
  ok('T25 ★ tool-result 的嵌套文本被计入 nestedChars', tr.items[0].nestedChars === 13, JSON.stringify(tr.items[0].nestedChars))
  ok('T25 ★ tool-result 仍如实记为非文本块（不冒充人类发言）',
     tr.items[0].blockTypes.includes('tool-result') && tr.items[0].nonTextBlocks === 1, JSON.stringify(tr.items[0].blockTypes))
  ok('T25 ★ tool-result 的 head 取嵌套文本（不再恒为空）', tr.items[0].head === 'doc corrected', JSON.stringify(tr.items[0].head))
}

// ── T26–T32（v12.1 删除）：任务状态记忆 / 证据采集 / 有序归并 / 缓存身份 / 索引回退 / 来源权限，随 memory 模式一并移除（见 CHANGELOG v12.1）

// ═══ T33 v11.6：免费窗口探针 / 空白候选断言 / 保真观测 / 成本模型字段 ═══
{
  const raw = bulkReasoning()
  // (a) 三时刻探针：tool-call block-start 在 reasoning block-end 之前出现 ⇒ otherStartToLastEndMs ≥ 0
  {
    const traces = []
    const src = [BS(0, 'reasoning'), RD(0, raw), BS(1, 'tool-call'), BE(0, { type: 'reasoning', text: raw }), FIN()]
    const deps = { cfg: mkCfg(), trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's', distill: async () => ({ text: SUMMARY }) }
    const got = await collect(birthTransform(mkStream(src), deps))
    const probe = traces.find(([t]) => t === 'birth-window-probe')
    ok('T33.1 ★ 每条含 reasoning 的流恰好落一条 birth-window-probe', traces.filter(([t]) => t === 'birth-window-probe').length === 1)
    ok('T33.2 探针记录 firstOtherType=tool-call 且三时刻齐全', probe && probe[1].firstOtherType === 'tool-call' && Number.isFinite(probe[1].finishMs) && probe[1].reasoningEndMs.length === 1, probe && JSON.stringify(probe[1]))
    ok('T33.3 探针纯观测：出站 chunk 序列不变', types(got) === 'block-start:0 reasoning-delta:0 block-start:1 block-end:0 finish', types(got))
    const econ = traces.find(([t]) => t === 'birth-econ')
    ok('T33.4 birth-econ 字段落 trace（B/R/rhoMax/bAbs/bMin/verdict）', econ && econ[1].B === raw.length && econ[1].verdict && Number.isFinite(econ[1].bAbs), econ && JSON.stringify(econ[1]))
    const cond = traces.find(([t]) => t === 'birth-condensed')
    ok('T33.5 birth-condensed 带 fidelity 观测字段（不拦截）', cond && cond[1].fidelity && typeof cond[1].fidelity.unmeasurable === 'boolean', cond && JSON.stringify(cond[1].fidelity))
  }
  // (b) 没有 reasoning 块的流：不落探针
  {
    const traces = []
    const src = [BS(0, 'text'), { type: 'text-delta', index: 0, text: 'hi' }, BE(0, { type: 'text', text: 'hi' }), FIN()]
    await collect(birthTransform(mkStream(src), { cfg: mkCfg(), trace: (t, d) => traces.push([t, d]) }))
    ok('T33.6 无 reasoning 块 ⇒ 不落 birth-window-probe', !traces.some(([t]) => t === 'birth-window-probe'))
  }
  // (c) 空白蒸馏稿绝不替换：原文逐字放行
  {
    const traces = []
    const src = [BS(0, 'reasoning'), RD(0, raw), BE(0, { type: 'reasoning', text: raw }), FIN()]
    const deps = { cfg: mkCfg({ birthMinSavedChars: -100000 }), trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's', distill: async () => ({ text: '   \n  ' }) }
    const got = await collect(birthTransform(mkStream(src), deps))
    const end = got.find((c) => c.type === 'block-end')
    ok('T33.7 ★ 空白候选 ⇒ 原文放行（即使 minSaved 放到负数也不替换）', end && end.block.text === raw)
    // 空白稿在 distillP 处已被判 'empty distillate'（第一道闸）；birthFinish 的 empty-candidate 是第二道闸。
    ok('T33.8 放行原因为 distill-failed（第一道闸）或 empty-candidate（第二道闸），二者必居其一', traces.some(([t, d]) => t === 'birth-passthrough' && (d.why === 'distill-failed' || d.why === 'empty-candidate')))
    // 直接验证第二道闸：绕过 distillP，手工构造 distillState.ok=true 且 text 为空白
    {
      const t2 = []
      const task = birthStart({ index: 0, text: raw, end: BE(0, { type: 'reasoning', text: raw }) }, { cfg: mkCfg({ birthMinSavedChars: -100000 }), trace: (t, d) => t2.push([t, d]), archive: async () => 'art://p', sessionId: () => 's', distill: async () => ({ text: SUMMARY }) })
      await Promise.all([task.diskP, task.distillP])
      task.distillState = { ok: true, text: '  \n ' }
      const r = await birthFinish(task, { cfg: mkCfg({ birthMinSavedChars: -100000 }), trace: (t, d) => t2.push([t, d]) })
      ok('T33.8b ★ 第二道闸：distillState.ok 但 text 空白 ⇒ 原文放行且 why=empty-candidate', r.text === raw && r.why === 'empty-candidate', r.why)
    }
  }
  // (d) 无受保护 token 的原文 ⇒ fidelity.unmeasurable=true（不算 pass）
  {
    const traces = []
    // rules.protectedTokens 也保护 ≥3 字的中文连串 ⇒ 构造真正无受保护 token 的文本（两字词 + 空格）
    const plain = ('好的 可以 继续 ').repeat(20)
    const deps = { cfg: mkCfg({ birthMinChars: 10 }), trace: (t, d) => traces.push([t, d]), archive: async () => 'art://p', sessionId: () => 's', distill: async () => ({ text: '短' }) }
    await collect(birthTransform(mkStream([BS(0, 'reasoning'), RD(0, plain), BE(0, { type: 'reasoning', text: plain }), FIN()]), deps))
    const cond = traces.find(([t]) => t === 'birth-condensed')
    ok('T33.9 fidelity 空集 ⇒ unmeasurable=true 且 identifierRecall=null', cond && cond[1].fidelity && cond[1].fidelity.unmeasurable === true && cond[1].fidelity.identifierRecall === null, cond && JSON.stringify(cond[1].fidelity))
  }
}

// ═══ T34 ★P0-2 句柄可归因（2026-09-24）═══
//   命题：`deriveArtHandle()` 是**内存预推**——它的正确性押在「本机推导 ≡ 兄弟包推导」上，
//         而 T13 那份等价测试在兄弟包不在本机时**整条跳过**（本机就是跳过状态）。
//         公式漂移的后果是：拿一根谁也读不回的地址去登记归档，且**不会报任何错**。
//   规则：store 回给我们的句柄 = 权威；内存预推的 = 预测，只有读回验证给出正面证据才允许当句柄用。
//         不可证（无读 API / 超时 / 抛错）⇒ 与证伪同办：当归档失败、保留原文。
{
  const raw = bulkReasoning()
  const entry = { index: 0, text: raw, end: BE(0, { type: 'reasoning', text: raw }) }
  const base = () => ({
    cfg: mkCfg(), sessionId: () => 's',
    distill: async () => ({ text: SUMMARY }),
    // 非字符串句柄 ⇒ disk.ok=true 但没有可用句柄（本机推导值沦为"预测"）
    archive: async () => ({ handle: 'art://X' }),
  })

  // (a) 没有探针可用 ⇒ 不可证 ⇒ 原文放行，绝不用预测值顶替
  {
    const traces = []
    const deps = { ...base(), trace: (t, d) => traces.push([t, d]) }
    const task = birthStart(entry, deps)
    ok('T34a 预推句柄已内存算好（快路仍在）', typeof task.handle === 'string' && task.handle.startsWith('art://'), String(task.handle))
    const r = await birthFinish(task, deps)
    ok('T34a ★ 无读回证据 ⇒ 原文放行（why=handle-unverified）', r.text === raw && r.why === 'handle-unverified', r.why)
    const un = traces.find(([t]) => t === 'birth-handle-unverified')
    ok('T34a ★ 不可证的原因落 trace（no-probe）', !!un && un[1].reason === 'no-probe', JSON.stringify(un && un[1]))
  }
  // (b) 探针正面证明能读回 ⇒ 采用预测句柄、正常应用提纯稿
  {
    const traces = []
    const seen = []
    const deps = { ...base(), trace: (t, d) => traces.push([t, d]), probeHandle: async (h, text, sid) => { seen.push([h, text.length, sid]); return true } }
    const task = birthStart(entry, deps)
    const r = await birthFinish(task, deps)
    ok('T34b ★ 读回验证通过 ⇒ 采用预测句柄（提纯稿生效）', r.text === SUMMARY, String(r.text).slice(0, 60))
    ok('T34b ★ 探针拿到的是「句柄 + 原文 + 会话」三件套', seen.length === 1 && seen[0][0] === task.handle && seen[0][1] === raw.length && seen[0][2] === 's', JSON.stringify(seen))
    const src = traces.find(([t]) => t === 'birth-handle-source')
    ok('T34b ★ 句柄来源可归因（derived-verified）', src && src[1].source === 'derived-verified', JSON.stringify(src && src[1]))
  }
  // (c) 探针正面证伪 ⇒ 原文放行
  {
    const traces = []
    const deps = { ...base(), trace: (t, d) => traces.push([t, d]), probeHandle: async () => false }
    const task = birthStart(entry, deps)
    const r = await birthFinish(task, deps)
    ok('T34c ★ 读回取不到 ⇒ 原文放行', r.text === raw && r.why === 'handle-unverified', r.why)
    const un = traces.find(([t]) => t === 'birth-handle-unverified')
    ok('T34c ★ 证伪原因落 trace（probe-unresolvable）', un && un[1].reason === 'probe-unresolvable', JSON.stringify(un && un[1]))
  }
  // (d) 探针卡死 ⇒ 超时护栏（不可证），绝不许拖死模型流
  {
    const deps = { ...base(), cfg: mkCfg({ birthHandleProbeTimeoutMs: 30 }), trace: noTrace, probeHandle: () => new Promise(() => {}) }
    const task = birthStart(entry, deps)
    const t0 = Date.now()
    const r = await birthFinish(task, deps)
    const ms = Date.now() - t0
    ok('T34d ★ 探针挂起 ⇒ 超时即判不可证（<400ms 返回）', ms < 400 && r.text === raw, ms + 'ms / why=' + r.why)
  }
  // (e) store 给了真句柄 ⇒ 权威优先，根本不调探针（不给主流加延迟）
  {
    let probeCalls = 0
    const deps = { ...base(), trace: noTrace, archive: async () => 'art://REAL34', probeHandle: async () => { probeCalls++; return true } }
    const task = birthStart(entry, deps)
    const r = await birthFinish(task, deps)
    ok('T34e ★ store 句柄优先 ⇒ 提纯稿生效且零探针调用', r.text === SUMMARY && probeCalls === 0, 'probeCalls=' + probeCalls)
  }
}

console.log('')
console.log('birth.selftest: PASS=' + pass + ' FAIL=' + failn + (skipn ? ' SKIP=' + skipn : '') +
  (invariantLoaded ? '  (结构由真实 dsh-llm 不变式校验' : '  (⚠ 不变式未加载') +
  (BA ? ' + 真实 BlockAssembler 装配)' : ' + 替身装配)'))
if (failn > 0) { console.log('失败项: ' + fails.join(' | ')); process.exit(1) }
