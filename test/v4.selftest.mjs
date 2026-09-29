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
// 本套件的渲染断言针对行式层（S5 层 A 旧体裁，compressV4Prose:false 仍支持）；散文体见 §5n
I.DEFAULTS.compressV4Prose = false

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
    assert.ok(p.endsWith('【上一轮思维链】\nCOT' + I.V4_TAIL), '内容之后重申要求（防替 Agent 答题）')
  })
  await test('§1b splitCompressPrompt 对 v4 同样字节等价（compressSystemPrompt 可用）', () => {
    const p = I.buildCompressPromptV4('原文 X')
    const sp = I.splitCompressPrompt(p)
    assert.ok(sp); assert.equal(sp.system + '\n\n' + sp.user, p); assert.ok(sp.user.endsWith('原文 X' + I.V4_TAIL))
  })
  await test('§1c 版本号：v4 携带预算与尾段开关；缺省仍为 v3；compressPromptFor 分派一致', () => {
    assert.equal(I.DEFAULTS.compressPrompt, 'v3')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4' }), 'compress-v4-ops9:800:inc1200')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressTargetMax: 1000, compressV4SegmentChars: 800 }), 'compress-v4-ops9:1000:inc800')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4Incremental: false }), 'compress-v4-ops9:800')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4BudgetChars: 520, compressV4Tail: false, compressV4Incremental: false, compressSystemPrompt: true }), 'compress-v4-ops9:520:notail:sys')
    assert.equal(I.v4Incremental({ compressPrompt: 'v4' }), true); assert.equal(I.v4Incremental({ compressPrompt: 'v3' }), false)
    assert.equal(I.compressPromptFor({ compressPrompt: 'v4' }, 'COT'), I.buildCompressPromptV4('COT'))
    assert.equal(I.v4Budget({}), 800); assert.equal(I.v4Budget({ compressV4BudgetChars: -1 }), 800); assert.equal(I.v4Budget({ compressV4BudgetChars: 700 }), 700)
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
    assert.ok(text.includes('- 我目前判断：根因是路径错配'))
    assert.ok(text.includes('- 接下来要：把 APP_CONF 改成 /srv/app/conf.yaml'))
    assert.equal(I.renderLine({ k: 'FACT', ev: 'guess', text: '可能是缓存', src: '', supersedes: '' }), '- 我猜（未验证）：可能是缓存')
    assert.equal(I.renderLine({ k: 'INCUMBENT', ev: 'guess', text: '先用 A', supersedes: '' }), '- 我倾向（未验证）：先用 A')
  })
  await test('§5c 分组顺序：状态 → 当前方案 → 排除/搁置 → 计划 → 未决；尾段 = 结论 + 未决（陈述句）', () => {
    const lines = text.split('\n\n')[0].split('\n')
    const pos = (s) => lines.findIndex((l) => l.includes(s))
    assert.ok(pos('来源 strace') < pos('我现在采用') && pos('我现在采用') < pos('已排除') && pos('已排除') < pos('接下来要') && pos('接下来要') < pos('还要确认'))
    const tail = text.split('\n\n')[1]
    assert.equal(tail, '所以我现在采用：APP_CONF 环境变量指向旧路径，需改为 /srv/app/conf.yaml。还要确认：/srv/app/conf.yaml 是不是 symlink。')
    assert.ok(!I.renderOps(all, { lang: 'zh', tail: false }).includes('\n\n'))
  })
  await test('§5f READY：已备好的改法排最后、带前提；尾段以它收束（若…就…）；最后 2 条必留，超预算也不丢', () => {
    const ops = [
      { id: 'a', k: 'COMPUTED', ev: 'derived', text: '根因是 CFB_REAL_DSH_HOME 绕过临时 DSH_HOME', anchor: 'x', deps: [], retracts: [], idx: 0 },
      { id: 'b', k: 'OPEN', ev: 'derived', text: 'verify.mjs 里有没有设置 CFB_REAL_DSH_HOME？', anchor: 'x', deps: [], retracts: [], idx: 1 },
      { id: 'c', k: 'READY', ev: 'derived', text: '在 verify.mjs 的 env 里加 CFB_REAL_DSH_HOME: tmp', trigger: 'verify.mjs 没有设置该变量', anchor: 'x', deps: [], retracts: [], idx: 2 },
    ]
    const out = I.renderOps(ops, { lang: 'zh' })
    const [body, tail] = out.split('\n\n')
    assert.ok(body.split('\n').pop().startsWith('- 我准备的改法：在 verify.mjs 的 env 里加 CFB_REAL_DSH_HOME: tmp（前提：verify.mjs 没有设置该变量）'), body)
    assert.ok(tail.endsWith('若 verify.mjs 没有设置该变量，就在 verify.mjs 的 env 里加 CFB_REAL_DSH_HOME: tmp。'), tail)
    assert.ok(!/？/.test(tail), '尾段不以问句收束')
    const many = [...ops, ...Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, k: 'FACT', ev: 'tool', text: '事实'.repeat(15) + i, anchor: 'x', src: 't', deps: [], retracts: [], idx: 10 + i }))]
    const sel = I.selectOps(many, { budget: 120 }).chosen
    assert.ok(sel.some((o) => o.id === 'c'), 'READY 必留')
    assert.ok(I.V4_KINDS.includes('READY'))
    assert.equal(I.renderLine({ k: 'READY', text: 'revert compressTargetMax to 450', trigger: '' }, 'en'), '- Prepared change: revert compressTargetMax to 450')
  })
  await test('§5g 改法线索：只摘「改法措辞 + 具体对象」的原文句（逐字、取最后 4 条）；附在原文后、V4_TAIL 前；v3 同样附；无线索时提示词不变', () => {
    const raw = '先看日志。\n可能是权限问题。\n下一步修复：在 verify.mjs 的 env 中加 `CFB_REAL_DSH_HOME: tmp`。\n我们应该改一改。\n'
    assert.deepEqual(I.fixHints(raw), ['下一步修复：在 verify.mjs 的 env 中加 `CFB_REAL_DSH_HOME: tmp`。'])
    const p = I.buildCompressPromptV4(raw)
    assert.ok(p.includes(raw + '\n\n【改法线索】') && p.endsWith('- 下一步修复：在 verify.mjs 的 env 中加 `CFB_REAL_DSH_HOME: tmp`。' + I.V4_TAIL))
    assert.ok(I.buildCompressPromptV3(raw, 250, 450).includes('【原文中的改法句】'))
    assert.equal(I.buildCompressPromptV4('只是在想。'), I.buildCompressPromptV4('只是在想。').split('【改法线索】')[0])
    assert.ok(!I.buildCompressPromptV4('只是在想。').includes('【改法线索】'))
    const many = Array.from({ length: 6 }, (_, i) => '改为 `x' + i + '` 试试。').join('\n')
    assert.deepEqual(I.fixHints(many), ['改为 `x2` 试试。', '改为 `x3` 试试。', '改为 `x4` 试试。', '改为 `x5` 试试。'])
  })
  await test('§5h 发明标识符闸：引号 / 空白差异不算发明（"rawChars":8123 ≈ `rawChars:8123`），真编造仍拦', () => {
    assert.deepEqual(I.inventedIdentifiers('[birth-condensed] {"rawChars":8123,"outChars":212}', 'trace 里 `rawChars:8123`'), [])
    assert.ok(I.inventedIdentifiers('{"rawChars":8123}', '改 `src/made_up.js`').includes('src/made_up.js'))
  })
  await test('§5i IF 判读：cond/then（别名 trigger）拼出 text；渲染「判读：若…，就…」；有判读时尾段不重复未决问题、以判读 + 改法收束；最后 4 条必留', () => {
    const n = I.normalizeOp({ id: 'r1', k: 'IF', trigger: '升级前 finishReason=stop', then: 'compressTargetMax 是主因', anchor: 'x' }, 0)
    assert.equal(n.text, '升级前 finishReason=stop ⇒ compressTargetMax 是主因'); assert.equal(n.trigger, '升级前 finishReason=stop'); assert.equal(n.then, 'compressTargetMax 是主因')
    const ops = [
      { id: 'a', k: 'COMPUTED', ev: 'derived', text: '输出变长来自长度目标或上限', anchor: 'x', deps: [], retracts: [], idx: 0 },
      { id: 'b', k: 'OPEN', ev: 'derived', text: '升级前 finishReason 是 length 还是 stop？', anchor: 'x', deps: [], retracts: [], idx: 1 },
      { ...n, idx: 2, deps: [], retracts: [] },
      { id: 'r2', k: 'IF', trigger: '升级前 finishReason=length', then: 'maxOutputTokens 是主因', text: 'x', anchor: 'x', deps: [], retracts: [], idx: 3 },
    ]
    const out = I.renderOps(ops, { lang: 'zh' })
    assert.ok(out.includes('- 判读：若升级前 finishReason=stop，就 compressTargetMax 是主因'), out)
    const tail = out.split('\n\n')[1]
    assert.ok(!tail.includes('还要确认'), '有判读 ⇒ 尾段不停在问题上')
    assert.ok(tail.endsWith('若升级前 finishReason=length，就 maxOutputTokens 是主因。'), tail)
    const many = [...ops, ...Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, k: 'FACT', ev: 'tool', text: '事实'.repeat(15) + i, anchor: 'x', src: 't', deps: [], retracts: [], idx: 10 + i }))]
    const sel = I.selectOps(many, { budget: 100 }).chosen.map((o) => o.id)
    assert.ok(sel.includes('r1') && sel.includes('r2'), 'IF 必留')
  })
  await test('§5j 模板语言跟随条目内容（原文英文多、条目中文 ⇒ 中文模板）；condHints 摘「若 A 则/就/说明 B」句', () => {
    const raw = 'Let me think about this carefully. The throughput is the same. '.repeat(20) + '若 stop 则长度目标是主因。'
    const r = I.compileV4(JSON.stringify({ ops: [{ id: 'o1', k: 'COMPUTED', ev: 'derived', text: '输出变长是长度目标导致', anchor: 'The throughput is the same' }] }), raw, {})
    assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.stats.lang, 'zh')
    assert.deepEqual(I.condHints('先看看。\n若 grep 显示 verify.mjs 没有设置，则根因明确。\n好的。'), ['若 grep 显示 verify.mjs 没有设置，则根因明确。'])
  })
  await test('§5l READY 位置锚点（S8-R2′）：at 是原文子串才保留、渲染进行式与尾段；编造的 at 丢弃；缺省时从原文反引号逐字抽取；探查型 READY 降为 PLAN', () => {
    const raw = '看到测试里 `const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 绕过了隔离。\n' + '填充句子。'.repeat(200)
    const base = [{ id: 'o1', k: 'COMPUTED', ev: 'derived', text: '测试绕过了临时 DSH_HOME', anchor: '绕过了隔离' }]
    const mk = (at) => I.compileV4(JSON.stringify({ ops: [...base, { id: 'o2', k: 'READY', ev: 'derived', text: '把 CFB_REAL_DSH_HOME 改为 DSH_HOME', anchor: '绕过了隔离', ...(at ? { at } : {}) }] }), raw, {})
    const good = mk('const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })')
    assert.ok(good.ok, JSON.stringify(good))
    assert.ok(good.text.includes('改动位置：`const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`'), good.text)
    assert.ok(/改的就是 `const w = makeTraceWriter[^`]*` 这一行。$/.test(good.text), good.text)
    const fake = mk('const w = makeTraceWriter({ home: FAKE })')
    assert.ok(fake.text.includes('改动位置：`const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`'), '编造的 at 丢弃后由原文保底：' + fake.text)
    assert.ok(!fake.text.includes('FAKE'))
    const auto = mk('')
    assert.ok(auto.text.includes('`const w = makeTraceWriter'), auto.text)
    assert.equal(I.locusFromRaw('只有中文没有代码', '改为 DSH_HOME'), '')
    const probe = I.normalizeOp({ id: 'p', k: 'READY', ev: 'derived', text: '下一步工具调用：taskset 循环复现', anchor: 'x' }, 0)
    assert.equal(probe.k, 'PLAN')
    assert.equal(I.normalizeOp({ id: 'p', k: 'READY', ev: 'derived', text: '把 hedgeAfterMs 改为 3000', anchor: 'x' }, 0).k, 'READY')
  })

  await test('§5m I7 支撑不是取代：同 key 的推理链（后者 deps 依赖前者）全保留；工具观测不被推断取代；真正的改值仍只留最后一个', () => {
    const raw = 'trace 显示 v3.1。lastModel 是模块级变量。observe 只读 options.model。配置先是 /a 后来发现是 /b。' + '填充句子。'.repeat(200)
    const ops = [
      { id: 'o1', k: 'FACT', ev: 'tool', text: 'trace 显示 v3.1', anchor: 'trace 显示 v3.1', key: 'root-cause', src: 'trace' },
      { id: 'o2', k: 'COMPUTED', ev: 'derived', text: 'lastModel 是模块级变量', anchor: 'lastModel 是模块级变量', key: 'root-cause', deps: ['o1'] },
      { id: 'o3', k: 'COMPUTED', ev: 'derived', text: 'observe 只读 options.model', anchor: 'observe 只读 options.model', key: 'root-cause', deps: ['o2'] },
      { id: 'o4', k: 'COMPUTED', ev: 'derived', text: '配置路径是 /a', anchor: '配置先是 /a', key: 'config.path' },
      { id: 'o5', k: 'COMPUTED', ev: 'derived', text: '配置路径是 /b', anchor: '后来发现是 /b', key: 'config.path' },
    ]
    const v = I.validateOps(ops, raw)
    const ids = v.kept.map((o) => o.id)
    assert.deepEqual(ids, ['o1', 'o2', 'o3', 'o5'], JSON.stringify(v.rejected))
  })

  await test('§5n 散文体（S8-R4′，缺省）：无项目符号 / 标签；第一人称；「所以」结论在判读之前；以判读 / 已备改法收尾；逐字锚点保留', () => {
    const raw = '看到测试里 `const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 绕过了隔离。如果 grep 没找到设置，就改测试。' + '填充句子。'.repeat(200)
    const ops = [
      { id: 'o1', k: 'FACT', ev: 'tool', text: 'birth.selftest 用 CFB_REAL_DSH_HOME', anchor: '绕过了隔离', src: 'test/birth.selftest.mjs' },
      { id: 'o2', k: 'INCUMBENT', ev: 'derived', text: '测试绕过了临时 DSH_HOME', anchor: '绕过了隔离' },
      { id: 'o3', k: 'IF', ev: 'derived', cond: 'grep 没找到设置', then: '改测试', anchor: '就改测试' },
      { id: 'o4', k: 'READY', ev: 'derived', text: '把 CFB_REAL_DSH_HOME 改为 DSH_HOME', anchor: '绕过了隔离' },
    ]
    const r = I.compileV4(JSON.stringify({ ops }), raw, { compressV4Prose: true })
    assert.ok(r.ok, JSON.stringify(r))
    assert.ok(!/^- /m.test(r.text) && !/我目前判断：|判读：/.test(r.text), r.text)
    assert.ok(r.text.includes('目前的结论是测试绕过了临时 DSH_HOME'), r.text)
    assert.ok(r.text.indexOf('所以') < r.text.indexOf('如果 grep 没找到设置，那么改测试'), r.text)
    assert.ok(/逐字原文是 `const w = makeTraceWriter[^`]*`，可以直接当 edit_file 的 old_text。$/.test(r.text), r.text)
    const old = I.compileV4(JSON.stringify({ ops }), raw, { compressV4Prose: false })
    assert.ok(/^- /m.test(old.text), '行式仍可选')
  })

  await test('§5k 代码保底：副模型一条 IF / READY 都没标 ⇒ 原文判读 / 改法句逐字补上；已标过 ⇒ 不补；否定 / 犹豫句与超长句不补；可关', () => {
    const raw = '先看日志。\n若 grep 显示 verify.mjs 没有设置，则根因明确。\n下一步修复：在 verify.mjs 的 env 中加 `CFB_REAL_DSH_HOME: tmp`。\n' +
      '可以考虑修复权限：`sudo chown -R u:u /home/u/.dsh` 但不应修改真实 home。\n' + '填充句子。'.repeat(200)
    const base = [{ id: 'o1', k: 'COMPUTED', ev: 'derived', text: '测试绕过了临时 DSH_HOME', anchor: '先看日志' }]
    const r = I.compileV4(JSON.stringify({ ops: base }), raw, {})
    assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.stats.autoHints, 2)
    assert.ok(r.text.includes('- 若 grep 显示 verify.mjs 没有设置，则根因明确'), r.text)
    assert.ok(r.text.includes('- 下一步修复：在 verify.mjs 的 env 中加 `CFB_REAL_DSH_HOME: tmp`'), r.text)
    assert.ok(!r.text.includes('sudo chown'), '否定句不补')
    const withIf = [...base, { id: 'o2', k: 'IF', ev: 'derived', cond: 'verify.mjs 没设该变量', then: '根因明确', anchor: '则根因明确' }]
    const r2 = I.compileV4(JSON.stringify({ ops: withIf }), raw, {})
    assert.ok(!r2.text.includes('- 若 grep 显示'), '已标 IF ⇒ 不补 IF'); assert.equal(r2.stats.autoHints, 1)
    const r3 = I.compileV4(JSON.stringify({ ops: base }), raw, { compressV4AutoHints: false })
    assert.ok(!r3.stats.autoHints && !r3.text.includes('若 grep'))
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
    assert.ok(r.text.includes('Still to confirm: is /srv/app/conf.yaml a symlink.'), r.text)
  })

  // ═══ §6 compileV4 ═════════════════════════════════════════════════════════
  await test('§6a 成功：统计完整（条目 / 各规则拒绝 / 选取 / 丢弃 / 语言 / 预算 / 字符）', () => {
    const r = I.compileV4('```json\n' + JSON.stringify({ ops: [...OPS, { k: 'FACT', ev: 'tool', text: 'x', anchor: '不存在' }] }) + '\n```', RAW, {})
    assert.ok(r.ok)
    assert.equal(r.stats.ops, 9); assert.equal(r.stats.valid, 8); assert.deepEqual(r.stats.rejected, { I1: 1 })
    assert.equal(r.stats.selected, 7); assert.equal(r.stats.dropped.verify, 1); assert.equal(r.stats.lang, 'zh'); assert.equal(r.stats.budget, 800, '预算下限 800')
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
    let reply = OPS_JSON, lastBody = null, delayFirst = 0, hits = 0
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => {
        lastBody = JSON.parse(b)
        const d = hits++ === 0 ? delayFirst : 0
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }))
        }, d)
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
        assert.ok(lastBody.messages[0].content.includes(LONG) && lastBody.messages[0].content.endsWith(I.V4_TAIL))
        assert.equal(lastBody.max_tokens, 1600)
        assert.ok(r.text.includes('已排除权限问题') && !r.text.includes('{'))
        assert.equal(r.meta.promptVersion, 'compress-v4-ops9:800:inc1200')
        assert.equal(r.meta.v4.selected, 7)
        const t = traces.find(([x]) => x === 'compiler-v4-compiled')
        assert.ok(t && t[1].ok === true && t[1].valid === 8 && typeof t[1].compileMs === 'number', JSON.stringify(t))
        assert.equal(I.settledTraceData(0, 1, { ok: true, text: r.text, meta: r.meta }).v4.selected, 7, 'v4 统计进 settled 白名单')
      })
      await test('§7e makeV4SegmentCompiler：尾段流式可开（缺省关）、非尾段非流式；每段输出上限 1200', async () => {
        reply = OPS_JSON
        await I.makeV4SegmentCompiler(cfg)(RAW, [], undefined, { tail: false })
        assert.ok(!lastBody.stream); assert.equal(lastBody.max_tokens, 1200)
        await I.makeV4SegmentCompiler(cfg)(RAW, [], undefined, { tail: true })
        assert.ok(!lastBody.stream, '缺省关（真机：多等 1.5 s 换不来尾巴）')
        await I.makeV4SegmentCompiler({ ...cfg, compressV4TailStream: true })(RAW, [], undefined, { tail: true })
        assert.equal(lastBody.stream, true)
      })
      await test('§7f makeV4SegmentCompiler：非尾段超时未回 ⇒ 对冲一份（先回者胜）；尾段不对冲', async () => {
        reply = OPS_JSON; delayFirst = 600; hits = 0
        const r = await I.makeV4SegmentCompiler({ ...cfg, compressV4SegmentHedgeMs: 150 })(RAW, [], undefined, { tail: false })
        assert.ok(r.ops.length > 0); assert.equal(hits, 2, '主请求 600ms 未回 ⇒ 150ms 后对冲')
        delayFirst = 600; hits = 0
        await I.makeV4SegmentCompiler({ ...cfg, compressV4SegmentHedgeMs: 150 })(RAW, [], undefined, { tail: true })
        assert.equal(hits, 1, '尾段不对冲'); delayFirst = 0
      })
      await test('§7b 副模型给散文（不守格式）⇒ 抛错，meta 带 v4.reason；trace 留痕', async () => {
        reply = '权限不是问题，是路径错配。'
        const traces = []
        await assert.rejects(I.makeBirthCompiler(cfg)(LONG, undefined, { trace: (t, d) => traces.push([t, d]) }), (e) => {
          assert.equal(e.message, 'v4-unparseable'); assert.equal(e.meta.v4.reason, 'v4-unparseable'); assert.equal(e.meta.promptVersion, 'compress-v4-ops9:800:inc1200'); return true
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
    assert.ok(r.text.includes('- 查路径配置（已排除权限问题') && r.text.includes('还要确认：'), r.text)
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
  await test('§9d 中间段失败 ⇒ 该段原文放在渲染稿前面（原文空洞），后面成功的段照用；全部失败 ⇒ 抛错；cancel 掐掉在飞请求', async () => {
    const bad = async (segText) => { if (segText.includes('第二段')) throw new Error('boom'); return { ops: opsFor(segText) } }
    const sg = I.createSegmenter({ cfg: segCfg, compileSegment: bad })
    sg.feed(SEGS[0] + SEGS[1] + SEGS[2].slice(0, 40))
    assert.equal(sg.segments.length, 2)
    const r = await sg.finish(FULL)
    assert.ok(r.meta.v4.partial); assert.equal(r.meta.v4.gapSegments, 1); assert.equal(r.meta.v4.compiledSegments, 2)
    assert.ok(r.text.startsWith(SEGS[1].trim()), '失败段原文在最前（比后段结论旧）')
    assert.ok(r.text.includes('APP_CONF 指向旧路径') && r.text.includes('已排除权限问题'), '失败段前后的成功段都要用上')
    assert.ok(!r.text.includes('最后的想法'), '最后一段已编译 ⇒ 没有原文尾巴')
    // 失败的是最后一段 ⇒ 原文尾巴（旧行为保留）
    const sg2 = I.createSegmenter({ cfg: segCfg, compileSegment: async (t) => { if (t.includes('第三段')) throw new Error('x'); return { ops: opsFor(t) } } })
    sg2.feed(SEGS[0] + SEGS[1] + SEGS[2].slice(0, 40))
    const r2 = await sg2.finish(FULL)
    assert.ok(r2.text.endsWith(SEGS[2]) && r2.meta.v4.gapSegments === 0)
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
    assert.ok(!text.includes('最后的想法') && text.includes('还要确认：'), text)
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
  await test('§9j 状态后写者胜：旧段的当前方案降级、旧段的未决丢弃（被依赖的保留）、证伪不动', () => {
    const mk = (id, k, extra = {}) => ({ id, idx: 0, k, ev: 'derived', kind2: null, text: id, anchor: '', key: '', src: '', alt: 'x', why: 'y', trigger: '', supersedes: '', deps: [], ...extra })
    const st = {}
    const out = I.freshenState([mk('s1.o1', 'INCUMBENT'), mk('s1.o2', 'OPEN'), mk('s1.o3', 'OPEN'), mk('s1.o4', 'REFUTED'),
      mk('s2.o1', 'FACT', { deps: ['s1.o3'] }), mk('s3.o1', 'INCUMBENT'), mk('s3.o2', 'OPEN')], st)
    const k = Object.fromEntries(out.map((o) => [o.id, o.k]))
    assert.equal(k['s1.o1'], 'COMPUTED'); assert.equal(k['s3.o1'], 'INCUMBENT')
    assert.ok(!('s1.o2' in k)); assert.equal(k['s1.o3'], 'OPEN', '被依赖的旧未决保留')
    assert.equal(k['s1.o4'], 'REFUTED'); assert.equal(k['s3.o2'], 'OPEN')
    assert.deepEqual(st.stale, { demotedIncumbent: 1, droppedOpen: 1 })
    // 最后一段没有 INCUMBENT ⇒ 取最后一个有的段
    const out2 = I.freshenState([mk('s1.o1', 'INCUMBENT'), mk('s2.o1', 'INCUMBENT'), mk('s3.o1', 'FACT')])
    assert.deepEqual(out2.map((o) => o.k), ['COMPUTED', 'INCUMBENT', 'FACT'])
  })
  await test('§9k supersedes 写成条目 id ⇒ 当 retracts 处理，不渲染内部 id', () => {
    const m = I.mergeSegmentOps([{ n: 1, ops: [{ id: 'o1', k: 'COMPUTED', text: 'A' }] }, { n: 2, ops: [{ id: 'o1', k: 'INCUMBENT', text: 'B', supersedes: 's1.o1' }, { id: 'o2', k: 'FACT', text: 'C', supersedes: 'o1' }] }])
    assert.deepEqual(m[1].retracts, ['s1.o1']); assert.equal(m[1].supersedes, '')
    assert.deepEqual(m[2].retracts, ['s2.o1'])
    const n = I.normalizeOp({ id: 'o3', k: 'INCUMBENT', text: 'x', supersedes: 'o1, o2' }, 0)
    assert.deepEqual(n.retracts, ['o1', 'o2']); assert.equal(n.supersedes, '')
    assert.equal(I.normalizeOp({ k: 'INCUMBENT', text: 'x', supersedes: '旧路径 /etc/a' }, 0).supersedes, '旧路径 /etc/a')
  })
  await test('§9l 固定键跨段后写者胜（key=root-cause）；死路不参与 I7；此前已标注带 key', () => {
    const raw = '一开始以为是权限问题，试了 chmod 777 仍然失败。后来怀疑是缓存。最后确认根因是路径错配。'
    const merged = I.mergeSegmentOps([
      { n: 1, ops: [{ id: 'o1', k: 'COMPUTED', text: '根因是权限问题', key: 'root-cause', anchor: '一开始以为是权限问题' },
                    { id: 'o2', k: 'REFUTED', ev: 'tool', text: '权限问题', key: 'root-cause', alt: '查缓存', why: 'chmod 777 仍然失败', anchor: '试了 chmod 777' }] },
      { n: 2, ops: [{ id: 'o1', k: 'COMPUTED', text: '根因可能是缓存', key: 'root-cause', anchor: '后来怀疑是缓存' }] },
      { n: 3, ops: [{ id: 'o1', k: 'INCUMBENT', text: '根因是路径错配', key: 'root-cause', anchor: '最后确认根因是路径错配' }] }])
    const v = I.validateOps(merged, raw)
    assert.deepEqual(v.kept.map((o) => o.id), ['s1.o2', 's3.o1'])
    assert.equal(v.rejected.filter((r) => r.rule === 'I7').length, 2)
    assert.ok(I.priorLines(v.kept)[1].startsWith('s3.o1 [INCUMBENT key=root-cause]'))
  })
  await test('§9m 合并：全局形态的引用不再加前缀；自起 sN.xxx 形态的 id 改名；固定键不挂「取代」', () => {
    const m = I.mergeSegmentOps([{ n: 5, ops: [{ id: 's4.o1', k: 'COMPUTED', text: 'A', retracts: ['s4.o1'] }, { id: 'o2', k: 'FACT', text: 'B', deps: ['o2x', 's3.o1'] }] }])
    assert.equal(m[0].id, 's5.x1'); assert.deepEqual(m[0].retracts, ['s4.o1'])
    assert.deepEqual(m[1].deps, ['o2x', 's3.o1'])
    const raw = '先认为根因是缓存。后来确认根因是缓存键里没带版本号。配置在 /etc/a 后来改到 /etc/b。'
    const v = I.validateOps([{ id: 'a', k: 'COMPUTED', text: '根因是缓存', key: 'root-cause', anchor: '先认为根因是缓存' },
      { id: 'b', k: 'INCUMBENT', text: '根因是缓存键里没带版本号', key: 'root-cause', anchor: '后来确认根因' },
      { id: 'c', k: 'FACT', text: '配置在 /etc/a', key: 'conf', anchor: '配置在 /etc/a' },
      { id: 'd', k: 'FACT', text: '配置在 /etc/b', key: 'conf', anchor: '后来改到 /etc/b' }], raw)
    assert.equal(v.kept.find((o) => o.id === 'b').supersedes, '', '固定键：细化不挂取代')
    assert.equal(I.normalizeOp({ k: 'INCUMBENT', text: 'x', key: 'root-cause', supersedes: '根因是时序竞态' }, 0).supersedes, '', '固定键：模型自己写的取代也不渲染')
    assert.equal(I.normalizeOp({ k: 'COMPUTED', text: 'x', supersedes: 'timing-margin' }, 0).supersedes, '', '键名形态不是旧值')
    assert.equal(v.kept.find((o) => o.id === 'd').supersedes, '配置在 /etc/a', '改值键：照旧挂取代')
  })
  await test('§9n 首段减半：首段按一半段长切，之后按全段长', () => {
    const fired = []
    const sg = I.createSegmenter({ cfg: { compressPrompt: 'v4', compressV4SegmentChars: 400 }, compileSegment: async (t) => { fired.push(t.length); return { ops: [] } } })
    const para = '这是一句话。'.repeat(20) + '\n\n'   // 122 字一段
    sg.feed(para.repeat(12))
    assert.ok(sg.segments[0].text.length <= 300 && sg.segments[0].text.length >= 120, 'first=' + sg.segments[0].text.length)
    assert.ok(sg.segments[1].text.length > 300, 'second=' + sg.segments[1].text.length)
    sg.cancel('test')
  })
  await test('§9o auto：窗口 ≥5 s 走整块、<5 s 走增量；true/false 强制；非 v4 永远 false', () => {
    assert.equal(I.v4Incremental({ compressPrompt: 'v4' }), true, '缺省窗口 1500 ⇒ 增量')
    assert.equal(I.v4Incremental({ compressPrompt: 'v4', birthFinishWaitMs: 8000 }), false)
    assert.equal(I.v4Incremental({ compressPrompt: 'v4', birthFinishWaitMs: 8000, compressV4Incremental: true }), true)
    assert.equal(I.v4Incremental({ compressPrompt: 'v4', compressV4Incremental: false }), false)
    assert.equal(I.v4Incremental(I.normalizeConfig({ compressPrompt: 'v4', birthFinishWaitMs: 8000 })), false, 'normalizeConfig 后缺省 auto 生效')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', birthFinishWaitMs: 8000 }), 'compress-v4-ops9:800')
  })
  await test('§9p 在飞段数上限：突发到达时最多放出 3 段，其余等空位 / 并入尾段', async () => {
    const pend = []
    const sg = I.createSegmenter({ cfg: { compressPrompt: 'v4', compressV4SegmentChars: 200 }, compileSegment: () => new Promise((res) => pend.push(res)) })
    const text = ('这是一句话。'.repeat(12) + '\n\n').repeat(20)
    sg.feed(text)
    assert.equal(sg.segments.length, 3)
    await new Promise((r) => setTimeout(r, 5)); pend[0]({ ops: [] }); await new Promise((r) => setTimeout(r, 5))
    sg.feed(text)
    assert.equal(sg.segments.length, 4, '空出一个位置 ⇒ 再放一段')
    sg.cancel('test')
  })
  await test('§9i makeV4SegmentCompiler：分段提示词（带此前已标注）、promptVersion 加 :seg、解析失败抛错', async () => {
    const p = I.buildCompressPromptV4Segment('SEG', ['s1.o1 [FACT] a'])
    assert.ok(p.startsWith(I.buildCompressPromptV4('').slice(0, -('【上一轮思维链】\n'.length + I.V4_TAIL.length))), '规则前缀与整块 v4 逐字相同（缓存前缀稳定）')
    assert.ok(p.endsWith('【此前已标注】\ns1.o1 [FACT] a\n\n【本段】\nSEG' + I.V4_TAIL))
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
  // ---- §5o compress-v4-direct（v12.6，oracle C 形态固化）：直写散文 + 程序门 ----
  await test('5o1 buildCompressPromptV4Direct：风格样例 / ctx / 尾段重申', () => {
    const p = I.buildCompressPromptV4Direct('RAW原文', '任务观察ctx')
    assert.ok(p.startsWith('你是思维链压缩器'), p.slice(0, 40))
    assert.ok(p.includes('【风格样例】') && p.includes('所以下一步工具调用是'), '样例演示收尾形态')
    assert.ok(p.includes('【当前任务与观察】\n任务观察ctx'))
    assert.ok(p.endsWith(I.V4D_TAIL), '尾段重申')
    assert.ok(!I.buildCompressPromptV4Direct('RAW').includes('【当前任务与观察】'), '无 ctx 不带块')
  })
  await test('5o2 compressPromptVersion/For：v4d 分流', () => {
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4Direct: true, compressCtx: 'x' }), 'compress-v4d2:ctx')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v4', compressV4Direct: true }), 'compress-v4d2:noctx')
    const p = I.compressPromptFor({ compressPrompt: 'v4', compressV4Direct: true, compressCtx: 'T' }, 'COT')
    assert.ok(p.includes('【上一轮思维链】\nCOT') && p.includes('【当前任务与观察】\nT'))
  })
  await test('5o3 compileV4Direct：锚点逐字硬校验（编造剥反引号）', () => {
    const raw = 'read_file 显示 const port = 8123 // 旧端口，我准备改 loadConfig()。'
    const good = '看起来端口错了。read_file（逐字）：\n`const port = 8123 // 旧端口`\n所以下一步工具调用是 read_file src/config.js。如果解析是 5432，那么改 `loadConfig()`。'
    const r = I.compileV4Direct(good, raw, {})
    assert.equal(r.ok, true); assert.equal(r.stats.inventedSpans, 0); assert.ok(r.text.includes('`const port = 8123 // 旧端口`'))
    assert.equal(r.stats.closeLoop, true); assert.equal(r.stats.provenance, true); assert.equal(r.stats.register, true)
    const bad = I.compileV4Direct('结论是 `fakeIdentifier42` 的问题，所以修它。如果没用，那么回头。', raw, {})
    assert.equal(bad.ok, true); assert.equal(bad.stats.inventedSpans, 1)
    assert.ok(!bad.text.includes('`fakeIdentifier42`'), '编造标识符被剥掉反引号')
    assert.ok(bad.text.includes('fakeIdentifier42'), '内容保留，只是不再假称逐字')
  })
  await test('5o4a compileV4Direct：R5 直改可用句条件补句', () => {
    const raw = 'read_file 显示 const port = 8123 // 旧端口。改法想好了：删掉它。'
    const need = '看起来端口错了。read_file（逐字）：\n`const port = 8123 // 旧端口`\n所以下一步工具调用是 bash grep port。如果确认，那么需要改 src/pool.js 删掉这一行。'
    const r = I.compileV4Direct(need, raw, {})
    assert.equal(r.stats.repairedAffordance, true)
    assert.ok(r.text.endsWith('上面逐字引出的代码行可以直接当 edit_file 的 old_text。'), r.text)
    const has = '改法是删掉。这一行的逐字原文已给出，可以直接当 edit_file 的 old_text。'
    const r2 = I.compileV4Direct('`const port = 8123 // 旧端口` 是元凶。' + has, raw, {})
    assert.ok(!r2.stats.repairedAffordance, '已有可用句不重复补')
    const noFix = I.compileV4Direct('`const port = 8123 // 旧端口` 很可疑。所以下一步工具调用是 grep。如果找到，那么再定。', raw, {})
    assert.ok(!noFix.stats.repairedAffordance, '尾段没落到具体改法不补')
  })
  await test('5o4 compileV4Direct：围栏 / 空 / 超长熔断 / 观察也算原文', () => {
    const r = I.compileV4Direct('```\n看起来 x=1。所以下一步工具调用是 grep。如果找到，那么改。\n```', 'x=1 在日志里', {})
    assert.equal(r.ok, true); assert.equal(r.stats.unfenced, true)
    assert.equal(I.compileV4Direct('  ', 'raw', {}).ok, false)
    assert.equal(I.compileV4Direct('  ', 'raw', {}).reason, 'v4d-empty')
    const long = I.compileV4Direct('看起来。'.repeat(400), 'raw', {})
    assert.equal(long.ok, false); assert.equal(long.reason, 'v4d-too-long')
    const viaObs = I.compileV4Direct('（逐字）`git diff 里的 compressTargetMax: 1800,`。所以下一步是改回。如果仍慢，那么再查。', '上一轮推理没引这行',
      { compressCtx: 'git diff 里的 compressTargetMax: 1800,' })
    assert.equal(viaObs.stats.inventedSpans, 0, '任务观察里的逐字片段不算编造')
  })
  // ---- §5p S8-R7 判读分支的动作闭合与落点绑定（v12.7）----
  const CTX = '[tool: read_file] test/hedge.selftest.mjs §4\n  server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600\n  assert.equal(meta.hedgeStartedAt, null)\n' +
    '[tool: read_file] src/distill.js hedgedDistill 节选\n  const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)\n  primary.then(() => { primarySettled = true })\n' +
    '[tool: bash] git diff\n  -  compressTargetMax: 450,\n  +  compressTargetMax: 1800,\n[tool: bash] nproc (CI) → 2'
  const RAW7 = '原文里引过 const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs) 这一行，改法是拉大余量或 fake timers。'
  await test('5p1 分支自带逐字落点：可用句写进该分支句内（不是游离在末尾）', () => {
    const t = '看起来是时序竞态。所以下一步工具调用是 bash 复现。如果失败复现，那么改测试 §4 的 `hedgeAfterMs: 1600`，把余量拉大；如果始终不复现，那么去查 CI 负载。'
    const r = I.compileV4Direct(t, RAW7, { compressCtx: CTX })
    assert.equal(r.ok, true)
    assert.equal(r.stats.fixBranches, 1); assert.equal(r.stats.boundBranches, 1); assert.deepEqual(r.stats.boundBy, ['span'])
    assert.ok(r.text.includes('把余量拉大——落点 `hedgeAfterMs: 1600` 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件；如果始终不复现'), r.text)
    assert.ok(!r.stats.repairedAffordance, '绑定成功 ⇒ 不再追加游离的通用句')
    assert.ok(!r.text.endsWith('上面逐字引出的代码行可以直接当 edit_file 的 old_text。'))
  })
  await test('5p2 分支无落点：按标识符重叠从任务观察绑定，中文节选行收窄到「键: 值」；析取只统计', () => {
    const t = '`const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)` 是 read_file 逐字。看起来余量只有 100ms。所以下一步工具调用是 bash 复现。' +
      '如果失败复现，那么把 hedgeAfterMs 与主请求延迟拉开或改用 fake timers 即可；如果始终不复现，那么去查 CI 里是否有并行用例，而不是改 src/distill.js。'
    const r = I.compileV4Direct(t, RAW7, { compressCtx: CTX })
    assert.equal(r.stats.fixBranches, 1, '「而不是改 src/distill.js」是否定，不算改法分支')
    assert.deepEqual(r.stats.boundBy, ['overlap']); assert.equal(r.stats.disjunctiveFix, 1)
    assert.ok(r.text.includes('改用 fake timers 即可——落点 `hedgeAfterMs: 1600` 的逐字原文已给出'), r.text)
    assert.ok(!r.text.includes('server 延迟：主请求'), '混着中文的节选行收窄到 hedgeAfterMs: 1600')
  })
  await test('5p3 落点候选的排除：命令 / 日志行 / 光秃标识符 / 路径 / diff 删除行；「补 `X`」的 X 是新文本不是落点', () => {
    assert.equal(I.usableLocus('grep -R "CFB_REAL_DSH_HOME" -n verify.mjs test src'), false)
    assert.equal(I.usableLocus('FAIL test/birth.selftest.mjs  Error: EACCES'), false)
    assert.equal(I.usableLocus('run 1: PASS  17 passed  (hedge 3.1s)'), false)
    assert.equal(I.usableLocus('CFB_REAL_DSH_HOME'), false)
    assert.equal(I.usableLocus('/home/u/.dsh'), false)
    assert.equal(I.usableLocus('-  compressTargetMax: 450,'), false)
    assert.equal(I.usableLocus('+  compressTargetMax: 1800,'), true)
    assert.equal(I.usableLocus('const env = { ...process.env, DSH_HOME: tmp }'), true)
    const ctx = '[tool: read_file] verify.mjs (节选)\n  const env = { ...process.env, DSH_HOME: tmp }\n[tool: bash] grep\n  grep -R "CFB_REAL_DSH_HOME" -n verify.mjs test src'
    const t = '看起来隔离没对齐。所以下一步工具调用是 bash grep。如果 grep 显示 verify.mjs 没设置该变量，那么就在 verify.mjs 的 env 里补 `CFB_REAL_DSH_HOME: tmp`。'
    const r = I.compileV4Direct(t, 'raw 里写过 CFB_REAL_DSH_HOME: tmp', { compressCtx: ctx })
    assert.deepEqual(r.stats.boundBy, ['overlap'])
    assert.ok(r.text.includes('补 `CFB_REAL_DSH_HOME: tmp`——落点 `const env = { ...process.env, DSH_HOME: tmp }` 的逐字原文已给出'), r.text)
  })
  await test('5p4 点名文件压过单个标识符重叠；改法词 + 取证措辞（改用 docker 再复现）不算改法；diff 改回 ⇒ 绑 + 行', () => {
    const ctx = '[tool: read_file] verify.mjs (节选)\n  const env = { ...process.env, DSH_HOME: tmp }\n[tool: read_file] test/birth.selftest.mjs 第 1-12 行\n  import { makeTraceWriter } from \'../src/trace.js\'\n  const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })'
    const t = 'CFB_REAL_DSH_HOME 绕过了隔离。所以下一步工具调用是 bash grep。如果输出显示已设为 tmp 却仍写真实路径，那么改 birth.selftest 这一行用 DSH_HOME。'
    const r = I.compileV4Direct(t, 'raw', { compressCtx: ctx })
    assert.ok(r.text.includes('用 DSH_HOME——落点 `const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`'), r.text)
    const probe = I.compileV4Direct('所以下一步工具调用是 bash 复现。如果 50 次全 PASS，那么需要改用 `docker run --cpus=2` 再压事件循环复现。', 'raw', { compressCtx: CTX })
    assert.ok(!probe.stats.fixBranches, '换复现手段不是改法')
    const diff = I.compileV4Direct('所以下一步工具调用是 bash 看 finishReason。如果升级前是 stop，那么主因是 compressTargetMax，把它回退到 450 再测。', 'raw', { compressCtx: CTX })
    assert.ok(diff.text.includes('——落点 `+  compressTargetMax: 1800,`'), diff.text)
  })
  await test('5p5 已有可用句的分支不动；compressV4DirectBind:false 回到 v12.6 行为', () => {
    const had = '所以下一步工具调用是 bash 复现。如果失败复现，那么改 `hedgeAfterMs: 1600`——这一行的逐字原文已给出，可以直接当 edit_file 的 old_text，不用再读文件。'
    const r = I.compileV4Direct(had, RAW7, { compressCtx: CTX })
    assert.deepEqual(r.stats.boundBy, ['had']); assert.ok(!r.text.includes('——落点'))
    const t = '看起来是时序竞态，余量只有 100ms。所以下一步工具调用是 bash 复现。如果失败复现，那么改测试 §4 的 `hedgeAfterMs: 1600`，改法是把余量拉大。'
    const off = I.compileV4Direct(t, RAW7, { compressCtx: CTX, compressV4DirectBind: false })
    assert.equal(off.stats.boundBranches, undefined); assert.equal(off.stats.repairedAffordance, true)
    assert.ok(off.text.endsWith('上面逐字引出的代码行可以直接当 edit_file 的 old_text。'))
  })
  await test('5p6 v4d2 提示词：样例分支闭合（落点 + 可用句 + 不再复现）、候选落定、下一步 = 原文实际发出的调用', () => {
    const p = I.buildCompressPromptV4Direct('RAW', 'CTX')
    assert.ok(p.includes('把 `const port = 8123 // 旧端口` 删掉') && p.includes('可以直接当 edit_file 的 old_text，拨测结果一到就改，不用再读文件、不再复现'), '样例分支闭合')
    assert.ok(p.includes('只落定一个') && p.includes('不要写「A 或 B」两可'), '候选落定规则')
    assert.ok(p.includes('X 就是原文最后决定发出的那一条调用'), '回溯一致')
    assert.ok(!p.includes('证据是否充分按这个标准判'), 'v4d1 的下一步仲裁已撤回')
    assert.ok(I.V4D_TAIL.includes('逐字落点'))
  })
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
}
console.log(`\nPASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
