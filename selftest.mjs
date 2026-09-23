// dsh-cot-form-b 自测 —— 纯本地，零网络、零会话、零 API 调用。
// 目标：把金丝雀抓出的两个 bug 和它们的边界钉死，防止回归。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  DEFAULTS, buildDistillPrompt, sliceVerbatim, messageOfEvent, textOfContent,
  findLastUserMessage, findLastUserText, assembleCheckpoint, passesHurdle,
  reasoningTextOf, toolCallsOf, rebuildContent, findLastAssistantEvent,
  breakevenRaw, FIT, apply, normalizeConfig, requestOnce, generateDistillation,
  detectResponseProtocol, assembleSseFrames, collectSseFrames, extractFromJsonBody, requestStream,
  pushLateMemory, takeLateMemory, peekLateMemory, lateMemorySize,
  coverWatermarkOf, coverSnapshotOk, markCovered, coverVersionOf,
} from './index.js'
import { compressByRules, fidelity, protectedTokens } from './rules.js'
import { runPreStepEmit } from './emitter.js'
import { adaptEvidence } from './state-memory.js'

// 本进程独占的临时目录：固定文件名会让并发跑多个 selftest 时互相读到对方写的
// trace / credentials，产生假失败（外审 R-1 复现：并发时 204/0 与 203/1 并存）。
// 注意：某些受限环境里 TMPDIR/TEMP 缺失会让 os.tmpdir() 返回 "undefined\temp"，故做回退。
function selftestTmpRoot() {
  const cands = [os.tmpdir(), process.env.TEMP, process.env.TMP, path.join(process.cwd(), ".cot-form-b-selftest-tmp")]
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue
    try { fs.mkdirSync(c, { recursive: true }); return c } catch { /* 试下一个 */ }
  }
  throw new Error("selftest: 找不到可写的临时目录")
}
const SELFTEST_TMP = fs.mkdtempSync(path.join(selftestTmpRoot(), "cot-form-b-selftest-"))
process.on("exit", () => { try { fs.rmSync(SELFTEST_TMP, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })
const tmpFile = (name) => path.join(SELFTEST_TMP, name)

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   → ' + JSON.stringify(extra) : '')) }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want }) }

const cfg = { hurdleRounds: 4, templateChars: 500 }

console.log('\n【1】buildDistillPrompt —— 契约焊死')
{
  const p = buildDistillPrompt('X')
  ok('含【已归档决策】', p.includes('【已归档决策】'))
  ok('含【已否决分支·不可重开】', p.includes('【已否决分支·不可重开】'))
  ok('含【已证伪路径·归档】', p.includes('【已证伪路径·归档】'))
  // ★ 防伪造引用：模板里不得把【用户原话…】定义成一个要模型填的栏。
  //   注意断言的是「栏头」，不是「用户原话」四个字 —— 正文里出现这四个字不算违规。
  ok('★ 未把【用户原话】定义为必需栏', !p.includes('【用户原话'))
  ok('★ 含"用中文输出"（正面防线，治脑补翻译）', p.includes('用中文输出'))
  ok('★ 不含【已执行的工具调用】栏（已删）', !p.includes('已执行的工具调用'))
  ok('含"整栏省略"负向指令', p.includes('整栏省略'))
  ok('含硬语气禁令（建议/备选/可以考虑）', p.includes('建议') && p.includes('备选') && p.includes('可以考虑'))
  ok('结尾带上思维链', p.endsWith('X'))
  // 栏头集合必须**正好**是这三栏 + 结尾的输入标签，多一栏都不行
  const heads = (p.match(/^【[^】]*】/gm) || []).sort()
  eq('★ 栏头集合精确等于三态 + 输入标签', heads, ['【上一轮思维链】', '【已否决分支·不可重开】', '【已归档决策】', '【已证伪路径·归档】'].sort())
  ok('每个状态栏各出现一次', heads.filter((h) => h !== '【上一轮思维链】').length === 3)
}

console.log('\n【2】sliceVerbatim —— 超长截断（复测里从未触发的边界）')
{
  const short = 'a'.repeat(100)
  eq('未超限原样返回', sliceVerbatim(short, 600), short)

  const exact = 'b'.repeat(600)
  eq('正好等于上限原样返回', sliceVerbatim(exact, 600), exact)

  const long = 'H'.repeat(400) + 'M'.repeat(400) + 'T'.repeat(400) // 1200
  const out = sliceVerbatim(long, 600)
  ok('超限后长度 = 上限 + 省略标记', out.length === 600 + '\n…（原话过长，中间省略）…\n'.length, out.length)
  ok('★ 保留了开头', out.startsWith('H'.repeat(10)))
  ok('★ 保留了结尾（约束通常在最后）', out.endsWith('T'.repeat(10)))
  ok('中间被省略', out.includes('原话过长，中间省略'))
  const headKept = out.split('\n…')[0].length
  eq('头 60% = 360', headKept, 360)
}

console.log('\n【3】messageOfEvent —— 实测形状差异（bug 根因 1）')
{
  const assistantEv = { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [] } } }
  eq('assistant：取 data.message', messageOfEvent(assistantEv).role, 'assistant')

  // ★ user/message 没有 data.message，字段平铺在 data 上
  const userEv = { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' }, id: 'x' } }
  eq('user：平铺在 data 上也能取到', messageOfEvent(userEv).role, 'user')
  ok('user 事件确实没有 data.message', userEv.data.message === undefined)
  eq('data 为空返回 null', messageOfEvent({ type: 'x', data: null }), null)
}

console.log('\n【4】textOfContent —— content 双兼容（bug 根因 3）')
{
  eq('纯字符串', textOfContent('hello'), 'hello')
  eq('块数组', textOfContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  eq('混合数组', textOfContent(['a', { text: 'b' }]), 'a\nb')
  eq('非文本块被跳过', textOfContent([{ type: 'tool-call', name: 'x' }, { type: 'text', text: 'k' }]), 'k')
  eq('非数组非字符串', textOfContent({}), '')
  eq('undefined', textOfContent(undefined), '')
}

console.log('\n【5】findLastUserMessage —— 必须挑中人类消息（bug 根因 2）')
{
  const log = [
    { seq: 7, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '真·用户任务' }], source: { kind: 'user' } } },
    { seq: 8, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '系统注入：运行时上下文' }], source: { kind: 'plugin', plugin: 'dsh-system-prompt' } } },
    { seq: 9, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '系统注入：skill 目录' }], source: { kind: 'skill-catalog' } } },
    { seq: 100, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
  ]
  const hit = findLastUserMessage(log, 100)
  eq('★ 挑中 seq=7（人类），而非 seq=9（skill-catalog）', hit.seq, 7)
  eq('kind = user', hit.kind, 'user')
  eq('文本逐字', hit.text, '真·用户任务')
  eq('findLastUserText 代理一致', findLastUserText(log, 100), '真·用户任务')

  // beforeSeq 过滤：目标之前
  eq('目标 seq=8 时只能看到 seq=7', findLastUserMessage(log, 8).seq, 7)
  eq('目标 seq=7 时看不到任何人类消息', findLastUserMessage(log, 7), null)

  // 全无 source.kind 时走宽松档（仍排除已知系统来源）
  const noKind = [
    { seq: 5, type: 'user/message', data: { role: 'user', content: '旧格式无 source' } },
  ]
  eq('宽松档兜底', findLastUserMessage(noKind, 100).text, '旧格式无 source')

  // 宽松档也要排除系统来源
  const onlySystem = [
    { seq: 5, type: 'user/message', data: { role: 'user', content: '注入', source: { kind: 'plugin' } } },
  ]
  eq('★ 只有系统消息时返回 null（宁可不注入）', findLastUserMessage(onlySystem, 100), null)
}

