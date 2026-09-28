// v4.selftest.mjs —— compress-v4-ops（v12.2）：副模型只做结构化标注，出生文本由代码写出。
//   §1 提示词 / 版本号 / 配置
//   §2 parseOps：容错解析
//   §3 validateOps：硬不变量 I1–I5、I7、I8、schema、去重、fatal
//   §4 selectOps：必留、冗余剔除、预算、支撑闭包
//   §5 renderOps：证据定粘性、替代先行 + 否定就近、过去时计划、尾段、语言跟随
//   §6 compileV4：整块回退的每条路径 + 统计
//   §7 端到端：本机 HTTP 副模型 → makeBirthCompiler → birthStart/birthFinish（成功替换 / 失败原文放行）+ trace
//   §8 tools/cf-eval：v4 变体与线上同一路径
// 全部本机执行，零外网、零 API 调用。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as I from '../index.js'
import { compressBlock, parseVariant } from '../tools/cf-eval.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v4-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)) } }

const RAW = [
  '服务启动报 EACCES。先想想是不是权限问题，试了 chmod 777 /srv/app/conf.yaml，重启后仍然 EACCES，所以不是权限。',
  '等等，strace 显示 open("/srv/app/conf.yaml") 失败，而 read_file 读的是 /etc/app/conf.yaml，这说明是路径错配。',
  '让我再检查一下，2+2=4，没问题。也可能是网络问题？但日志里没有任何网络调用痕迹，先不管网络。',
  '检查 loadConfig，发现 APP_CONF 环境变量指向旧路径。下一步把 APP_CONF 改成 /srv/app/conf.yaml。还没确认 /srv/app/conf.yaml 是不是 symlink。',
].join('\n')
const OPS = [
  { id: 'o1', k: 'REFUTED', ev: 'tool', kind2: 'hypothesize', text: '权限问题', anchor: '试了 chmod 777', alt: '查路径配置', why: 'chmod 777 后重启仍 EACCES' },
  { id: 'o2', k: 'FACT', ev: 'tool', kind2: 'pivot', text: '进程 open /srv/app/conf.yaml 失败，read_file 读的是 /etc/app/conf.yaml', anchor: 'strace 显示', src: 'strace', key: 'config.path' },
  { id: 'o3', k: 'COMPUTED', ev: 'derived', kind2: 'localize', text: '根因是路径错配', anchor: '这说明是路径错配', deps: ['o2'] },
  { id: 'o4', k: 'FACT', ev: 'derived', kind2: 'verify', text: '2+2=4', anchor: '2+2=4' },
  { id: 'o5', k: 'SHELVED', ev: 'derived', text: '网络问题', anchor: '先不管网络', alt: '继续查配置路径', why: '日志里没有网络调用痕迹', trigger: '出现网络报错' },
  { id: 'o6', k: 'INCUMBENT', ev: 'derived', kind2: 'localize', text: 'APP_CONF 环境变量指向旧路径，需改为 /srv/app/conf.yaml', anchor: '检查 loadConfig' },
  { id: 'o7', k: 'PLAN', ev: 'derived', kind2: 'plan', text: '把 APP_CONF 改成 /srv/app/conf.yaml', anchor: '下一步把 APP_CONF' },
  { id: 'o8', k: 'OPEN', ev: 'derived', text: '/srv/app/conf.yaml 是不是 symlink', anchor: '是不是 symlink' },
]
const OPS_JSON = JSON.stringify({ ops: OPS })
const count = (hay, needle) => hay.split(needle).length - 1