console.log('\n【6】passesHurdle —— 保本后验不等式（含我加的补丁）')
{
  // 反例：raw=5000 / final=4900 —— 旧的「防增肥」会放行，实际净亏
  const bad = passesHurdle(5000, 4900, cfg)
  ok('★ 5000→4900 必须被拦（微量节约陷阱）', bad.pass === false, bad)
  eq('  saved = 100', bad.saved, 100)
  eq('  lhs = 100×4', bad.lhs, 400)
  eq('  rhs = 500+5000+4900', bad.rhs, 10400)

  // 增肥：final >= raw
  ok('final == raw 被拦', passesHurdle(1000, 1000, cfg).pass === false)
  ok('final > raw 被拦', passesHurdle(1000, 1200, cfg).pass === false)

  // 实测样本必须通过
  const s1 = passesHurdle(1871, 566, cfg) // 金丝雀 n=2
  ok('★ 实测 1871→566 通过', s1.pass === true, s1)
  const s2 = passesHurdle(2745, 513, cfg) // 金丝雀 n=3
  ok('★ 实测 2745→513 通过', s2.pass === true, s2)
  const s3 = passesHurdle(1187, 184, cfg) // runC n=2
  ok('★ 实测 1187→184 通过', s3.pass === true, s3)

  // 临界：raw=800（门槛）配拟合比例 0.26*800+163 = 371
  const edge = passesHurdle(800, 371, cfg)
  ok('★ 临界 raw=800 恰好通过（验证 800 门槛自洽）', edge.pass === true, edge)
  const below = passesHurdle(774, 364, cfg)
  console.log('    （参考）raw=774 →', JSON.stringify(below))
}

console.log('\n【7】rebuildContent —— tool-call / text 必须原样保活')
{
  const orig = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'OLD_COT' },
      { type: 'text', text: '最终答复' },
      { type: 'tool-call', name: 'write', input: { file_path: 'a.txt' } },
      { type: 'tool-call', name: 'read', input: { file_path: 'a.txt' } },
    ],
  }
  const out = rebuildContent(orig, 'NEW_CHECKPOINT')
  eq('新 reasoning 置顶', out[0], { type: 'reasoning', text: 'NEW_CHECKPOINT' })
  eq('块数不变', out.length, 4)
  eq('text 保活', out[1], { type: 'text', text: '最终答复' })
  eq('tool-call#1 保活', out[2].name, 'write')
  eq('tool-call#2 保活', out[3].name, 'read')
  ok('★ 旧 reasoning 已被替换掉', !JSON.stringify(out).includes('OLD_COT'))
  ok('★ 原对象未被就地修改', orig.content[0].text === 'OLD_COT')
  eq('role 未变', orig.role, 'assistant')
}

console.log('\n【8】assembleCheckpoint —— 注入与不注入')
{
  const a = assembleCheckpoint('【已定决策】做事。', '用户原话')
  ok('含机械注入声明', a.includes('机械注入'))
  ok('含用户原话', a.includes('用户原话'))
  ok('含模型产出', a.includes('【已定决策】做事。'))
  ok('原话在前、模型产出在后', a.indexOf('用户原话') < a.indexOf('【已定决策】做事。'))

  const b = assembleCheckpoint('【已定决策】做事。', '')
  eq('无原话时只剩模型产出', b, '【已定决策】做事。')
  const c = assembleCheckpoint('【已定决策】做事。', '   ')
  eq('空白原话同样被丢弃', c, '【已定决策】做事。')
}

console.log('\n【9】消息抽取工具')
{
  const m = { role: 'assistant', content: [{ type: 'reasoning', text: 'abc' }, { type: 'reasoning', text: 'de' }, { type: 'tool-call', name: 'w' }] }
  eq('reasoning 多块拼接', reasoningTextOf(m), 'abc\nde')
  eq('toolCallsOf 只取 tool-call', toolCallsOf(m).length, 1)
  eq('无 content 返回空', reasoningTextOf({ role: 'assistant' }), '')

  const log = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [] } } },
    { seq: 2, type: 'tool/result', data: {} },
    { seq: 3, type: 'assistant/message', data: { message: { content: [] } } },
  ]
  eq('findLastAssistantEvent 取最后一条', findLastAssistantEvent(log).seq, 3)
  eq('无 assistant 时返回 null', findLastAssistantEvent([{ seq: 1, type: 'tool/result' }]), null)
}

console.log('\n【10】默认值 —— 安全默认 + 延迟预算')
{
  eq('★ dryRun 默认 true（防带电裸奔）', DEFAULTS.dryRun, true)
  eq('门槛 800', DEFAULTS.minRawChars, 800)
  eq('保本轮数 4', DEFAULTS.hurdleRounds, 4)
  eq('模板量级 500', DEFAULTS.templateChars, 500)
  // ★ 延迟回归锁：实测中位 5.4s / 最差 20.0s，180000 是灾难性配置，绝不许改回去
  eq('★ 超时预算 8 秒（不是 180 秒）', DEFAULTS.timeoutMs, 8000)
  eq('★ 重试 1 次（不是 4 次）', DEFAULTS.maxAttempts, 1)
  ok('★ 凭据路径带前导点（.credentials.yaml）', DEFAULTS.credentialsPath.endsWith('/.credentials.yaml'), DEFAULTS.credentialsPath)
  // ★ 不许再引入「延迟替换」相关开关：块一旦出站就永不可改（H2）。
  ok('★ 不含 deferApply（延迟替换已被终审否决）', !('deferApply' in DEFAULTS))
  ok('★ 不含 maxInflight（同上，属延迟路径）', !('maxInflight' in DEFAULTS))
  // ★ 三级模式 + 延迟预算
  eq('★ mode 默认 distill', DEFAULTS.mode, 'distill')
  eq('★ earlyFire 默认 true（提前发起，非阻塞）', DEFAULTS.earlyFire, true)
  eq('★ graceMs 默认 300（= 用户感知延迟上限）', DEFAULTS.graceMs, 300)
  eq('★ 规则兜底默认开', DEFAULTS.rulesEnabled, true)
  // ⛔ 2026-09-17 事故修正：原来的 `rulesMinSavingPct: 10` 是个**奖励暴力的逆向淘汰闸**
  //   —— 只有删得够狠的方案才准过线，100% 保真的精细去重反被判 no-gain。
  eq('★ 新判据：净省 20 字符即放行（与百分比解耦）', DEFAULTS.rulesMinSavedChars, 20)
  eq('★ 归档前置闸默认开（约束⑤ 先存后压）', DEFAULTS.rulesRequireArchive, true)
  ok('⛔ 反向淘汰闸 rulesMinSavingPct 必须已从 DEFAULTS 移除', !('rulesMinSavingPct' in DEFAULTS),
    Object.keys(DEFAULTS).filter((k) => /SavingPct/.test(k)))
}

console.log('\n【10.1】配置归一化 —— 必须能吃下用户文档里的嵌套写法')
{
  const a = normalizeConfig({ mode: 'rules', distill: { timeoutMs: 3000, minRawChars: 1200, hurdleRounds: 5, maxVerbatimChars: 400 } })
  eq('嵌套 distill.timeoutMs 覆盖扁平键', a.timeoutMs, 3000)
  eq('嵌套 distill.minRawChars', a.minRawChars, 1200)
  eq('嵌套 distill.hurdleRounds', a.hurdleRounds, 5)
  eq('嵌套 distill.maxVerbatimChars', a.maxVerbatimChars, 400)
  eq('mode 透传', a.mode, 'rules')
  eq('未覆盖的键保持默认（templateChars）', a.templateChars, 500)

  const b = normalizeConfig({ rules: { foldRuns: false, dropDuplicateLines: false, minSavedChars: 64, requireArchive: false } })
  eq('rules.foldRuns', b.rulesFoldRuns, false)
  eq('rules.dropDuplicateLines', b.rulesDropDuplicateLines, false)
  eq('rules.minSavedChars', b.rulesMinSavedChars, 64)
  eq('rules.requireArchive', b.rulesRequireArchive, false)
  // @deprecated：旧百分比键仍可被配置，但只落成提醒字段，不参与任何决策。
  const dp = normalizeConfig({ rules: { minSavingPct: 25 } })
  eq('rules.minSavingPct 已降级为提醒字段', dp.rulesMinSavingPctDeprecated, 25)
  ok('★ 且它不再影响任何放行决策', normalizeConfig({ rules: { minSavingPct: 25 } }).rulesMinSavedChars === 20)

  eq('★ 非法 mode 回落到 distill（绝不带电裸奔）', normalizeConfig({ mode: 'nonsense' }).mode, 'distill')
  eq('★ 空配置就是默认值', normalizeConfig().mode, 'distill')
}

console.log('\n【11】门槛推导 —— 保本反解与代数自洽')
{
  eq('FIT.a = 0.26', FIT.a, 0.26)
  eq('FIT.b = 163', FIT.b, 163)
  eq('★ breakevenRaw(4) = 774（复现原推导）', breakevenRaw(4, { templateChars: 500 }), 774)
  ok('★ H≤1.7 时无解（Infinity）', breakevenRaw(1, { templateChars: 500 }) === Infinity)

  // 反解出来的 774 必须**真的**刚好通过（floor+1 的用意：ceil 会在整除时给出一个恰好不通过的数）
  const at774 = passesHurdle(774, 364, { hurdleRounds: 4, templateChars: 500 })
  ok('★ breakevenRaw(4)=774 恰好通过（与历史结论一致）', at774.pass === true, at774)
  const below774 = passesHurdle(773, 364, { hurdleRounds: 4, templateChars: 500 })
  ok('★ 773 恰好不通过（临界点没错位）', below774.pass === false, below774)

  // ★ 门槛必须 ≥ 保本原长：防止以后有人手改 minRawChars 而不同步改轮数
  const be = breakevenRaw(DEFAULTS.hurdleRounds, DEFAULTS)
  ok('★ minRawChars(800) ≥ breakevenRaw(' + DEFAULTS.hurdleRounds + ')=' + be, DEFAULTS.minRawChars >= be, { minRawChars: DEFAULTS.minRawChars, be })

  // 参考值：延迟替换（已否决）所需门槛。留着是为了让以后想重提的人先看到代价。
  eq('（参考）breakevenRaw(3) = 1201（延迟替换所需门槛，已否决）', breakevenRaw(3, { templateChars: 500 }), 1201)
  const at1200 = passesHurdle(1200, 475, { hurdleRounds: 3, templateChars: 500 })
  ok('（参考）H=3 时 1200 恰好不通过', at1200.pass === false, at1200)
}

console.log('\n【12】★ H2 首次出站不变律 —— 块只允许被处理一次（纯本地，零网络）')
{
  const tmp = tmpFile('trace.log')
  try { fs.unlinkSync(tmp) } catch { /* first run */ }

  let handler = null
  const ctx = { on: (n2, fn) => { if (n2 === 'agent/pre-step') handler = fn } }
  const mkAev = (seq) => ({
    seq, type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'x'.repeat(10) }] } },
  })
  const log = [mkAev(42)]
  const appended = []
  const session = { log, append: (...a) => { appended.push(a); return { seq: 999 } } }

  // ⛔ prewarm:false —— 自测必须零网络。开着它会往真实网关发 HEAD（虽然零 token）。
  apply(ctx, { trace: true, traceFile: tmp, dryRun: false, minRawChars: 800, prewarm: false })
  ok('handler 已注册', typeof handler === 'function')

  // 第 1 次：块 42 低于门槛 → 拦下，但**这一步之后它就已经出站了**
  await handler({ agent: { session } }, async () => ({}))
  // 第 2 次：同一个块再出现 → 必须被 H2 硬闸拦住，不许重试、更不许事后改写
  await handler({ agent: { session } }, async () => ({}))

  const t = fs.readFileSync(tmp, 'utf8')
  ok('第 1 次：低于门槛被拦（skip-below-threshold）', t.includes('skip-below-threshold'))
  ok('★ 第 2 次：被 H2 硬闸拦下（skip-locked-already-sent）', t.includes('skip-locked-already-sent'))
  eq('★ 全程零 append —— 已出站的块绝无任何事后改写', appended.length, 0)

  // 新块必须不被旧锁影响
  log.push(mkAev(43))
  await handler({ agent: { session } }, async () => ({}))
  const t2 = fs.readFileSync(tmp, 'utf8')
  eq('★ 新块（seq=43）照常被处理，未被旧锁误伤', (t2.match(/skip-below-threshold/g) || []).length, 2)
  eq('★ 且仍然零 append', appended.length, 0)
}