try {
  // ═══ §1 提示词 / 版本号 / 配置 ═════════════════════════════════════════════
  await test('§1a 提示词：七类条目、锚点逐字、证伪必须带替代、标识符逐字、无第二人称；以原文结尾', () => {
    const p = I.buildCompressPromptV4('COT')
    for (const k of I.V4_KINDS) assert.ok(p.includes(k), k)
    for (const e of I.V4_EVS) assert.ok(p.includes(e), e)
    assert.ok(p.includes('anchor') && p.includes('一字不差'))
    assert.ok(p.includes('alt') && p.includes('why') && p.includes('trigger'))
    assert.ok(p.includes('逐字照抄') && p.includes('不得升级为已确定'))
    assert.ok(p.includes('不写摘要'))
    assert.ok(p.endsWith('【上一轮思维链】\nCOT'))
  })
  await test('§1b splitCompressPrompt 对 v4 同样字节等价（compressSystemPrompt 可用）', () => {
    const p = I.buildCompressPromptV4('原文 X')
    const sp = I.splitCompressPrompt(p)
    assert.ok(sp); assert.equal(sp.system + '\n\n' + sp.user, p); assert.ok(sp.user.endsWith('原文 X'))
  })
  await test('§1c 版本号：v4 携带预算与尾段开关；缺省仍为 v3；compressPromptFor 分派一致', () => {
    assert.equal(I.DEFAULTS.compressPrompt, 'v3')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4' }), 'compress-v4-ops:450:inc1200')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressTargetMax: 600, compressV4SegmentChars: 800 }), 'compress-v4-ops:600:inc800')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4Incremental: false }), 'compress-v4-ops:450')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4BudgetChars: 520, compressV4Tail: false, compressV4Incremental: false, compressSystemPrompt: true }), 'compress-v4-ops:520:notail:sys')
    assert.equal(I.v4Incremental({ compressPrompt: 'v4' }), true); assert.equal(I.v4Incremental({ compressPrompt: 'v3' }), false)
    assert.equal(I.compressPromptFor({ compressPrompt: 'v4' }, 'COT'), I.buildCompressPromptV4('COT'))
    assert.equal(I.v4Budget({}), 450); assert.equal(I.v4Budget({ compressV4BudgetChars: -1 }), 450); assert.equal(I.v4Budget({ compressV4BudgetChars: 700 }), 700)
  })
  await test('§1d normalizeConfig：v4 合法（不进 configAdjusted）；四个 compressV4* 键已登记（不进 unknownOptions）', () => {
    const c = I.normalizeConfig({ compressPrompt: 'v4', compressV4BudgetChars: 500, compressV4MaxOutputTokens: 2000, compressV4Tail: false, compressV4MaxRejectRatio: 0.3 })
    assert.equal(c.compressPrompt, 'v4')
    assert.ok(!c.configAdjusted || !c.configAdjusted.compressPrompt, JSON.stringify(c.configAdjusted))
    assert.deepEqual(c.unknownOptions, [])
    assert.equal(I.DEFAULTS.compressV4MaxOutputTokens, 1600); assert.equal(I.DEFAULTS.compressV4Tail, true)
    assert.equal(I.normalizeConfig({ compressPrompt: 'v5' }).compressPrompt, 'v3')
  })

  // ═══ §2 parseOps ═══════════════════════════════════════════════════════════
  await test('§2a 解析：对象 / 裸数组 / 围栏 / 前后废话 / JSON Lines / 别名字段', () => {
    assert.equal(I.parseOps(OPS_JSON).ops.length, 8)
    assert.equal(I.parseOps(JSON.stringify(OPS)).ops.length, 8)
    assert.equal(I.parseOps('```json\n' + OPS_JSON + '\n```').ops.length, 8)
    assert.equal(I.parseOps('好的，以下是标注：\n' + OPS_JSON + '\n以上。').ops.length, 8)
    assert.equal(I.parseOps(OPS.map((o) => JSON.stringify(o)).join('\n')).ops.length, 8)
    const n = I.normalizeOp({ kind: 'fact', evidence: 'TOOL', text: 'x', anchor: 'y' }, 0)
    assert.equal(n.k, 'FACT'); assert.equal(n.ev, 'tool'); assert.equal(n.id, 'o1')
    assert.equal(I.normalizeOp({ k: 'FACT', ev: 'maybe', text: 'x' }, 3).ev, 'derived', '未知 ev 不得当作 tool')
  })
  await test('§2b 解析失败：空输出 / 散文 / 残缺 JSON ⇒ error（不抛）', () => {
    assert.equal(I.parseOps('').error, 'empty-output')
    assert.equal(I.parseOps('这是一段摘要，不是 JSON。').error, 'unparseable')
    assert.equal(I.parseOps('{"ops":[{"k":"FACT","text":"x"').error, 'unparseable')
  })

  // ═══ §3 validateOps ════════════════════════════════════════════════════════
  const v1 = (op) => I.validateOps([op], RAW)
  await test('§3a I1：锚点不在原文 ⇒ 拒；NFKC + 空白差异容忍（全角标点、换行）', () => {
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '服务报错', anchor: '不存在的锚点' }).rejected[0].rule, 'I1')
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '服务报错', anchor: '' }).rejected[0].rule, 'I1')
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '服务报错', anchor: 'strace   显示' }).kept.length, 1)
    assert.equal(I.validateOps([{ k: 'FACT', ev: 'tool', text: 'x 报错', anchor: 'a,b' }], 'a，b').kept.length, 1, '全角逗号 NFKC 后等于半角')
  })
  await test('§3b I2：条目里编造标识符 ⇒ 拒并带样本；关键条目（INCUMBENT/COMPUTED）编造 ⇒ fatal', () => {
    const r = v1({ k: 'FACT', ev: 'tool', text: '配置在 /opt/fake/x.yaml', anchor: 'strace 显示' })
    assert.equal(r.rejected[0].rule, 'I2'); assert.ok(r.rejected[0].sample.includes('/opt/fake/x.yaml')); assert.equal(r.fatal, null)
    assert.equal(v1({ k: 'INCUMBENT', ev: 'derived', text: '改 parseSettings 即可', anchor: '检查 loadConfig' }).fatal, 'critical-I2')
    assert.equal(v1({ k: 'SHELVED', ev: 'derived', text: '网络', alt: '查 fakeModule', why: 'x', anchor: '先不管网络' }).rejected[0].rule, 'I2', 'alt 同样受检')
  })
  await test('§3c src 里编造的来源只删 src，不拒条目', () => {
    const r = v1({ k: 'FACT', ev: 'tool', text: '进程读 /srv/app/conf.yaml', anchor: 'strace 显示', src: 'tool:fake_tool_x' })
    assert.equal(r.kept.length, 1); assert.equal(r.kept[0].src, '')
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '进程读 /srv/app/conf.yaml', anchor: 'strace 显示', src: 'tool:strace' }).kept[0].src, 'strace')
  })
  await test('§3d I3/I4：无观测的否定降为 SHELVED；证伪不带替代方案 ⇒ 拒（配对准入）', () => {
    const r = v1({ k: 'REFUTED', ev: 'derived', text: '网络问题', alt: '查配置', anchor: '先不管网络' })
    assert.equal(r.kept[0].k, 'SHELVED'); assert.deepEqual(r.converted, [{ id: 'o1', from: 'REFUTED', to: 'SHELVED' }])
    assert.equal(v1({ k: 'REFUTED', ev: 'tool', text: '权限问题', why: 'chmod 无效', anchor: '试了 chmod 777' }).rejected[0].rule, 'I3')
  })
  await test('§3e I5：工具来源条目不得写成「我决定 / I should」', () => {
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '我决定改配置', anchor: 'strace 显示' }).rejected[0].rule, 'I5')
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: 'I should edit the config', anchor: 'strace 显示' }).rejected[0].rule, 'I5')
  })
  await test('§3f I8：第二人称 ⇒ 拒；引号 / 反引号里的原文引用不算', () => {
    assert.equal(v1({ k: 'PLAN', ev: 'derived', text: '你需要改 APP_CONF', anchor: '下一步把 APP_CONF' }).rejected[0].rule, 'I8')
    assert.equal(v1({ k: 'PLAN', ev: 'derived', text: 'you should edit APP_CONF', anchor: '下一步把 APP_CONF' }).rejected[0].rule, 'I8')
    assert.equal(v1({ k: 'FACT', ev: 'tool', text: '报错原文 "you do not have permission"', anchor: 'strace 显示' }).kept.length, 1)
  })
  await test('§3g I7：同 key 保留最后一个值，旧值挂到 supersedes；同文去重；schema', () => {
    const r = I.validateOps([
      { id: 'a', k: 'FACT', ev: 'tool', text: '/etc/app/conf.yaml', key: 'cfg', anchor: 'read_file 读的是' },
      { id: 'b', k: 'FACT', ev: 'tool', text: '/srv/app/conf.yaml', key: 'cfg', anchor: 'strace 显示' },
      { id: 'c', k: 'FACT', ev: 'tool', text: '进程读取 /srv/app/conf.yaml', anchor: 'strace 显示' },
      { id: 'c2', k: 'FACT', ev: 'tool', text: '进程读取  /srv/app/conf.yaml', anchor: 'strace 显示' },
      { id: 'd', k: 'NOTE', ev: 'tool', text: 'x', anchor: 'strace 显示' },
      { id: 'e', k: 'FACT', ev: 'tool', text: '', anchor: 'strace 显示' },
    ], RAW)
    assert.deepEqual(r.kept.map((o) => o.id), ['b', 'c'])
    assert.equal(r.kept[0].supersedes, '/etc/app/conf.yaml')
    const rules = r.rejected.map((x) => x.id + ':' + x.rule).sort()
    assert.deepEqual(rules, ['a:I7', 'c2:dup', 'd:schema', 'e:schema'])
    const d = I.validateOps([{ k: 'OPEN', text: '是不是 symlink', anchor: '是不是 symlink' }, { k: 'OPEN', text: '是不是 Symlink', anchor: '是不是 symlink' }], RAW)
    assert.equal(d.kept.length, 1); assert.equal(d.rejected[0].rule, 'dup')
  })

  // ═══ §4 selectOps ═════════════════════════════════════════════════════════
  const kept = I.validateOps(OPS, RAW).kept
  await test('§4a 必留条目（当前方案 / 证伪 / 未决）在预算极小时也保留；复核句被剔除', () => {
    const s = I.selectOps(kept, { budget: 10 })
    const ks = s.chosen.map((o) => o.k)
    for (const k of ['INCUMBENT', 'REFUTED', 'OPEN']) assert.ok(ks.includes(k), k)
    assert.ok(!s.chosen.some((o) => o.id === 'o4')); assert.equal(s.dropped.verify, 1)
    assert.ok(s.dropped.budget >= 1)
  })
  await test('§4b 预算充足：除冗余外全收；支撑闭包把 deps 一并带上', () => {
    const s = I.selectOps(kept, { budget: 5000 })
    assert.deepEqual(s.chosen.map((o) => o.id).sort(), ['o1', 'o2', 'o3', 'o5', 'o6', 'o7', 'o8'])
    const tight = I.selectOps(kept.filter((o) => ['o2', 'o3'].includes(o.id)), { budget: 60 })
    if (tight.chosen.some((o) => o.id === 'o3')) assert.ok(tight.chosen.some((o) => o.id === 'o2'), '选了 o3 就必须带上它依赖的 o2')
  })
  await test('§4c 复述工具输出（restate）被剔除；但被依赖时保留', () => {
    const ops = I.validateOps([
      { id: 'r', k: 'FACT', ev: 'tool', kind2: 'restate', text: 'read_file 读的是 /etc/app/conf.yaml', anchor: 'read_file 读的是' },
      { id: 'x', k: 'COMPUTED', ev: 'derived', text: '根因是路径错配', anchor: '这说明是路径错配' },
    ], RAW).kept
    assert.deepEqual(I.selectOps(ops, { budget: 5000 }).chosen.map((o) => o.id), ['x'])
    ops[1].deps = ['r']
    assert.deepEqual(I.selectOps(ops, { budget: 5000 }).chosen.map((o) => o.id).sort(), ['r', 'x'])
  })

  // ═══ §5 renderOps ═════════════════════════════════════════════════════════
  const all = I.selectOps(kept, { budget: 5000 }).chosen
  const text = I.renderOps(all, { lang: 'zh' })
  await test('§5a 替代先行 + 否定就近：证伪行以替代方案开头，被放弃的 X 只出现一次且在括号里', () => {
    const line = text.split('\n').find((l) => l.includes('权限问题'))
    assert.ok(line.startsWith('- 查路径配置（已排除权限问题'), line)
    assert.equal(count(text, '权限问题'), 1)
    const sh = text.split('\n').find((l) => l.includes('网络问题'))
    assert.ok(sh.startsWith('- 继续查配置路径（暂缓网络问题') && sh.includes('若出现网络报错再回来'), sh)
  })
  await test('§5b 证据定粘性：tool 陈述带来源；derived 标「目前判断」；guess 标「未验证」；计划写过去时', () => {
    assert.ok(text.includes('- 进程 open /srv/app/conf.yaml 失败，read_file 读的是 /etc/app/conf.yaml（来源 strace）'))
    assert.ok(text.includes('- 目前判断：根因是路径错配'))
    assert.ok(text.includes('- 当时计划：把 APP_CONF 改成 /srv/app/conf.yaml'))
    assert.equal(I.renderLine({ k: 'FACT', ev: 'guess', text: '可能是缓存', src: '', supersedes: '' }), '- 未验证的猜测：可能是缓存')
    assert.equal(I.renderLine({ k: 'INCUMBENT', ev: 'guess', text: '先用 A', supersedes: '' }), '- 当前方案（未验证）：先用 A')
  })
  await test('§5c 分组顺序：状态 → 当前方案 → 排除/搁置 → 计划 → 未决；尾段 = 结论 + 未决问句（在最后）', () => {
    const lines = text.split('\n\n')[0].split('\n')
    const pos = (s) => lines.findIndex((l) => l.includes(s))
    assert.ok(pos('来源 strace') < pos('当前方案') && pos('当前方案') < pos('已排除') && pos('已排除') < pos('当时计划') && pos('当时计划') < pos('未决'))
    const tail = text.split('\n\n')[1]
    assert.equal(tail, '所以现在采用的是：APP_CONF 环境变量指向旧路径，需改为 /srv/app/conf.yaml。还没弄清的是：/srv/app/conf.yaml 是不是 symlink？')
    assert.ok(!I.renderOps(all, { lang: 'zh', tail: false }).includes('\n\n'))
  })
  await test('§5d 产物不含第二人称与「我决定」；中文模板在中英交界处补空格', () => {
    assert.ok(!/[你您]|我决定|我应该/.test(text))
    assert.equal(I.renderLine({ k: 'SHELVED', ev: 'derived', text: '查网络', alt: '', why: '', trigger: 'ECONNREFUSED 出现', supersedes: '' }), '- 暂缓查网络（若 ECONNREFUSED 出现再回来）')
  })
  await test('§5e 语言跟随原文：英文原文 ⇒ 英文模板', () => {
    const rawEn = 'The service fails with EACCES. I tried chmod 777 on /srv/app/conf.yaml and it still fails, so it is not permissions. Wait, strace shows open on /srv/app/conf.yaml.'
    assert.equal(I.renderLang(rawEn), 'en'); assert.equal(I.renderLang(RAW), 'zh')
    const r = I.compileV4(JSON.stringify({ ops: [
      { k: 'REFUTED', ev: 'tool', text: 'permissions', alt: 'check the config path', why: 'chmod 777 did not help', anchor: 'I tried chmod 777' },
      { k: 'OPEN', ev: 'derived', text: 'is /srv/app/conf.yaml a symlink?', anchor: 'strace shows open' },
    ] }), rawEn, {})
    assert.ok(r.ok, r.reason)
    assert.ok(r.text.includes('- check the config path (ruled out permissions: chmod 777 did not help)'), r.text)
    assert.ok(r.text.includes('Still unclear: is /srv/app/conf.yaml a symlink?'), r.text)
  })

  // ═══ §6 compileV4 ═════════════════════════════════════════════════════════
  await test('§6a 成功：统计完整（条目 / 各规则拒绝 / 选取 / 丢弃 / 语言 / 预算 / 字符）', () => {
    const r = I.compileV4('```json\n' + JSON.stringify({ ops: [...OPS, { k: 'FACT', ev: 'tool', text: 'x', anchor: '不存在' }] }) + '\n```', RAW, {})
    assert.ok(r.ok)
    assert.equal(r.stats.ops, 9); assert.equal(r.stats.valid, 8); assert.deepEqual(r.stats.rejected, { I1: 1 })
    assert.equal(r.stats.selected, 7); assert.equal(r.stats.dropped.verify, 1); assert.equal(r.stats.lang, 'zh'); assert.equal(r.stats.budget, 450)
    assert.equal(r.stats.chars, r.text.length)
  })
  await test('§6b 整块回退：解析失败 / 无有效条目 / 关键条目编造 / 拒绝率过高 —— 每条都有独立原因', () => {
    assert.equal(I.compileV4('一段散文', RAW, {}).reason, 'v4-unparseable')
    assert.equal(I.compileV4('', RAW, {}).reason, 'v4-empty-output')
    assert.equal(I.compileV4(JSON.stringify({ ops: [{ k: 'FACT', text: 'x', anchor: '无' }] }), RAW, {}).reason, 'v4-no-valid-ops')
    const crit = I.compileV4(JSON.stringify({ ops: [...OPS, { k: 'INCUMBENT', ev: 'derived', text: '改 fakeLoader.js', anchor: '检查 loadConfig' }] }), RAW, {})
    assert.equal(crit.reason, 'v4-critical-I2'); assert.ok(crit.stats.inventedSample.some((x) => x.startsWith('fakeLoader')), JSON.stringify(crit.stats))
    const bad = [OPS[0], { k: 'FACT', text: 'a', anchor: 'no1' }, { k: 'FACT', text: 'b', anchor: 'no2' }]
    assert.equal(I.compileV4(JSON.stringify(bad), RAW, {}).reason, 'v4-reject-ratio')
    assert.ok(I.compileV4(JSON.stringify(bad), RAW, { compressV4MaxRejectRatio: 1 }).ok, '阈值可调')
  })

  // ═══ §7 端到端 ═════════════════════════════════════════════════════════════
  {
    let reply = OPS_JSON, lastBody = null
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => {
        lastBody = JSON.parse(b)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const cred = path.join(home, 'credentials.yaml'); fs.writeFileSync(cred, 'TEST_KEY: local-only\n')
    const cfg = I.normalizeConfig({ model: 'local-test', baseUrl: 'http://127.0.0.1:' + server.address().port, compressPrompt: 'v4',
      credentialsPath: cred, credentialRef: 'TEST_KEY', maxAttempts: 1, timeoutMs: 3000, keepAlive: false, followHostProvider: false, followHostModel: false })
    const LONG = (RAW + '\n').repeat(4)
    try {
      await test('§7a makeBirthCompiler(v4)：发 v4 提示词、输出上限抬到 1600；返回代码渲染的文本与 v4 统计；trace compiler-v4-compiled', async () => {
        reply = OPS_JSON
        const traces = []
        const r = await I.makeBirthCompiler(cfg)(LONG, undefined, { trace: (t, d) => traces.push([t, d]) })
        assert.ok(lastBody.messages[0].content.startsWith('你是推理解析器'))
        assert.ok(lastBody.messages[0].content.endsWith(LONG))
        assert.equal(lastBody.max_tokens, 1600)
        assert.ok(r.text.includes('已排除权限问题') && !r.text.includes('{'))
        assert.equal(r.meta.promptVersion, 'compress-v4-ops:450:inc1200')
        assert.equal(r.meta.v4.selected, 7)
        const t = traces.find(([x]) => x === 'compiler-v4-compiled')
        assert.ok(t && t[1].ok === true && t[1].valid === 8 && typeof t[1].compileMs === 'number', JSON.stringify(t))
        assert.equal(I.settledTraceData(0, 1, { ok: true, text: r.text, meta: r.meta }).v4.selected, 7, 'v4 统计进 settled 白名单')
      })
      await test('§7b 副模型给散文（不守格式）⇒ 抛错，meta 带 v4.reason；trace 留痕', async () => {
        reply = '权限不是问题，是路径错配。'
        const traces = []
        await assert.rejects(I.makeBirthCompiler(cfg)(LONG, undefined, { trace: (t, d) => traces.push([t, d]) }), (e) => {
          assert.equal(e.message, 'v4-unparseable'); assert.equal(e.meta.v4.reason, 'v4-unparseable'); assert.equal(e.meta.promptVersion, 'compress-v4-ops:450:inc1200'); return true
        })
        assert.ok(traces.some(([x, d]) => x === 'compiler-v4-compiled' && d.ok === false))
      })
      const runBirth = async () => {
        const traces = []
        const deps = {
          cfg: { ...cfg, mode: 'birth', dryRun: false, birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 3000, birthMinSavedChars: 50 },
          trace: (tag, data) => traces.push([tag, data]), sessionId: 's-v4',
          archive: async () => 'art://v4', distill: I.makeBirthCompiler(cfg),
        }
        const task = I.birthStart({ index: 0, text: LONG }, deps)
        await task.distillP
        return { r: await I.birthFinish(task, deps), traces }
      }
      await test('§7c birth 全链路：v4 成功 ⇒ condensed，替换文本 = 代码渲染稿（仍经发明标识符闸与 token 闸）', async () => {
        reply = OPS_JSON
        const { r, traces } = await runBirth()
        assert.equal(r.why, 'condensed', JSON.stringify(traces.filter(([t]) => /pass|fail/.test(t))))
        assert.ok(r.text.startsWith('- 进程 open'))
        const st = traces.find(([t]) => t === 'birth-distill-settled')
        assert.ok(st && st[1].v4 && st[1].v4.kinds.REFUTED === 1, JSON.stringify(st && st[1]))
      })
      await test('§7d birth 全链路：v4 编译失败 ⇒ 原文放行（distill-failed），birth-distill-failed 带 v4 原因', async () => {
        reply = JSON.stringify({ ops: [{ k: 'INCUMBENT', ev: 'derived', text: '改 fakeLoader.js', anchor: '检查 loadConfig' }] })
        const { r, traces } = await runBirth()
        assert.equal(r.text, LONG); assert.notEqual(r.why, 'condensed')
        const f = traces.find(([t]) => t === 'birth-distill-failed')
        assert.ok(f && f[1].v4 && f[1].v4.reason === 'v4-critical-I2', JSON.stringify(f))
      })
    } finally { await new Promise((r) => server.close(r)) }
  }

  // ═══ §9 流式增量编译（segment-v4.js + birthTransform）═════════════════════
  // 构造一段多段推理：每段有自己的锚点句
  const SEGS = [
    '第一段：服务启动报 EACCES。试了 chmod 777 /srv/app/conf.yaml，重启后仍然 EACCES，所以不是权限问题。' + '补充观察。'.repeat(20) + '\n\n',
    '第二段：strace 显示 open("/srv/app/conf.yaml") 失败，read_file 读的是 /etc/app/conf.yaml，这说明是路径错配。' + '继续核对。'.repeat(20) + '\n\n',
    '第三段：检查 loadConfig，发现 APP_CONF 指向旧路径。还没确认 /srv/app/conf.yaml 是不是 symlink。' + '最后的想法。'.repeat(20),
  ]
  const FULL = SEGS.join('')
  // 按段文本给出条目（模拟副模型）；第二段推翻第一段的一条（retracts）
  const opsFor = (segText) => {
    if (segText.includes('第一段')) return [
      { id: 'o1', k: 'REFUTED', ev: 'tool', text: '权限问题', alt: '查路径配置', why: 'chmod 777 后仍 EACCES', anchor: '试了 chmod 777' },
      { id: 'o2', k: 'INCUMBENT', ev: 'derived', text: '先排查权限之外的原因', anchor: '所以不是权限问题' }]
    if (segText.includes('第二段')) return [
      { id: 'o1', k: 'COMPUTED', ev: 'derived', text: '根因是路径错配', anchor: '这说明是路径错配', retracts: ['s1.o2'] },
      { id: 'o2', k: 'FACT', ev: 'tool', text: 'read_file 读的是 /etc/app/conf.yaml', anchor: 'read_file 读的是' }]
    if (segText.includes('第三段')) return [
      { id: 'o1', k: 'INCUMBENT', ev: 'derived', text: 'APP_CONF 指向旧路径', anchor: '发现 APP_CONF' },
      { id: 'o2', k: 'OPEN', ev: 'derived', text: '/srv/app/conf.yaml 是不是 symlink', anchor: '是不是 symlink' }]
    return []
  }
  const mkCompile = (delayFor = () => 0, calls = []) => async (segText, prior, signal) => {
    calls.push({ segText, prior })
    const ms = delayFor(segText)
    await new Promise((res, rej) => {
      const t = setTimeout(res, ms)
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('cancelled'), { cancelled: true })) }, { once: true })
    })
    return { ops: opsFor(segText), meta: {} }
  }
  const segCfg = { compressPrompt: 'v4', compressV4SegmentChars: 200 }
  await test('§9a findCut：优先空行，其次换行，再次句末；最小位置之前不切', () => {
    assert.equal(I.findCut('aaa\n\nbbb\nccc。ddd', 0, 0, 100), 5)
    assert.equal(I.findCut('aaaa\nbbb。cc', 0, 0, 100), 5)
    assert.equal(I.findCut('aaaa。bbb', 0, 0, 100), 5)
    assert.equal(I.findCut('aaaa。bbb', 0, 6, 100), -1)
  })
  await test('§9b 分段：边写边切（段落边界）；后段提示词带前段已通过校验的条目；全部成功 ⇒ 完整编译（retracts 生效、有尾段）', async () => {
    const calls = []
    const sg = I.createSegmenter({ cfg: segCfg, compileSegment: mkCompile(() => 0, calls) })
    let acc = ''
    for (const part of SEGS) {
      for (let i = 0; i < part.length; i += 40) { acc += part.slice(i, i + 40); sg.feed(acc); await new Promise((r) => setTimeout(r, 3)) }
    }
    assert.equal(sg.segments.length, 2, '前两段在 block-end 之前已起飞')
    assert.ok(calls[1].prior.some((l) => l.startsWith('s1.o1 [REFUTED]')), JSON.stringify(calls[1].prior))
    const r = await sg.finish(FULL)
    assert.equal(sg.segments.length, 3)
    assert.ok(r.meta.v4.incremental && !r.meta.v4.partial)
    assert.ok(!r.text.includes('先排查权限之外的原因'), '被第二段 retracts 的条目不得出现')
    assert.ok(r.text.includes('- 查路径配置（已排除权限问题') && r.text.includes('还没弄清的是'), r.text)
  })
  await test('§9c 收网到点：已编译前缀 + 原文尾巴逐字（不出尾段）；无已编译前缀 ⇒ null', async () => {
    const sg = I.createSegmenter({ cfg: segCfg, compileSegment: mkCompile((t) => (t.includes('第三段') ? 5000 : 0)) })
    sg.feed(SEGS[0] + SEGS[1] + SEGS[2].slice(0, 40))
    await new Promise((r) => setTimeout(r, 20))
    const pending = sg.finish(FULL).catch(() => null)
    await new Promise((r) => setTimeout(r, 20))
    const p = sg.partial(FULL)
    assert.ok(p && p.partial, JSON.stringify(p))
    assert.ok(p.text.endsWith(SEGS[2]), '尾巴必须是原文逐字')
    assert.ok(p.text.includes('已排除权限问题') && !p.text.includes('所以现在'), p.text)
    assert.equal(p.stats.compiledSegments, 2); assert.equal(p.stats.rawSuffixChars, SEGS[2].length)
    sg.cancel('test'); await pending
    const sg2 = I.createSegmenter({ cfg: segCfg, compileSegment: mkCompile(() => 5000) })
    sg2.feed(FULL); assert.equal(sg2.partial(FULL), null); sg2.cancel('test')
  })
  await test('§9d 中间段失败 ⇒ 从失败段起全部原文（不跳段）；全部失败 ⇒ 抛错；cancel 掐掉在飞请求', async () => {
    const bad = async (segText) => { if (segText.includes('第二段')) throw new Error('boom'); return { ops: opsFor(segText) } }
    const sg = I.createSegmenter({ cfg: segCfg, compileSegment: bad })
    sg.feed(SEGS[0] + SEGS[1] + SEGS[2].slice(0, 5))
    const r = await sg.finish(FULL)
    assert.ok(r.meta.v4.partial); assert.ok(r.text.endsWith(SEGS[1] + SEGS[2]), '失败段之后（含第三段）一律原文')
    assert.ok(!r.text.includes('根因是路径错配'), '失败段之后的成功段不得跳着用')
    const none = I.createSegmenter({ cfg: segCfg, compileSegment: async () => { throw new Error('x') } })
    await assert.rejects(none.finish(FULL), /v4-no-compiled-segment/)
    let aborted = 0
    const slow = I.createSegmenter({ cfg: segCfg, compileSegment: (t, p, signal) => new Promise((_, rej) => {
      if (signal.aborted) { aborted++; return rej(new Error('cancelled')) }
      signal.addEventListener('abort', () => { aborted++; rej(new Error('cancelled')) })
    }) })
    slow.feed(FULL)
    await new Promise((r) => setTimeout(r, 5))
    slow.cancel('test')
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(aborted, slow.segments.length); assert.ok(aborted >= 2)
  })
  await test('§9e 分段编译：锚点不在本段 / 关键条目编造 ⇒ 该段失败', async () => {
    const sg = I.createSegmenter({ cfg: segCfg, compileSegment: async (t) => ({ ops: t.includes('第一段')
      ? [{ k: 'INCUMBENT', ev: 'derived', text: '改 fakeLoader.js', anchor: '试了 chmod 777' }] : opsFor(t) }) })
    sg.feed(SEGS[0] + SEGS[1].slice(0, 5))
    await assert.rejects(sg.finish(SEGS[0] + SEGS[1]), /v4-no-compiled-segment/)
    assert.equal(sg.segments[0].reason, 'v4-critical-I2')
  })
  // birthTransform 端到端：真实流式时序（delta 间隔），分段编译器注入
  const BS = (index, blockType) => ({ type: 'block-start', index, blockType })
  const BD = (index, text) => ({ type: 'reasoning-delta', index, text })
  const BE = (index, text) => ({ type: 'block-end', index, block: { type: 'reasoning', text } })
  const stream = async function* (text, gapMs = 1) {
    yield BS(0, 'reasoning')
    for (let i = 0; i < text.length; i += 60) { yield BD(0, text.slice(i, i + 60)); await new Promise((r) => setTimeout(r, gapMs)) }
    yield BE(0, text)
    yield BS(1, 'text'); yield { type: 'text-delta', index: 1, text: 'ok' }; yield { type: 'block-end', index: 1, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'end' } }
  }
  const runStream = async (compileSegment, cfgOver = {}) => {
    const traces = []
    const cfg = { mode: 'birth', dryRun: false, birthMinChars: 300, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 300, finishHeadersGraceMs: 0,
      birthMinSavedChars: 20, birthTokenGate: false, compressPrompt: 'v4', compressV4SegmentChars: 200, ...cfgOver }
    const deps = { cfg, trace: (t, d) => traces.push([t, d]), sessionId: 's-inc', archive: async () => 'art://inc',
      distill: async () => { throw new Error('整块编译不应被调用') },
      segmenter: (index) => I.createSegmenter({ cfg, compileSegment, trace: (t, d) => traces.push([t, d]), index }) }
    const out = []
    for await (const c of I.birthTransform(stream(FULL), deps)) out.push(c)
    const end = out.find((c) => c.type === 'block-end' && c.index === 0)
    return { text: end.block.text, traces }
  }
  await test('§9f birthTransform：尾段来不及 ⇒ condensed-partial（前缀渲染 + 原文尾巴），尾段请求被取消', async () => {
    let tailAborted = false
    const cs = async (segText, prior, signal) => {
      if (segText.includes('第三段')) {
        await new Promise((res, rej) => { const t = setTimeout(res, 5000); signal.addEventListener('abort', () => { clearTimeout(t); tailAborted = true; rej(new Error('cancelled')) }) })
      }
      return { ops: opsFor(segText) }
    }
    const { text, traces } = await runStream(cs)
    const cond = traces.find(([t]) => t === 'birth-condensed')
    assert.ok(cond && cond[1].why === 'condensed-partial', JSON.stringify(traces.filter(([t]) => /birth-(pass|cond)/.test(t))))
    assert.ok(text.endsWith(SEGS[2]) && text.includes('已排除权限问题'), text)
    assert.ok(traces.filter(([t]) => t === 'v4-segment-fired').length >= 3)
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(tailAborted, '用了部分结果后，尾段请求必须取消')
  })
  await test('§9g birthTransform：各段都及时 ⇒ condensed（完整编译，无原文尾巴）', async () => {
    const { text, traces } = await runStream(async (segText) => ({ ops: opsFor(segText) }))
    assert.ok(traces.some(([t, d]) => t === 'birth-condensed' && d.why === 'condensed'))
    assert.ok(!text.includes('最后的想法') && text.includes('还没弄清的是'), text)
  })
  await test('§9h birthTransform：块低于门槛 ⇒ 已起飞的分段全部取消，原文放行', async () => {
    let aborted = 0
    const cs = (t, p, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => { aborted++; rej(new Error('cancelled')) }))
    const { text, traces } = await runStream(cs, { birthMinChars: 100000 })
    assert.equal(text, FULL)
    await new Promise((r) => setTimeout(r, 5))
    assert.ok(aborted >= 2, 'aborted=' + aborted)
    assert.ok(traces.some(([t, d]) => t === 'v4-segments-cancelled' && d.why === 'below-floor'))
  })
  await test('§9i makeV4SegmentCompiler：分段提示词（带此前已标注）、promptVersion 加 :seg、解析失败抛错', async () => {
    const p = I.buildCompressPromptV4Segment('SEG', ['s1.o1 [FACT] a'])
    assert.ok(p.startsWith(I.buildCompressPromptV4('').slice(0, -('【上一轮思维链】\n'.length))), '规则前缀与整块 v4 逐字相同（缓存前缀稳定）')
    assert.ok(p.endsWith('【此前已标注】\ns1.o1 [FACT] a\n\n【本段】\nSEG'))
    assert.equal(I.buildCompressPromptV4Segment('SEG', []), I.buildCompressPromptV4('SEG'))
  })

  // ═══ §8 cf-eval ═══════════════════════════════════════════════════════════
  await test('§8 cf-eval v4 变体：与线上同一路径（成功 = 渲染稿；失败 = 原文 + ok:false）', async () => {
    assert.deepEqual(parseVariant('v4'), { base: 'v4', cfg: {} })
    const opts = { targetMin: 250, targetMax: 450, model: 'm' }
    let content = OPS_JSON
    const compressor = async (body) => { assert.ok(body.messages[0].content.startsWith('你是推理解析器')); return { message: { content }, usage: {} } }
    const ok = await compressBlock('v4', RAW, { compressor, opts })
    assert.ok(ok.ok && ok.text.includes('已排除权限问题') && ok.stats.selected === 7)
    content = 'not json'
    const bad = await compressBlock('v4', RAW, { compressor, opts })
    assert.equal(bad.ok, false); assert.equal(bad.text, RAW); assert.equal(bad.error, 'v4-unparseable')
  })
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
}
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