console.log('\n【13】纯规则引擎 —— 永不增肥 / 逐字重复行 / 游程折叠（纯本地，零网络）')
{
  // ① 空输入
  const e0 = compressByRules('')
  eq('空输入原样返回', e0.out, '')
  eq('空输入标记 skipped', e0.stats.skipped, 'empty')

  // ② ★ 永不增肥：任何路径都不允许把输出做得比输入还长
  const tricky = 'Alpha one. Bravo two. Charlie three. Delta four.'
  const r2 = compressByRules(tricky)
  ok('★ 永不增肥：输出长度 ≤ 输入长度', r2.out.length <= tricky.length, { in: tricky.length, out: r2.out.length })
  ok('★ 没赚到就原样返回（noGain）', r2.out === tricky && r2.stats.noGain === true, r2.stats)

  // ③ 逐字重复行（唯一一条信息论恒等的规则）
  const dup = ['KEEP_THIS_LINE_AAAA', 'x', 'KEEP_THIS_LINE_AAAA', 'y'].join('\n')
  const r3 = compressByRules(dup, { foldRuns: false })
  eq('★ 逐字重复行只留第一次', (r3.out.match(/KEEP_THIS_LINE_AAAA/g) || []).length, 1)
  eq('  计数正确', r3.stats.dupLinesDropped, 1)

  // ④ 游程折叠：连续 ≥3 行同构「已验证 OK」⇒ 只折公共前后缀，变体一个不许丢
  const ok3 = ['✓ alpha module verified', '✓ beta module verified', '✓ gamma module verified', 'tail line'].join('\n')
  const r4 = compressByRules(ok3, { dropDuplicateLines: false })
  ok('★ 连续 3 行 OK 被折叠', r4.out.includes('同构「已验证通过」共 3 行'), r4.out)
  ok('★ 折叠后确实更短', r4.out.length < ok3.length, { in: ok3.length, out: r4.out.length })
  eq('  折叠计数 = 2（run 3 → 1 行 + 断言行）', r4.stats.okRunsFolded, 2)
  ok('★ 变体逐个列全、绝不许切词（beta / gamma 必须完整）', r4.out.includes('beta / gamma'), r4.out)
  ok('★ 折叠后受保护 token 一个不丢', r4.stats.lostTokens === 0 && r4.stats.tokenRecall === 100, r4.stats)

  // ④b 数字连续变体 ⇒ 用区间断言代替列表（用户点名的形态 [§0-§14: 18 items]）
  const num4 = ['✓ §1 verified', '✓ §2 verified', '✓ §3 verified', '✓ §4 verified', 'tail'].join('\n')
  const r4b = compressByRules(num4, { dropDuplicateLines: false })
  ok('★ 连续数字变体折成区间断言', r4b.out.includes('序列 1–4'), r4b.out)
  ok('★ 区间端点与计数都还在', r4b.out.includes('共 4 行'), r4b.out)
  ok('★ 区间折叠必须保真（允许丢的是可推导的中间数字）', r4b.stats.lostTokens === 0 && r4b.stats.tokenRecall === 100, r4b.stats)

  // ④c 非连续数字 ⇒ 不折（中间值推不出来，不许猜）
  const num4c = ['✓ item 3 ok', '✓ item 7 ok', '✓ item 9 ok', 'tail'].join('\n')
  const r4c = compressByRules(num4c, { dropDuplicateLines: false })
  ok('★ 非连续数字变体不折叠（不认识的形态一律保留）', !r4c.out.includes('序列'), r4c.out)

  // ⑤ ★ 实体保活：折叠可以折，但标识符一个都不许丢
  const risky = ['✓ `rare_alpha_x` ok', '✓ `rare_beta_y` ok', '✓ `rare_gamma_z` ok'].join('\n')
  const r5 = compressByRules(risky, { dropDuplicateLines: false })
  for (const id of ['rare_alpha_x', 'rare_beta_y', 'rare_gamma_z']) {
    ok('★ 折叠不许丢标识符 ' + id, r5.out.includes(id), r5.out)
  }
  ok('★ 交付出去的文本必须 100% 保真', r5.stats.tokenRecall === 100 && r5.stats.lostTokens === 0, r5.stats)
  ok('★ 若折叠会拆断 token，门禁必须拒发并退回原文（不丢信息优先于省字）',
    !r5.stats.refused || (r5.out === risky && r5.stats.candidateLostTokens > 0), r5.stats)
  ok('★ 拒发时交付的就是原文', r5.stats.refused ? r5.out === risky : true, r5.out)

  // ⑥ ⛔ 事故回归：逆向支配剪枝已被连根拔除。
  //    2026-09-16 生产事故：`Let me write.` 被当成「结论」，把它之前的全部
  //    斟酌与事实一刀切掉（1017→145 字符，5 个事实全灭，关键 token 召回 0/3）。
  //    下面每一句都必须原样存活。
  const cot = [
    'Let me explore the deploy directory first.',
    'Consider whether the cache is warm.',
    'The raw CoT was 3330 chars and the final message is 722 chars.',
    'The handle art://abc123 was archived first, in 4ms, with zero API calls.',
    'However, do not touch the production profile.',
    'Let me write the final message.',
    'Let me write.',
  ].join('\n')
  const r6 = compressByRules(cot)
  ok('⛔ 事故回归：ACTION 之前的斟酌句必须原样存活', r6.out.includes('Consider whether the cache is warm'), r6.out)
  ok('⛔ 事故回归：ACTION 之前的数字事实必须原样存活', r6.out.includes('3330 chars and the final message is 722 chars'), r6.out)
  ok('⛔ 事故回归：句柄 / 4ms / zero API calls 必须原样存活',
    r6.out.includes('art://abc123') && r6.out.includes('4ms') && r6.out.includes('zero API calls'), r6.out)
  ok('⛔ 事故回归：负向约束句必须存活', r6.out.includes('do not touch the production profile'), r6.out)
  ok('⛔ 事故回归：没有可去重可折叠的内容时，输出必须逐字等于原文', r6.out === cot, { in: cot.length, out: r6.out.length })
  ok('⛔ 事故回归：角色裁判已下线（不再有任何「被支配」的删除理由）', r6.stats.lostTokens === 0 && r6.stats.tokenRecall === 100, r6.stats)

  // ⑦ 中文：角色规则已下线，中文块按同一条法处理（只去重/折叠，不判价值）
  const zh = '决定先跑探针。然后检查缓存。'
  const r7 = compressByRules(zh)
  eq('  中文块 rawChars 记录正确', r7.stats.rawChars, zh.length)
  ok('★ 中文块不增肥', r7.out.length <= zh.length, { in: zh.length, out: r7.out.length })
  ok('★ 中文块没有任何内容被删（已无角色裁判）', r7.out === zh, r7.out)

  // ⑧ ★ 保真度门禁负控制：门禁必须能识别「真的丢了」
  const fLost = fidelity('The handle art://abc123 and 3350 bytes', 'nothing here')
  ok('★ 门禁负控制：真丢了就必须报出来', fLost.lost.length >= 2 && fLost.stats.tokenRecall < 100, fLost.stats)
  const fKept = fidelity('The handle art://abc123 and 3350 bytes', 'The handle art://abc123 and 3350 bytes')
  ok('★ 门禁负控制：没丢就一个都不许报', fKept.lost.length === 0 && fKept.stats.tokenRecall === 100, fKept.stats)
  const gh = protectedTokens('art://cq3G49xaZTkgaIvm1XKCoG sha256 97e6b887')
  ok('★ 门禁不误解：句柄内部的数字不单独算 token（曾经的假阳性来源）', !gh.has('49') && !gh.has('3'), [...gh])
  const gh2 = protectedTokens('art://abc123 and 3350 bytes in 4ms')
  ok('★ 门禁不误解：全小写句柄与数字/单位必须被抓到', gh2.has('art://abc123') && gh2.has('3350 bytes') && gh2.has('4ms'), [...gh2])

  // ⑨ ★ 保真不变量（性质测试）：任何输入、任何路径，都不许丢失受保护 token
  for (const probe of [ok3, num4, num4c, risky, cot, zh, dup, tricky]) {
    const rp = compressByRules(probe)
    ok('★ 保真不变量：交付出去的文本永远不许丢受保护 token', rp.stats.lostTokens === 0 && rp.stats.tokenRecall === 100,
      { recall: rp.stats.tokenRecall, bad: rp.stats.candidateLostSample, refused: rp.stats.refused })
  }
}

// ──【14】传输层：requestOnce（本地 http server，零外网、零 API）──────────────
console.log('\n【14】传输层 requestOnce —— keep-alive / 超时 / 状态码（本地 server）')
{
  let conns = 0
  const srv = http.createServer((q, s) => {
    if (q.url === '/slow') { setTimeout(() => { try { s.writeHead(200); s.end('late') } catch {} }, 3000); return }
    if (q.url === '/bad') { s.writeHead(500); s.end('boom'); return }
    s.writeHead(200, { 'Content-Type': 'application/json' })
    s.end('{"ok":true}')
  })
  srv.on('connection', () => { conns++ })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  const tcfg = normalizeConfig({ keepAlive: true, keepAliveMsecs: 60000 })

  const r1 = await requestOnce(base + '/ok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', cfg: tcfg })
  eq('  200 被如实读出', r1.status, 200)
  ok('  body 完整', r1.text === '{"ok":true}', r1.text)
  ok('  meta.ttfbMs 是数字', typeof r1.meta.ttfbMs === 'number' && r1.meta.ttfbMs >= 0, r1.meta)
  eq('  meta.bytes = 响应字节数', r1.meta.bytes, r1.text.length)

  const before2 = conns
  const r2 = await requestOnce(base + '/ok', { method: 'POST', body: '{}', cfg: tcfg })
  eq('★ 第二次请求没有新建 TCP 连接（keep-alive 生效）', conns - before2, 0)
  ok('★ req.reusedSocket 第二次为 true（可落 trace 的复用证据）', r2.meta.reused === true, r2.meta)

  const r3 = await requestOnce(base + '/bad', { cfg: tcfg })
  eq('  非 200 状态码如实返回（不抛错）', r3.status, 500)
  ok('  错误响应体被读回', r3.text === 'boom', r3.text)

  let timedOut = false
  try { await requestOnce(base + '/slow', { timeoutMs: 300, cfg: tcfg }) }
  catch (e) { timedOut = /timeout/.test(String((e && e.message) || e)) }
  ok('★ 总超时生效（整通请求硬上限，不是 idle 超时）', timedOut)

  let badUrl = false
  try { await requestOnce('not a url', {}) } catch { badUrl = true }
  ok('  非法 URL 直接 reject，不挂起', badUrl)

  try { srv.close() } catch {}
}

// ──【15】传输层配置项（嵌套 distill: 写法）──────────────────────────────────
console.log('\n【15】传输层配置项 —— 嵌套写法与默认值')
{
  const c = normalizeConfig({ distill: { keepAlive: false, prewarm: false, prewarmMinGapMs: 1234, keepAliveMsecs: 5000, followHostModel: false, disableThinking: false, model: 'M1' } })
  eq('  distill.keepAlive 被吃下', c.keepAlive, false)
  eq('  distill.prewarm 被吃下', c.prewarm, false)
  eq('  distill.prewarmMinGapMs 被吃下', c.prewarmMinGapMs, 1234)
  eq('  distill.keepAliveMsecs 被吃下', c.keepAliveMsecs, 5000)
  eq('  distill.followHostModel 被吃下', c.followHostModel, false)
  eq('  distill.disableThinking 被吃下', c.disableThinking, false)
  eq('  distill.model 被吃下', c.model, 'M1')
  const d = normalizeConfig({})
  eq('  默认 keepAlive = true', d.keepAlive, true)
  // ★ 2026-09-21 翻转：三组对照实测（deploy/probe/_probe-prewarm-3way.mjs）
  //   按【预热启动 → 蒸馏完成】的总时间：none p50=1827ms < new p50=2082ms < old p50=2408ms。
  //   新路径确实修好了复用（3/3 vs 0/3），但 HEAD 自身要 344~1002ms，省下的建连没被省回来。
  //   ⇒ 默认关闭；连接复用改由正常业务流量自然维持。
  eq('  默认 prewarm = false（三组对照：预热总时间反而更慢）', d.prewarm, false)
  eq('  默认 distillStream = false（流式必须显式打开）', d.distillStream, false)
  eq('  默认 keepAliveMsecs = 60000', d.keepAliveMsecs, 60000)
  eq('  默认 prewarmMinGapMs = 20000', d.prewarmMinGapMs, 20000)
  eq('  默认 followHostModel = true', d.followHostModel, true)
  eq('  默认 disableThinking = true', d.disableThinking, true)
  eq('  默认 model = ""（不写死模型名）', d.model, '')
  // ⚠ 认知等级：keepAlive 只对「进程内第 2 次及以后」的调用有效；
  //    实测那 3,882ms 是进程内第一次调用 ⇒ 单靠 keepAlive 省 0ms，必须配 prewarm。
  ok('★ 注释里写死了「第一次调用永远是冷的」这条限定', true)
}

// ──【16】generateDistillation —— 空提纯稿必须报出真因（本地 server，零外网）──
console.log('\n【16】generateDistillation —— 空提纯稿的真因必须可诊断（本地 server）')
{
  eq('★ 代码默认不写死任何模型名（跟随宿主对话模型；写死的名字身份不可核实）',
    DEFAULTS.model, '')
  eq('  默认 followHostModel = true', DEFAULTS.followHostModel, true)
  eq('  默认 disableThinking = true（不关思考 ⇒ content 空串 + 白等 7~19 秒）',
    DEFAULTS.disableThinking, true)

  const cred = tmpFile('credentials.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_ZZ: sk-selftest\n')
  let mode = 'ok'
  let seen = null // 最近一次请求的 payload，用来验证 thinking 参数真的发出去了
  const srv = http.createServer((q, s) => {
    const send = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)) }
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      try { seen = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { seen = null }
      if (mode === 'ok') return send({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】x' } }] })
      if (mode === 'thinking') return send({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'y'.repeat(500) } }] })
      if (mode === 'nochoices') return send({ error: { message: 'bad' } })
      s.writeHead(500); s.end('boom')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const gcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ',
    maxAttempts: 1, timeoutMs: 3000, keepAlive: true,
    // ⛔ 显式给模型：DEFAULTS.model 现在是空串（跟随宿主），空串会直接抛 no model
    model: 'test-model-1',
  })

  // ⛔ 不猜模型：cfg.model 为空 ⇒ 必须抛 no model（上层据此降级 rules）
  let e0 = ''
  try { await generateDistillation('hello', normalizeConfig({ model: '' })) } catch (e) { e0 = String((e && e.message) || e) }
  ok('★ cfg.model 为空 → 抛 no model（绝不猜模型名）', /^no model:/.test(e0), e0)

  const g1 = await generateDistillation('hello', gcfg)
  eq('  正常响应 → text 被取出', g1.text, '【已定决策】x')
  eq('  meta.finish 被带回（可落 trace）', g1.meta.finish, 'stop')
  eq('  meta.model = 本次实际用的模型', g1.meta.model, 'test-model-1')
  eq('★ disableThinking 时 payload 带 thinking={type:disabled}', JSON.stringify(seen.thinking), '{"type":"disabled"}')
  eq('★ 并且 thinkingOff=true 落进 meta', g1.meta.thinkingOff, true)
  eq('  max_tokens 用的是 maxOutputTokens', seen.max_tokens, gcfg.maxOutputTokens)
  eq('  temperature = 0（提纯要确定性）', seen.temperature, 0)

  mode = 'thinking'
  let e2 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e2 = String((e && e.message) || e) }
  ok('★ 思考型吐空 content → 错误必须带 finish=length', /empty distillate \(finish=length/.test(e2), e2)
  ok('★ 并且带 reasoningChars（一眼看出 token 被思考吃掉）', /reasoningChars=500/.test(e2), e2)

  mode = 'nochoices'
  let e3 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e3 = String((e && e.message) || e) }
  ok('★ 网关返回非 completion 结构 → 报 no choices', /no choices/.test(e3), e3)

  mode = 'http500'
  let e4 = ''
  try { await generateDistillation('hello', gcfg) } catch (e) { e4 = String((e && e.message) || e) }
  ok('  非 200 → 报 http 500', /http 500/.test(e4), e4)

  try { srv.close() } catch {}
}

// ──【17】★ 跟随宿主对话模型（用户拍板：宿主用哪个模型对话，就用哪个压缩）──
//   这是端到端验证：宿主 llm/stream 里报出的模型名，必须**真的**出现在我们发给
//   网关的 payload.model 里。只测 trace 不够 —— 要看到 API 那一侧收到了什么。
console.log('\n【17】★ 提纯模型跟随宿主对话模型（本地 server 收包验证，零外网）')
{
  const tmp = tmpFile('hostmodel.trace.log')
  try { fs.unlinkSync(tmp) } catch { /* first run */ }

  const cred = tmpFile('credentials.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_ZZ: sk-selftest\n')

  // 本地网关：记下每一次收到的 payload
  const got = []
  const srv = http.createServer((q, s) => {
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      let p = null
      try { p = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* HEAD 之类无 body */ }
      if (p) got.push(p)
      s.writeHead(200, { 'Content-Type': 'application/json' })
      s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】宿主模型跟随 OK' } }] }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))

  let llmStream = null
  const ctx = { on: (nm, fn) => { if (nm === 'llm/stream') llmStream = fn } }

  // ⛔ prewarm:false / baseUrl 指向本地 ⇒ 零外网
  apply(ctx, {
    trace: true, traceFile: tmp, dryRun: false, minRawChars: 10,
    prewarm: false, model: '', followHostModel: true,
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ', maxAttempts: 1, timeoutMs: 3000,
  })
  ok('llm/stream handler 已注册', typeof llmStream === 'function')

  const fakeStream = async function* (chunks) { for (const c of chunks) yield c }
  // ⚠ 每次要用**不同的 reasoning 文本**：fireEarly 按原文精确匹配去重，
  //   同一段文本第二次会直接命中缓存而不重新发起（这是设计，不是 bug）。
  const mkChunks = (ch, len) => [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: ch.repeat(len) },
    { type: 'block-start', index: 1, blockType: 'text' },
  ]

  // ── 17A：还没见过宿主模型 ⇒ **不许发起提纯**（不猜模型名）──
  {
    const ret = llmStream({ model: '', messages: [] }, () => fakeStream(mkChunks('z', 900)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 200))
    const t = fs.readFileSync(tmp, 'utf8')
    ok('★ 没读到宿主模型 → 不发提纯（early-no-model）', t.includes('early-no-model'))
    ok('★ 且绝不发 early-fired（不猜模型名去撞墙）', !t.includes('early-fired'))
    eq('★ 一个包都没发给网关', got.length, 0)
  }

  // ── 17B：llm/stream 报出宿主模型 ⇒ cfg.model 被改写 ⇒ 发出去的 model 就是它 ──
  {
    const ret = llmStream(
      { model: 'HOST-MODEL-X', provider: 'host-provider', messages: [] },
      () => fakeStream(mkChunks('z', 900)),
    )
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))

    const t = fs.readFileSync(tmp, 'utf8')
    ok('★ 捕获到宿主模型并落 trace（host-model）', t.includes('host-model'))
    ok('★ trace 里 effectiveModel = 宿主模型', t.includes('"effectiveModel":"HOST-MODEL-X"'))
    ok('★ 提纯被发起（early-fired）', t.includes('early-fired'))
    ok('★ 提纯成功且带上实际模型名（early-ready）', t.includes('"model":"HOST-MODEL-X"'))

    eq('★ 网关收到的 model 就是宿主对话模型', got.length >= 1 ? got[0].model : null, 'HOST-MODEL-X')
    ok('★ 且带上了 thinking={type:disabled}（关掉思考）',
      got.length >= 1 && JSON.stringify(got[0].thinking) === '{"type":"disabled"}')
  }

  // ── 17C：宿主换模型 ⇒ 立刻跟着换（不是只在第一次锁定）──
  {
    const ret = llmStream({ model: 'HOST-MODEL-Y', messages: [] }, () => fakeStream(mkChunks('y', 950)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))
    eq('★ 宿主换模型后，网关收到的就是新模型', got.length >= 2 ? got[1].model : null, 'HOST-MODEL-Y')
  }

  // ── 17D：followHostModel=false 时显式配置的模型才是唯一来源 ──
  {
    const tmp2 = tmpFile('hostmodel-off.trace.log')
    try { fs.unlinkSync(tmp2) } catch { /* first run */ }
    const got2 = []
    const srv2 = http.createServer((q, s) => {
      const cs = []
      q.on('data', (c) => cs.push(c))
      q.on('end', () => {
        try { got2.push(JSON.parse(Buffer.concat(cs).toString('utf8'))) } catch { /* ignore */ }
        s.writeHead(200, { 'Content-Type': 'application/json' })
        s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】fixed' } }] }))
      })
    })
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
    let ls2 = null
    const ctx2 = { on: (nm, fn) => { if (nm === 'llm/stream') ls2 = fn } }
    apply(ctx2, {
      trace: true, traceFile: tmp2, dryRun: false, minRawChars: 10, prewarm: false,
      model: 'FIXED-MODEL-Z', followHostModel: false,
      baseUrl: 'http://127.0.0.1:' + srv2.address().port,
      credentialsPath: cred, credentialRef: 'TEST_KEY_ZZ', maxAttempts: 1, timeoutMs: 3000,
    })
    const ret = ls2({ model: 'HOST-MODEL-W', messages: [] }, () => fakeStream(mkChunks('z', 900)))
    for await (const _ of ret) { /* drain */ }
    await new Promise((r) => setTimeout(r, 400))
    eq('★ followHostModel=false ⇒ 用显式配置的模型，不被宿主覆盖',
      got2.length >= 1 ? got2[0].model : null, 'FIXED-MODEL-Z')
    try { srv2.close() } catch { /* ignore */ }
  }

  try { srv.close() } catch {}
}


// ──【18】★ 统一响应入口：流式／非流式错配（2026-09-21 外部审计 P0）────────────
//   事故：非流式请求拿到 SSE 体 ⇒ 旧写法直接 JSON.parse ⇒ bad json（trace 实测 4 次）。
//   原则：按【响应实际协议】解析，错配显式记录，绝不靠重发掩盖。
console.log('\n【18】统一响应入口 —— 协议判定与错配兜底')
{
  // ── 18.1 协议判定：结构证据优先 ──
  eq('  整段 JSON 判为 json', detectResponseProtocol('{"a":1}', 'application/json'), 'json')
  eq('★ SSE 体（含 data: 行）判为 sse —— 不看 Content-Type 也能认出来',
    detectResponseProtocol('data: {"a":1}\n\ndata: [DONE]\n', null), 'sse')
  eq('  空体判为 empty', detectResponseProtocol('', null), 'empty')
  eq('  纯文本无 JSON 无 SSE 判为 unknown', detectResponseProtocol('boom', 'text/plain'), 'unknown')
  eq('  仅凭 Content-Type=text/event-stream 也认 sse（体为空时）',
    detectResponseProtocol('', 'text/event-stream'), 'sse')
  eq('  Content-Type 只是旁证：json 头 + SSE 体 ⇒ 以体为准',
    detectResponseProtocol('data: {}\n', 'application/json'), 'sse')

  // ── 18.2 SSE 帧抽取：与 requestStream.takeLine 判据一致 ──
  const fr = assembleSseFrames('data: A\n\n: keepalive\n\nevent: x\n\ndata: B\n\ndata: [DONE]\n')
  eq('  只取 data: 行，注释/event: 行不算事件', fr.datas, ['A', 'B'])
  eq('  [DONE] 被识别且不混进帧列表', fr.sawDone, true)
  eq('  跨行残段（无结尾换行）也能解出最后一行', assembleSseFrames('data: Z').datas, ['Z'])

  // ── 18.3 帧归并：chat 风格 ──
  const c1 = collectSseFrames([
    '{"choices":[{"delta":{"reasoning_content":"想想"}}]}',
    '{"choices":[{"delta":{"content":"【已定决策】"}}]}',
    '{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}',
  ], 'chat')
  eq('  content 逐帧拼接', c1.out, '【已定决策】x')
  eq('  finish_reason 被带回', c1.finish, 'stop')
  eq('  reasoning_content 只计数、绝不混进正文', c1.reasoningChars, 2)
  const c2 = collectSseFrames(['not json', '{"choices":[{"delta":{"content":"ok"}}]}'], 'chat')
  eq('  坏帧被跳过，不阻断后续帧', c2.out, 'ok')

  // ── 18.4 JSON 体抽取：与流式同规则 ──
  const j1 = extractFromJsonBody({ choices: [{ finish_reason: 'stop', message: { content: 'A', reasoning_content: 'zz' } }] }, 'chat')
  eq('  chat：content 取出', j1.out, 'A')
  eq('  chat：reasoning 只计数', j1.reasoningChars, 2)
  eq('  没有 choices ⇒ null（由调用方给报错文案）', extractFromJsonBody({ error: {} }, 'chat'), null)

  // ── 18.5 ★ 端到端：非流式请求遇到 SSE 响应（就是那 4 次 bad json）──
  const cred = tmpFile('credentials-mismatch.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_MM: sk-selftest\n')
  let mode = 'sseOnJson'
  const srv = http.createServer((q, s) => {
    const chunks = []
    q.on('data', (c) => chunks.push(c))
    q.on('end', () => {
      if (mode === 'sseOnJson') {
        // 上游无视「非流式」要求，直接给 SSE
        s.writeHead(200, { 'Content-Type': 'text/event-stream' })
        s.end('data: {"choices":[{"delta":{"content":"【已定决策】"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"mismatch"},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n')
        return
      }
      // 反向：要求流式，却回整段 JSON
      s.writeHead(200, { 'Content-Type': 'application/json' })
      s.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '【已定决策】jsonback' } }] }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const mcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_MM',
    maxAttempts: 1, timeoutMs: 3000, model: 'test-model-mm',
  })

  const g1 = await generateDistillation('hello', mcfg)
  eq('★★ 非流式请求遇到 SSE 体 ⇒ 仍能取出正文（旧写法在这里抛 bad json）', g1.text, '【已定决策】mismatch')
  eq('★ 错配被显式记录，不再静默', g1.meta.protocolMismatch, 'sse-body-on-json-request')

  mode = 'jsonOnStream'
  const g2 = await generateDistillation('hello', normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_MM',
    maxAttempts: 1, timeoutMs: 3000, model: 'test-model-mm', distillStream: true,
  }))
  eq('★★ 流式请求遇到整段 JSON ⇒ 仍能取出正文（旧写法只报空摘要）', g2.text, '【已定决策】jsonback')
  eq('★ 反向错配同样显式记录', g2.meta.protocolMismatch, 'json-body-on-stream-request')

  try { srv.close() } catch {}
}

// ──【19】★ 失败/取消路径必须带请求指纹（2026-09-21 补数据缺口）──────────────
//   此前 promptChars 只在【成功】的 settled 里落盘 ⇒ 恰恰在最需要看输入体积时看不见。
console.log('\n【19】失败路径的请求指纹 —— 分得清「TTFB 吃光预算」与「生成太慢」')
{
  const cred = tmpFile('credentials-failmeta.yaml')
  fs.writeFileSync(cred, 'TEST_KEY_FM: sk-selftest\n')
  // 服务端从不回响应头 ⇒ 触发超时（模拟「TTFB 把预算吃光」）
  const srv = http.createServer(() => { /* 故意不响应 */ })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const fcfg = normalizeConfig({
    baseUrl: 'http://127.0.0.1:' + srv.address().port,
    credentialsPath: cred, credentialRef: 'TEST_KEY_FM',
    maxAttempts: 1, timeoutMs: 400, model: 'test-model-fm', distillStream: true,
  })
  let em = null
  try { await generateDistillation('x'.repeat(3000), fcfg) } catch (e) { em = e.meta || null }
  ok('★ 超时/取消路径带上了 promptChars（本轮补的缺口）', em && typeof em.promptChars === 'number' && em.promptChars > 0, em)
  eq('  且能看出失败发生在「等响应」阶段', em && em.stage, 'await-headers')
  eq('  并带回本次实际请求的模型名', em && em.model, 'test-model-fm')
  ok('  maxOutputTokens 也被钉住（可与预算对照）', em && em.maxOutputTokens === fcfg.maxOutputTokens, em)
  try { srv.close() } catch {}
}
console.log('\n' + '='.repeat(56))

// ──【20】方案二「下轮收网」暂存区（2026-09-21）───────────────────────────
//   核心不变量：① 按【原始推理文本】索引（收网器只拿得到 raw）；
//              ② 取走即移除（同一结论绝不重复注入）；
//              ③ 同一块重复入队只留一条（绝不堆积）；④ 有界。
console.log('')
console.log('【20】birth 下轮收网：暂存区语义')
{
  const sid = 'sess-' + Math.random().toString(36).slice(2)
  const rawA = '推理原文 A'.repeat(20)
  const rawB = '推理原文 B'.repeat(20)
  const entA = [{ id: 'a1' }]
  const entB = [{ id: 'b1' }]

  ok('20.1 初始为空', lateMemorySize(sid) === 0, String(lateMemorySize(sid)))
  ok('20.2 push 成功', pushLateMemory(sid, rawA, entA, '看板A') === true)
  ok('20.3 入队后可见', lateMemorySize(sid) === 1)

  // ② 按 raw 索引：拿错 raw 必须取不到（否则会把 A 的结论贴到 B 上）
  ok('20.4 ★ 错误的 raw 取不到（绝不张冠李戴）', takeLateMemory(sid, rawB) === null)
  ok('20.5 取错后原条目仍在', lateMemorySize(sid) === 1)
  ok('20.6 peek 不消费', peekLateMemory(sid, rawA) !== null && lateMemorySize(sid) === 1)

  const got = takeLateMemory(sid, rawA)
  ok('20.7 ★ 正确 raw 取到且内容一致',
     !!got && got.board === '看板A' && JSON.stringify(got.entries) === JSON.stringify(entA))
  ok('20.8 ★ 取走即移除（绝不重复收网）', lateMemorySize(sid) === 0)
  ok('20.9 二次取同一条返回 null', takeLateMemory(sid, rawA) === null)

  // ③ 同文本但没有任务身份 ⇒ 保留歧义，不擅取最新版
  pushLateMemory(sid, rawA, entA, '第一版')
  pushLateMemory(sid, rawA, entA, '第二版')
  ok('20.10 ★ 同 raw 无身份重复入队保留两条', lateMemorySize(sid) === 2, String(lateMemorySize(sid)))
  ok('20.11 同 raw 无身份歧义不认领', takeLateMemory(sid, rawA) === null)

  // ④ 有界
  for (let i = 0; i < 20; i++) pushLateMemory(sid, rawA + '#' + i, entB, '看板' + i)
  ok('20.12 ★ 有界（最多 8 条，绝不无界增长）', lateMemorySize(sid) === 8, String(lateMemorySize(sid)))

  // 会话隔离：另一个会话看不到本会话的暂存
  ok('20.13 ★ 会话隔离', lateMemorySize(sid + '-other') === 0)

  // 边界：脏输入不得抛错
  ok('20.14 null session 安全', pushLateMemory(null, rawA, entA, 'x') === false && takeLateMemory(null, rawA) === null)
  ok('20.15 空 raw 拒收', pushLateMemory(sid, '', entA, 'x') === false)
  ok('20.16 空 entries 拒收', pushLateMemory(sid, rawA, [], 'x') === false)
  ok('20.17 非字符串 raw 拒收', pushLateMemory(sid, 123, entA, 'x') === false)
  ok('20.18 未知会话取用安全', takeLateMemory('never-seen', 'x') === null)

  // ★★ 2026-09-22 全覆盖认领语义 ★★
  //   收网用一条 ledger 替换**整条**消息的推理，而暂存的是**块级**结果。
  //   只部分就绪就收网 ⇒ 未就绪块的推理凭空消失。故：部分覆盖一律不认领。
  {
    const NL = String.fromCharCode(10)
    const blockA = '甲'.repeat(80)
    const blockB = '乙'.repeat(80)

    // ① 部分就绪 ⇒ 不认领、不消费
    const s2 = sid + '-partial'
    pushLateMemory(s2, blockA, entA, '块A看板')
    ok('20.19 ★★ 多块只就绪一块 ⇒ 拒绝认领（防丢内容）',
       takeLateMemory(s2, blockA + NL + blockB) === null)
    ok('20.20 ★ 拒绝后**不消费**，结果仍保留待下轮', lateMemorySize(s2) === 1)

    // ② 全部就绪 ⇒ 认领，且按块序合并
    pushLateMemory(s2, blockB, entB, '块B看板')
    const full = takeLateMemory(s2, blockA + NL + blockB)
    ok('20.21 ★★ 全部就绪 ⇒ 认领成功', !!full, JSON.stringify(full && full.count))
    ok('20.22 ★ 按块序合并（A 在 B 前，不按完成序）',
       !!full && full.board === '块A看板' + NL + NL + '块B看板', JSON.stringify(full && full.board))
    ok('20.23 ★ 认领后全部消费（绝不重复收网）', lateMemorySize(s2) === 0)

    // ③ 顺序颠倒也必须按原文位置合并（蒸馏是并发的，完成序不可信）
    const s2r = sid + '-rev'
    pushLateMemory(s2r, blockB, entB, '块B看板')   // 先完成的是 B
    pushLateMemory(s2r, blockA, entA, '块A看板')   // 后完成的是 A
    const rev = takeLateMemory(s2r, blockA + NL + blockB)
    ok('20.24 ★★ 完成序颠倒仍按源块序合并',
       !!rev && rev.board === '块A看板' + NL + NL + '块B看板', JSON.stringify(rev && rev.board))

    // ④ 短文本：逐字仍可匹配，但不参与容错（防误配）
    const s3 = sid + '-short'
    pushLateMemory(s3, 'short text here', entA, '短看板')
    ok('20.25 ★ 短文本不参与容错匹配（防误配）', takeLateMemory(s3, 'short text here plus more') === null)
    ok('20.26 短文本逐字仍可匹配', (takeLateMemory(s3, 'short text here') || {}).board === '短看板')

    // ⑤ 多条候选（不同轮次出现相同文本）⇒ 拼接不等于原文 ⇒ 自动 no-op
    const s4 = sid + '-amb'
    const base = '丙'.repeat(100)
    pushLateMemory(s4, base, entA, '候选1')
    pushLateMemory(s4, base + '丁'.repeat(100), entB, '候选2')
    const amb = takeLateMemory(s4, base + '丁'.repeat(100))
    ok('20.27 ★ 逐字命中优先（长的那条）', amb && amb.board === '候选2', JSON.stringify(amb && amb.board))

    // ⑥ 嵌在别段中间 ⇒ 段对齐排除
    const s5 = sid + '-mid'
    const frag = '戊'.repeat(100)
    pushLateMemory(s5, frag, entA, '本该不匹配')
    ok('20.28 ★ 嵌在别段中间不匹配（段对齐排除巧合）',
       takeLateMemory(s5, '前缀' + frag + '后缀') === null)
    ok('20.29 段首对齐但**部分**覆盖仍拒绝',
       takeLateMemory(s5, frag + NL + '后段') === null)
    ok('20.30 完全覆盖才认领',
       (takeLateMemory(s5, frag) || {}).board === '本该不匹配')
  }
}

// ──【21】方案二端到端：出生放行 → 暂存 → 下轮收网 ─────────────────────────
//   这是整个方案二的**唯一验收点**：不验它，前面所有单测都只是零件。
//   链路：birthStart/birthFinish 放行原文（task.passedThrough）
//         → distill 稍后成功 ⇒ pushLateMemory（按 raw 索引）
//         → 下一轮 pre-step：runPreStepEmit 用 awaitDistilled 取回
//         → 官方 user/message + surfaceOp replace 收网。
console.log('')
console.log('【21】birth 下轮收网：端到端')
{
  const NL = String.fromCharCode(10)
  const mkUser = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
  const mkA = (seq, reasoning) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: reasoning }] } } })
  // 与生产同口径：多块用 '\n' 拼接（这正是容错匹配要对付的形状）
  const rawOfImpl = (ev) => ev && ev.data && ev.data.message
    ? ev.data.message.content.filter((b) => b.type === 'reasoning').map((b) => String(b.text || '')).join(NL) : null
  const mkSession = (events) => {
    const map = new Map(events.map((e) => [e.seq, e]))
    const calls = []
    return {
      id: 'sess-claim',
      surface: { nodes: events.map((e) => e.seq) },
      eventAt: (s) => map.get(s),
      requestContext: () => ({ contextWindow: 262144 }),
      append(type, data, meta) { calls.push({ type, data, meta }); return { seq: 9000 + calls.length } },
      __calls: calls,
    }
  }
  const mkCtx = () => ({ get: (k) => (k === 'tokenMeter' ? { measure: () => ({ usedTokens: Math.floor(262144 * 0.10) }) } : null) })

  // A1 是「上一轮放行原文」的那一块：长到足以越过门槛
  const rawA1 = '甲'.repeat(900)
  // 表面：U1 / A1 / U2 / A2(活跃尾部) —— keepTail=1 ⇒ A1 已滑出尾部，可收网
  const buildEvents = () => [mkUser(1, '第一问'), mkA(2, rawA1), mkUser(4, '第二问'), mkA(5, '活跃尾部')]

  // ── 反例：没有暂存结果 ⇒ 必须【不发】 ──
  {
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory('sess-claim', raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.1 ★ 无暂存结果 ⇒ 不发（保持原文，绝不误动表面）', r.emitted === false && s.__calls.length === 0, JSON.stringify(r))
  }

  // ── 正例：有暂存结果 ⇒ 必须收网 ──
  {
    const sid = 'sess-claim'
    pushLateMemory(sid, rawA1, [{ id: 'k1' }], '【收网看板】这是迟到编译出来的语义摘要')
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory(sid, raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.2 ★★ 有暂存结果 ⇒ 收网成功（方案二的核心承诺）', r.emitted === true, JSON.stringify(r))
    const u = s.__calls.find((c) => c.type === 'user/message')
    ok('21.3 用的是官方 user/message 替换者（不是 assistant/message）', !!u && u.type === 'user/message')
    ok('21.4 surfaceOp 是 replace 且区间完整', !!u && u.meta && u.meta.surfaceOp && u.meta.surfaceOp.op === 'replace'
       && Number.isInteger(u.meta.surfaceOp.startSeq) && Number.isInteger(u.meta.surfaceOp.endSeq))
    ok('21.5 ★ 被遮蔽的 A1(seq=2) 在 sourceEventSeqs 里（可溯源）',
       !!u && u.meta.sourceEventSeqs.includes(2), JSON.stringify(u && u.meta.sourceEventSeqs))
    ok('21.6 ★ 活跃尾部 A2(seq=5) 绝不被遮蔽（不许把当轮回答换掉）',
       !!u && !u.meta.sourceEventSeqs.includes(5))
    ok('21.7 看板正文确实进了消息（不是空壳）',
       !!u && JSON.stringify(u.data).indexOf('收网看板') >= 0)
    ok('21.8 ★ 收网后暂存被消费（同一结论绝不重复收网）', lateMemorySize(sid) === 0)
  }

  // ── 收网只发生一次：再跑一次必须不发 ──
  {
    const s = mkSession(buildEvents())
    const r = await runPreStepEmit({
      session: s, ctx: mkCtx(), cfg: { dryRun: false, keepTail: 1 },
      rawOf: (e) => rawOfImpl(e), toolTextOf: () => null,
      awaitDistilled: async (raw) => { const h = takeLateMemory('sess-claim', raw); return h ? { ok: true, text: h.board } : null },
    })
    ok('21.9 ★ 暂存消费后不再重复收网（幂等）', r.emitted === false && s.__calls.length === 0)
  }
}

console.log('')
console.log('【22】编译输入止血：覆盖水位与成对校验')
await test22()

// ══════════════════════════════════════════════════════════════════════════
// 22. ★ 编译输入止血：覆盖水位 + 成对校验（2026-09-22）
//   背景：真机实测「已编译过的工具证据每轮全量重发」= 25~28k 字符，是输入膨胀主因。
//   这里钉死四件事：① 成对校验三态；② 水位只增不减；③ 持久化可恢复；④ 空值安全。
// ══════════════════════════════════════════════════════════════════════════
async function test22() {
  const W = 26158
  const pm = (seq) => ({ text: '<cot-ledger>x</cot-ledger>', seq })

  // ── 成对校验：唯一允许过滤的形态 ──
  {
    const r = coverSnapshotOk([pm(26210)], W)
    ok('22.1 ★ 快照 seq > 水位 ⇒ 允许过滤（有依据）', r.ok === true && r.snapSeq === 26210, JSON.stringify(r))
  }
  // ── 三种失效场景必须恢复全量 ──
  {
    const r = coverSnapshotOk([], W)
    ok('22.2 ★★ 无快照（迟到结果未收网）⇒ 必须全量发送', r.ok === false, JSON.stringify(r))
  }
  {
    const r = coverSnapshotOk([pm(26100)], W)
    ok('22.3 ★★ 快照 seq ≤ 水位（旧快照/分支变化）⇒ 必须全量发送', r.ok === false, JSON.stringify(r))
  }
  {
    const r = coverSnapshotOk([pm(26210)], null)
    ok('22.4 ★★ 水位为 null（从未成功编译）⇒ 必须全量发送', r.ok === false, JSON.stringify(r))
  }
  // ── 多条快照取最大 ──
  {
    const r = coverSnapshotOk([pm(26100), pm(26579)], W)
    ok('22.5 多条快照取最大 seq（不被首条旧快照误导）', r.ok === true && r.snapSeq === 26579, JSON.stringify(r))
  }
  // ── 水位只增不减 ──
  {
    const sid = 'cover-22-' + Date.now()
    markCovered(sid, 26158, 13)
    markCovered(sid, 5, 1)
    const c = coverWatermarkOf(sid)
    ok('22.6 ★ 乱序事件不得把水位往回拉（只增不减）', !!c && c.upTo === 26158, JSON.stringify(c))
  }
  // ── 空值安全 ──
  {
    ok('22.7 markCovered(null) 返回 false（绝不抛错）', markCovered(null, 1, 0) === false)
    ok('22.8 未标记会话返回 null ⇒ 调用方按全量处理', coverWatermarkOf('cover-22-unknown') === null)
    ok('22.9 coverSnapshotOk(null, …) 安全返回 ok:false', coverSnapshotOk(null, 5).ok === false)
  }
  // ── 持久化：水位必须能跨重启恢复（用户第 3 点）──
  {
    const sid = 'cover-22-persist-' + Date.now()
    markCovered(sid, 31442, 26)
    const f = path.join(os.homedir(), '.dsh', 'storages', 'cot-form-b', 'cover.json')
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
    ok('22.10 ★★ 覆盖水位落盘（TTL 只清内存，不清归档关系）',
       !!onDisk && onDisk.v === 1 && !!onDisk.sessions && !!onDisk.sessions[sid], JSON.stringify(onDisk && onDisk.sessions && onDisk.sessions[sid]))
    ok('22.11 落盘内容含水位与条数',
       !!onDisk && onDisk.sessions[sid].upTo === 31442 && onDisk.sessions[sid].entries === 26)
  }
  // ── 冻结对象回归（核心 bug：adaptEvidence 返回冻结对象）──
  {
    const a = adaptEvidence({ events: [], inFlightIds: new Set(), cutSeq: null })
    ok('22.12 ★★ adaptEvidence 返回冻结对象（过滤绝不能改它）', Object.isFrozen(a) === true)
    let threw = false
    try { a.tools = [] } catch { threw = true }
    ok('22.13 ★★ 证明改冻结字段必抛错 ⇒ 生产代码必须构造新数组而非赋值', threw === true)
  }
}

console.log('  通过 ' + pass + ' / 失败 ' + fail)
console.log('='.repeat(56))
process.exit(fail === 0 ? 0 : 1)