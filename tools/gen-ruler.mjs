#!/usr/bin/env node
// tools/gen-ruler.mjs —— 生成式压缩稿的尺子 v1（硬门 + 软分），$0、零依赖、机械可复算。
//
// 为什么要有它（这条尺子存在的唯一理由）：
//   仓库里已经有一套「尺子」，是 tools/gold-check.mjs 那一族：它只检查
//   引用是否逐字、反引号是否配对、长度是否超线 —— 全是**形式**。于是
//   tools/gold-forge2.mjs 第 48 行用「raw 里最长的文件名」当选落点，产出
//   「落点：/home/u/.dsh/storages/cot-form-b/trace.log」（症状路径，不是改点）
//   而 C1–C6 全过。形式尺子量不出语义错误，这就是它必须被换掉的原因。
//
// 尺子是什么、不是什么（架构铁律）：
//   * 尺子是**判别器**，不是**生成器**。它回答「给定 raw，这份稿子能不能用」，
//     而不是「稿子应该怎么写」。教师绝不能是「执行这把尺子的程序」—— 那会
//     重建 v5 的病灶：tools/micro-generator/teach-shape.mjs 第 447 行自己写着
//     「the teacher executes the same rulers it is scored with => later student
//     numbers are same-source measurements」。同源测量等于没测量。
//   * 硬门是布尔，任一不过 => 拒稿 => 回退 raw。这是「不劣于原稿」的实现：
//     不是证明出来的，是靠 100% 无损兜底保证的。
//   * 软分只用来给**已过硬门**的稿子排序，绝不用来救活一份不过门的稿。
//
// ── gen-ruler/4：**硬门只装布尔不变量，程度放软分** ──
//
// 七道硬门（全是「是/否」，没有一道是「多少」）：
//   G0 no-leverage         这一对 (raw, ctx) 本身有没有受力点。**不看稿子**，是尺子的资格门
//   G1 quote-grounded      稿中引号片段里的锚点必须出现在 raw ∪ ctx（否则 = 凭空）
//   G2 locus-grounded      落点必须是 raw 里出现在**动作语境**中的路径，不能是症状路径
//   G3 anchors-kept        题面失败陈述里的承重锚点必须活下来（这才是 sse-truncated 真死的机理）
//   G4 actionable          稿里至少要有一个接地的落点或验证命令（不然读完没法动手）
//   G5 no-cause-inversion  不得把 raw 的因果方向反过来（窄检测：只抓带反转标记的对调）
//   G6 not-copy            剔除合法引用后，稿子与 raw 的 16-gram 覆盖率 < 0.5（否则 = 照抄）
//
// G7 compressed 在 gen-ruler/4 **从硬门下架，改成软标准**（COMPRESSION_TARGET）。
// 理由与实测证据见 judge() 里 G7 那一段的注释。一句话：它不是布尔量，而且它一直在
// 掩盖学生的真实缺口（阈值放宽后师生差距从 15.1 点**扩大**到 41.1 点）。
//
// 软分（权重和为 1，全部在代码里，注释与代码对不上就是注释错）：
//   S1 anchorsKept .28   S2 groundingDensity .18   S3 decisionCoverage .18
//   S4 compressionGain .13   S5 tailRetention .13   S6 quoteFidelity .10
//   S5 是**反抽取**的那一刀：抽取器只会捞开头，凡是尾部锚点整片丢失的稿子，
//   它的语义覆盖就是假的。这一维让「删掉探索过程」这件事第一次有了代价。
//   S4 是**压缩**唯一该待的地方（G7 下架后它独自承担这件事）。
//
// ⚠ 权重在 v4 **一个都没动**。这是刻意的：v9 那一轮的软分（教师 0.6957 / 学生 0.5638）
// 必须能和 v4 之后的软分直接比，动了权重就比不出来了。
// 「现在先软标准」要的是把压缩从硬门挪到软分，不是把软分重算一遍。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// v2（2026-10）：G7 从「字符比」改成「token 比」。理由是一条实测反例 ——
// 同一批 100 条，v3 提示词把稿子从 1165 字压到 1187 字（字符比 0.471，过 G7），
// 但 raw 是英文、稿子是中文：raw 3.75 字符/token、稿 1.85 字符/token ⇒
// **token 比 0.978，等于没压缩**。字符比会把「翻译成中文」误判成压缩。
// 用生产同一个估算器（src/tokens.js，中文 0.6 / 其余 0.3），不另立口径。
import { estimateTokens } from '../src/tokens.js'

export const RULER_VERSION = 'gen-ruler/4'

// ── 压缩：软标准，不是硬门（gen-ruler/4）──
//
// 这三个常数合起来表达一句话：**现在先软标准，以后再训练到 0.5。**
//   COMPRESSION_TARGET  产品要的压缩比。判据是 token 比（gen-ruler/2 起），不是字符比。
//                       0.5 是用户定的目标：先按这个训，训到之前不拦稿、只记账。
//   COMPRESSION_HARD_MAX 硬门上限。null = **不设硬门**（当前状态）。
//                       等学生真训到 0.5 了，把它改成 0.5 就重新装上 —— 只改这一个数，
//                       别的地方一行都不用动。这就是把它做成常数而不是写死的理由。
//   COMPRESSION_SANITY  纯粹的荒谬线：稿子比原文还长就不叫压缩稿。**不进门，只进 advisory**。
//                       设它是因为 G6（16-gram 覆盖率 < 0.5）抓不住「换个说法把话说长」——
//                       那种稿子覆盖率很低、过 G6，却一个字都没压。记账用，不拦稿。
export const COMPRESSION_TARGET = 0.5
export const COMPRESSION_HARD_MAX = null
export const COMPRESSION_SANITY = 1.0
// 承重**标识符**保留率下限（承重路径另算，一个都不许丢）。
//
// 实测依据（61 条真手稿，.cfb-offline/ruler/report-hand.json）：
//   标识符保留率 [min,q25,med,q75,max] = [0, 1, 1, 1, 1]，55/61 是满分 1.0，6 条是 0。
//   也就是**双峰**，中间没有样本：0.34 / 0.5 / 0.75 / 1.0 任何一条线，
//   影响的都是同样那 6 条。
// 所以这个常数不是敏感参数 —— 它落在两个峰之间的空谷里，这个事实本身就说明
// 「保留率」这个量在当前数据上是有判别力的，不是靠调阈值调出来的。
// 不设成 1.0 是留出余量：回归集一变大，中间地带必然会有人。
export const ANCHOR_FLOOR = 0.5
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TICK = '\u0060'
const LQ = '\u300c'   // 「
const RQ = '\u300d'   // 」
const LD = '\u201c'   // “
const RD = '\u201d'   // ”

export const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
// 逐字核对前先抹掉行内代码记号：gold-forge2 第 53/54/56/57 行会 .replace(/[`\u300c\u300d]/g,'') 把反引号
// 从引用里刮掉，所以仓库里的「逐字引用」其实不是逐字的。反引号是排版不是内容 —— 抹掉它再比，
// 既保住「抓凭空」的本意，又不把排版噪声判成造假。
export const stripFmt = (s) => norm(String(s == null ? '' : s).replace(/\u0060/g, ''))

// 首个字符必须是词字符或 / —— 否则会把 ".selftest.mjs" 这种断尾当成一个路径。
const PATH_RX = /[\w/][\w./\\-]*\.(?:mjs|js|mts|ts|tsx|json|jsonl|log|md|py|sh|yml|yaml|toml|txt)/g
const ENV_RX = /\b[A-Z][A-Z0-9_]{3,}\b/g
const NUM_RX = /(?:^|[^\w.])(\d{2,})(?![\w])/g
const CODE_RX = new RegExp(TICK + '([^' + TICK + '\\n]{2,80})' + TICK, 'g')
// camelCase / snake_case 标识符。这是旧版最大的一个漏洞：ENV_RX 只认 ALL_CAPS，
// 于是 hedgeStartedAt / primarySettled / finish_reason 这些**真正的承重锚点**一个都没进过集合。
// sse-truncated 那条真回归（raw 修好了、稿子没修好）死的就是这些符号，尺子却看不见它们 ——
// 一把看不见承重件的尺子，当然量不出丢件。
const CAMEL_RX = /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g
const SNAKE_RX = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g
// 技术 token 兜底：任何**含下划线/斜杠/反斜杠/数字**的词。CAMEL_RX / SNAKE_RX 都有缝：
// 给一个标识符粘个后缀（primarySettled -> primarySettled_v2）两边都抓不到，
// 于是「凭空」可以直接从缝里走过去 —— 这是负例审计里 N3 唯一能逃的一种形态。
// 「e.g.」这种只有点的缩写不算（集合里没有 . ），纯小数也不算。
// 以字母开头、以词字符结尾 —— 绝不能以 / 或 . 收尾。
// 原来写成 /\b[\w./\\-]*[_/\\\d][\w./\\-]*\b/ 会吐出 "a/b/" 这种尾巴带斜杠的 token，
// 于是 base("a/b/") === ''，接着 indexOf('') 恒等于当前位置、游标不前进 —— 整个 CLI 挂死；
// 更阴的是 hasAnchor 里的 includes('') 恒为 true，会让**所有**锚点都被判成「还在」。
// 一个字符类写松了，同时买到一次死循环和一次静默失真。
const TECH_RX = /[A-Za-z][A-Za-z0-9_\\/-]*/g

/** 稿中所有引号区间 [start, end)，含 「」、“”、反引号。 */
export function quoteSpans(text) {
  const t = String(text == null ? '' : text)
  const out = []
  const add = (a, b) => {
    let i = 0
    for (;;) {
      const s = t.indexOf(a, i)
      if (s < 0) return
      const e = t.indexOf(b, s + a.length)
      if (e < 0) return
      out.push([s, e + b.length])
      i = e + b.length
    }
  }
  add(LQ, RQ)
  add(LD, RD)
  add(TICK, TICK)
  return out.sort((x, y) => x[0] - y[0])
}

/** 把引号区间挖成空格（等长，保持下标对齐）。用于「引用合法、正文才判照抄」。 */
export function maskQuotes(text) {
  const t = String(text == null ? '' : text)
  const a = t.split('')
  for (const [s, e] of quoteSpans(t)) for (let i = s; i < e; i++) a[i] = ' '
  return a.join('')
}

export function quotedFragments(text) {
  const t = String(text == null ? '' : text)
  return quoteSpans(t).map(([s, e]) => t.slice(s, e).replace(new RegExp('^[' + LQ + RQ + LD + RD + TICK + ']+|[' + LQ + RQ + LD + RD + TICK + ']+$', 'g'), '').trim())
}

/** 承重锚点：路径 / 环境变量 / 反引号 token / 多位数字。 */
export function anchorsOf(text) {
  const t = norm(text)
  const out = new Set()
  for (const m of t.matchAll(PATH_RX)) out.add(m[0])
  for (const m of t.matchAll(ENV_RX)) out.add(m[0])
  for (const m of t.matchAll(CODE_RX)) {
    const v = m[1].trim()
    if (v.length >= 3 && v.length <= 80) out.add(v)
  }
  for (const m of t.matchAll(CAMEL_RX)) out.add(m[0])
  for (const m of t.matchAll(SNAKE_RX)) out.add(m[0])
  for (const m of t.matchAll(TECH_RX)) {
    const v = m[0]
    // /[_\\\d]/ 这个条件不能省。省掉之后 TECH_RX 会匹配**每一个长度 ≥4 的英文单词**，
    // 于是 expected / null / selftest 全成了"锚点"，承重集被稀释成噪声 ——
    // 丢了真正的承重符号也拉不低保留率（实测 0.75，够过门），G3 当场失效。
    if (v.length >= 4 && /[A-Za-z]/.test(v) && /[_\\\d]/.test(v) && !/^\d+(?:\.\d+)?$/.test(v)) out.add(v)
  }
  for (const m of t.matchAll(NUM_RX)) out.add(m[1])
  return [...out].filter((x) => (x.length >= 3 && !/^\d+$/.test(x)) || /^\d{3,}$/.test(x))
}

/**
 * 带位置版本的锚点抽取。
 *
 * 为什么必须有它：anchorsOf 返回的是按**类型**分组的数组（路径一批、环境变量一批、
 * camelCase 一批…），它根本没有位置信息。于是 causePairs 里那句
 * "取边界前最后一个锚点" 取到的是「某类型里的最后一个」，不是「离边界最近的那个」——
 * 结果是负例 "并非因为 DSH_HOME，而是因为 CFB_REAL_DSH_HOME" 被抽成
 * (npm test > DSH_HOME)，压根没抽到那个被对调的因果对。N4 反因果 24 条全漏就是这么来的。
 * 要「最近」，就必须按位置排序。
 */
export function anchorsWithPos(text) {
  const t = norm(text)
  const out = []
  const keep = (a) => (a.length >= 3 && !/^\d+$/.test(a)) || /^\d{3,}$/.test(a)
  const push = (a, i) => { if (a && keep(a)) out.push({ a, i }) }
  for (const m of t.matchAll(PATH_RX)) push(m[0], m.index)
  for (const m of t.matchAll(ENV_RX)) push(m[0], m.index)
  for (const m of t.matchAll(CODE_RX)) push(m[1].trim(), m.index)
  for (const m of t.matchAll(CAMEL_RX)) push(m[0], m.index)
  for (const m of t.matchAll(SNAKE_RX)) push(m[0], m.index)
  for (const m of t.matchAll(TECH_RX)) {
    const v = m[0]
    if (v.length >= 4 && /[A-Za-z]/.test(v) && /[_\\\d]/.test(v) && !/^\d+(?:\.\d+)?$/.test(v)) push(v, m.index)
  }
  for (const m of t.matchAll(NUM_RX)) push(m[1], m.index + m[0].indexOf(m[1]))
  return out.sort((x, y) => x.i - y.i)
}

// 空串基名是毒药：includes('') 恒真、indexOf('', i) 恒等于 i。
// 任何拿它当搜索词的地方都会同时得到「全命中」和「死循环」。所以这里兜死。
//
// 2026-10 修：**尾斜杠不是内容**。实测（teacher 100 条）有一条稿写「test_results/ 这个目录」，
// ctx 的 ls -la 输出里是 test_results（无斜杠），于是被判成凭空引用。
// 根因是 base('test_results/') = split('/') 得到 ['test_results',''] ⇒ last='' 为假 ⇒ 原样返回
// 'test_results/'，于是又拿带斜杠的串去 includes 一次，还是 false。
// 一个目录名加不加尾斜杠是同一样东西，把它判成造假既冤枉稿子、又给「凭空」这个判决掺了噪声 ——
// 而后者的代价大得多：判决里混进假阳性，就没法再拿它当训练数据的筛选依据。
const stripSlash = (p) => String(p).replace(/[/\\]+$/, '')
const base = (p) => { const q = stripSlash(p); const s = q.split('/'); const last = s[s.length - 1]; return last || q }

/** 锚点是否活着：整串命中，或（对路径）基名命中。尾斜杠在两边都先抹掉再比。 */
export function hasAnchor(hay, a) {
  const h = norm(hay)
  const aa = stripSlash(a)
  // aa 为空说明锚点本身只是斜杠组成的噪声，一律判「不活」，绝不能落到 includes('') 上。
  if (!aa) return false
  if (h.includes(aa)) return true
  if (aa.includes('/')) { const b = base(aa); return !!b && h.includes(b) }
  return false
}

export function retention(anchors, hay) {
  const list = [...new Set(anchors)]
  if (!list.length) return 1
  let k = 0
  for (const a of list) if (hasAnchor(hay, a)) k++
  return k / list.length
}

const FAIL_RX = /EACCES|ENOENT|EPERM|Error|error:|FAIL|fail|expected|assert|\u5931\u8d25|\u62a5\u9519|\u8d85\u65f6|timeout|regression|denied|\u62d2\u7edd|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u7b49\u4e8e|got /i
// 注意：这几个正则用 .test() 判定，**绝不能带 /g** —— 带 /g 的 RegExp 有 lastIndex 状态，
// 连续 .test() 会隔次返回 false，尺子就会变成随机的。旧版这里正是这个 bug。
const ACTION_RX = /\b(fix|fixes|use|uses|should|instead|replace|revert|set|change|drop|remove|edit|must|prefer|correct|minimal)\b|\u6539|\u4fee|\u6362\u6210|\u5220|\u843d\u70b9|\u5e94\u8be5/
// 强动作词：只认「raw 自己提出要动它」的那一类，用来把症状路径和真落点分开。
const STRONG_ACTION_RX = /\b(fix|fixes|fixed|minimal|correct fix|the fix|should use|should be|should only|instead of|rather than|replace|rewrite|refactor|revert|change|edit|remove|drop)\b|\u6539|\u4fee|\u6362\u6210|\u5220\u6389/
// 「它只是被报告出来的症状」专用窄窗口。原来用的是 240 字宽的 SYMPTOM_RX ——
// 那个窗口里几乎必然混进一个 throw/undefined/无法，于是真落点 test/birth.selftest.mjs
// 也被判成症状。症状是**紧贴**的（"writes to PATH ... root-owned" /
// "The reported error path is PATH"），不是同段落里提过一嘴。所以窗口收到 ±45。
const SYMPTOM_NEAR_RX = /(?:reported|error path|writes? to|failed to open|open|cannot|denied|root-owned|read-only|no permission|EACCES|ENOENT|EPERM)/i
// 「raw 正打算把这个锚点换掉」的标记。被换掉的那个锚点是**要被淘汰的**，不是承重件：
// eacces-config 那条里，raw 的结论是「use DSH_HOME instead of CFB_REAL_DSH_HOME」——
// 于是 CFB_REAL_DSH_HOME 恰恰是**不该出现在稿子里**的那个。如果不认这条，
// 好稿（正确地把它换掉了）反而会因为「丢了 CFB_REAL_DSH_HOME」被判丢锚点。
const RETIRE_RX = /(?:instead of|rather than|replace|replaces|replaced|stop using|no longer|not use|drop|remove|revert|don't use)\s*$/i
const SYMPTOM_RX = /EACCES|ENOENT|EPERM|denied|read-only|\u53ea\u8bfb|root-owned|\u6743\u9650|permission|\u65e0\u6cd5|\u4e0d\u80fd|throw|throws|crash|\u62a5\u9519/i
const CMD_RX = /(?:^|[\s;|&])((?:taskset -c \d+ )?(?:node|npm|npx|pnpm|yarn|pytest|python|go|cargo|make)\s[\w./@ -]{1,60})/g

/**
 * 分句。
 *
 * 旧版这里是在「点号 / 叹号 / 问号 / 分号 后面跟空白」处**无条件切**（连 ASCII 句点也算）。
 * 于是 "test/hedge.selftest.mjs 报 FAIL …" 被从文件名中间切成两半：前半截
 * "test/hedge.selftest." 扔了，留下 "mjs 报 FAIL …"。承重锚点里那个**文件**
 * 就这么凭空消失 —— G3 看不见它，负例 N3 的基座退化成 hedgeStartedAt，
 * 「把 hedgeStartedAt 换成不存在的 hedgeStartedAt」变成空操作。
 * 一个分句正则，把整条链子上的三样东西同时弄坏了。
 *
 * 正确做法：只在「句末标点 + 后面确实另起一句」处切。点号后面紧跟字母时
 * （.mjs、.js、.log）它不是句末，是文件名的一部分。
 */
export function splitSentences(text) {
  return norm(text).split(/(?<=[\u3002\uff01\uff1f\uff1b])\s*|\n+|(?<=[.!?;])\s+(?=[A-Z\u4e00-\u9fff])/).filter(Boolean)
}

/**
 * 题面里那句「失败陈述」—— 承重锚点的来源。
 *
 * 只取**第一句**匹配的，不取全部。取全部会把台账/延续段里转述的 CI 日志一并算进来，
 * 于是 ctx 里凡是提过一嘴的文件都变成「必须保留」：实测 61 条手稿里有 27 条
 * 「丢了至少一个承重路径」，承重集动辄 11 个路径 —— 那不是承重，那是把整段上下文
 * 当成承重。题面陈述的失败只有一个，承重集就该只有它那几个锚点。
 */
export function failureText(ctx) {
  const t = norm(ctx)
  if (!t) return ''
  return splitSentences(t).find((s) => FAIL_RX.test(s)) || ''
}

export function commandsOf(text) {
  const t = String(text == null ? '' : text)
  const out = new Set()
  for (const m of t.matchAll(CMD_RX)) out.add(m[1].trim().replace(/[.,;:]+$/, ''))
  return [...out]
}

/** 稿子自称的落点。 */
export function locusOf(draft) {
  const t = String(draft == null ? '' : draft)
  const m = t.match(/(?:\u843d\u70b9|\u6539\u70b9|\u4fee\u6539\u70b9)\s*[:\uff1a]\s*([\w./\\-]+\.(?:mjs|js|mts|ts|tsx|json|jsonl|log|md|py|sh))/)
  if (m) return { path: m[1], declared: true }
  const any = t.match(/[\w./\\-]+\.(?:mjs|js|mts|ts|tsx|json|jsonl|log|md|py|sh)/)
  return any ? { path: any[0], declared: false } : { path: null, declared: false }
}

/**
 * 该落点是不是 raw 自己在「要动手」的语境里提出来的（而不是只在症状描述里被提到）。
 *
 * 为什么必须有这一条：tools/gold-forge2.mjs 第 48 行用「raw 里最长的文件名」当选落点，
 * 于是产出了「落点：/home/u/.dsh/storages/cot-form-b/trace.log」—— 那是报错里那个
 * 只读的日志文件，是**症状**，不是要改的地方。raw 提到它时用的是
 * 「the reported error path is ...」「which is root-owned → EACCES」，全是报告口径；
 * 而真正的落点 test/birth.selftest.mjs 在 raw 里的语境是
 * 「The minimal correct fix: in test/birth.selftest.mjs, use ... instead of ...」。
 * 区别不在「出现过没有」，而在「出现时是不是在说要动它」。
 */
export function locusActionable(raw, p) {
  const r = String(raw == null ? '' : raw)
  const needle = r.includes(p) ? p : base(p)
  if (!needle) return { ok: false, why: 'empty-needle', hits: 0, seen: 0 }
  if (!r.includes(needle)) return { ok: false, why: 'not-in-raw', hits: 0, seen: 0 }
  let i = 0, hits = 0, seen = 0
  for (;;) {
    const at = r.indexOf(needle, i)
    if (at < 0) break
    seen++
    const wide = r.slice(Math.max(0, at - 150), at + needle.length + 150)
    const near = r.slice(Math.max(0, at - 45), at + needle.length + 45)
    if (STRONG_ACTION_RX.test(wide) && !SYMPTOM_NEAR_RX.test(near)) hits++
    i = at + needle.length
  }
  return { ok: hits > 0, why: hits > 0 ? 'actionable' : 'symptom-or-silent', hits, seen }
}

/** raw 里某个锚点是不是正被「换成别的 / 不再用」，也就是它本身是要被淘汰的那个。 */
export function isRetired(raw, a) {
  const r = String(raw == null ? '' : raw)
  const needle = r.includes(a) ? a : base(a)
  if (!needle) return false
  let i = 0
  for (;;) {
    const at = r.indexOf(needle, i)
    if (at < 0) return false
    if (RETIRE_RX.test(r.slice(Math.max(0, at - 40), at))) return true
    i = at + needle.length
    if (needle.length === 0) return false
  }
}

const SYMPTOM_TOKEN_RX = /^(?:EACCES|ENOENT|EPERM|EEXIST|ETIMEDOUT|ECONNRESET|FAIL|FAILED|Error|error|timeout|denied)$/

/**
 * 承重锚点集 —— 尺子 G3 与负例生成器 N2/N3 共用同一份定义，绝不各写一套。
 *
 * 构成规则（每条都对应一次实测误判）：
 *   - 症状码（EACCES / FAIL …）是**要被修掉的东西**，不是要保住的东西，剔除；
 *   - 裸整数是观测值（got 1712），剔除；
 *   - raw 不认得的（题面提到、raw 从没提过）不是承重，剔除；
 *   - **路径**只有 raw 自己在说要动它时才算承重（否则报错里那个只读日志文件会变成必须保留项）；
 *   - **标识符**只有 raw 不打算淘汰它时才算承重（否则「instead of X」里的 X 会被要求保留）。
 */
export function loadAnchors(raw, ctx) {
  const ft = failureText(ctx)
  return anchorsOf(ft).filter((a) => {
    if (SYMPTOM_TOKEN_RX.test(a)) return false
    if (/^\d+$/.test(a)) return false
    if (!hasAnchor(raw, a)) return false
    if (/\w\.\w/.test(a) || a.includes('/')) return locusActionable(raw, a).ok
    return !isRetired(raw, a)
  })
}

/** 剔除合法引用后的 16-gram 覆盖率 —— 照抄稿的照妖镜。 */
export function copyCoverage(draft, raw, k = 16) {
  const d = norm(maskQuotes(draft))
  const r = norm(raw)
  if (!d) return 0
  if (d.length < k) return r.includes(d) ? 1 : 0
  const grams = new Set()
  for (let i = 0; i + k <= r.length; i++) grams.add(r.slice(i, i + k))
  const cov = new Uint8Array(d.length)
  for (let i = 0; i + k <= d.length; i++) {
    if (grams.has(d.slice(i, i + k))) for (let j = i; j < i + k; j++) cov[j] = 1
  }
  let c = 0
  for (const x of cov) c += x
  return c / d.length
}

const CAUSE_RX = /\b(because|since|so|therefore|thus|due to|leads? to|causes?)\b|\u56e0\u4e3a|\u6240\u4ee5|\u56e0\u800c|\u5bfc\u81f4|\u6545\u800c/g
const REVERSE_RX = /\u800c\u4e0d\u662f|\u5e76\u975e|\u4e0d\u662f.{0,8}\u800c\u662f|\u53cd\u8fc7\u6765|\u53cd\u4e4b|\u800c\u975e|not because|rather than|\u4e0d\u5e94\u8be5.{0,6}\u800c\u5e94\u8be5/

/**
 * 因果对：a（因）-> b（果），取因果标记词两侧**最近的承重锚点**。
 *
 * 旧版这里直接用 /([\w.$]{3,})\s*(?:because|so)\s*([\w.$]{3,})/ 抓，抓出来的是
 * 「EACCES. / the」「1500. / finishWaitMs」这种东西 —— 根本不是锚点，于是负例审计
 * 里 N4 反因果 24 条一条都没抓住（0/24）。原因不是 G5 的逻辑错，是它的输入是垃圾。
 * 换成 anchorsOf 之后两端才是同一套词表，正反两边的因果对才可比。
 */
export function causePairs(text) {
  const t = norm(text)
  const out = []
  for (const m of t.matchAll(CAUSE_RX)) {
    const at = m.index
    const before = anchorsWithPos(t.slice(Math.max(0, at - 130), at))
    const after = anchorsWithPos(t.slice(at + m[0].length, at + m[0].length + 130))
    const A = before.length ? before[before.length - 1].a : null
    const B = after.length ? after[0].a : null
    if (A && B && A !== B) out.push(A + '>' + B)
  }
  return out
}

export function judge(input) {
  const raw = String(input && input.raw != null ? input.raw : '')
  const ctx = String(input && input.ctx != null ? input.ctx : '')
  const draft = String(input && input.draft != null ? input.draft : '')
  const ev = raw + '\n' + ctx
  const failed = []
  const advisory = []
  const detail = {}

  // ---- G1（硬门只抓「凭空」，不抓「引用保真」）----
  //
  // 一开始这里用的是「整句必须是 raw∪ctx 的子串」，结果 61 条真手稿里 48 条被判凭空。
  // 逐条看过：那些句子不是编的，是写稿人把 raw 里的话**轻轻改写了**再放进「」——
  // 例如 raw 里是 `makeTraceWriter({ home: ... })`，稿里写成「But birth.selftest.mjs calls
  // makeTraceWriter({ home: ... }).」。加了「But」、去了反引号，就不逐字了。
  //
  // 所以硬门只该问一件事：**这份稿子有没有引入 raw∪ctx 里根本不存在的内容锚点。**
  // 那才是「凭空」，才是「抄不动背不动拟合不动」要挡的死线。
  // 「引用是不是逐字的」是另一件事，它是**保真度**，进软分（S6），不进硬门 —— 否则尺子
  // 会把排版噪声和造假混判，并且会奖励一种很坏的行为：只要不写引号就永远不违规。
  const frags = quotedFragments(draft).filter((f) => f.length >= 4)
  const inventedAnchors = []
  for (const f of frags) for (const a of anchorsOf(f)) if (!hasAnchor(ev, a)) inventedAnchors.push(a)
  const verbatim = frags.filter((f) => stripFmt(ev).includes(stripFmt(f))).length
  detail.quotes = {
    total: frags.length,
    verbatim,
    fidelity: frags.length ? +(verbatim / frags.length).toFixed(4) : 1,
    inventedAnchors: [...new Set(inventedAnchors)].slice(0, 6),
  }
  if (inventedAnchors.length) failed.push('G1 quote-grounded')

  // ---- 场景判定：这是不是代码/修 bug 型思维链 ----
  const rawPaths = [...new Set((norm(raw).match(PATH_RX) || []))]
  const codeTask = rawPaths.length >= 1

  // ---- G2 / G4 ----
  const loc = locusOf(draft)
  detail.locus = loc
  // G2 只在稿子**自己声明了落点**时才判。通用压缩稿不必声明落点，缺声明不算错 ——
  // 缺了动手接口由 G4 管。这样才不会把「没写落点」和「写错落点」混成一类。
  if (codeTask && loc.declared) {
    const grounded = norm(ev).includes(loc.path) || norm(ev).includes(base(loc.path))
    const act = locusActionable(raw, loc.path)
    detail.locus.grounded = grounded
    detail.locus.inRaw = act.seen > 0
    detail.locus.actionable = act.ok
    detail.locus.why = act.why
    if (!grounded || !act.ok) failed.push('G2 locus-grounded')
  }
  if (codeTask) {
    const cmdsDraft = commandsOf(draft)
    const cmdsEv = commandsOf(ev)
    const cmdGrounded = cmdsDraft.some((c) => norm(ev).includes(c))
    const anyPath = (norm(draft).match(PATH_RX) || []).some((p) => norm(ev).includes(p) || norm(ev).includes(base(p)))
    const fabricatedCmds = cmdsDraft.filter((c) => !norm(ev).includes(c))
    detail.actionable = { cmdsDraft: cmdsDraft.slice(0, 3), cmdsEv: cmdsEv.slice(0, 3), cmdGrounded, anyPath, fabricatedCmds: fabricatedCmds.slice(0, 3) }
    // 稿子写了验证命令，就必须是 raw∪ctx 里真有的那条 —— 编一条不存在的命令，
    // 正是「表面流畅但改事实」的最常见形态（真手稿里就有：验收写「跑 npm test」，
    // 而那条 raw/ctx 里根本没有 npm test）。
    if (fabricatedCmds.length) failed.push('G4 actionable')
    else if (!cmdGrounded && !anyPath) failed.push('G4 actionable')
  }

  // ---- G3 ----
  // 承重锚点 = 「题面失败陈述里点到、且 raw 也认得」的那些 —— raw 不认得的（比如题面里的 uid 1000）
  // 不是承重，删掉它是本事不是错误。路径另加权：题面失败陈述里的文件是这条 CoT 的承重结构，
  // 一个都不许丢。这就是 sse-truncated 那条真回归（raw 修好了、稿子没修好）的机理。
  // 承重锚点分两类，判法不同：
  //   路径 —— 失败陈述点到的那个文件就是这条 CoT 的承重结构，**一个都不许丢**；
  //   标识符 —— 用保留率下限（丢一两个还是丢一片，是程度问题）。
  // 定义统一放在 loadAnchors() 里，负例生成器 N2/N3 用的是同一个函数，不另写一份。
  const load = loadAnchors(raw, ctx)
  const loadPaths = load.filter((a) => /\w\.\w/.test(a) || a.includes('/'))
  const loadIds = load.filter((a) => !(/\w\.\w/.test(a) || a.includes('/')))
  const retIds = retention(loadIds, draft)
  const lostPaths = loadPaths.filter((a) => !hasAnchor(draft, a))
  detail.anchors = {
    loadBearing: load.length,
    paths: loadPaths.length,
    ids: loadIds.length,
    idRetention: +retIds.toFixed(4),
    sample: load.slice(0, 8),
    lostPaths: lostPaths.slice(0, 5),
  }
  if (lostPaths.length) failed.push('G3 anchors-kept')
  if (loadIds.length >= 1 && retIds < ANCHOR_FLOOR) failed.push('G3 anchors-kept')

  // ---- G0：这道尺子对这条单元**根本没有受力点** ----
  //
  // 自测发现的洞，不是推演：把学生稿换成**空字符串**，89 条 dev 里居然有 16 条过门
  // （18.0%）。逐条看原因是——那些单元 raw 里没有任何文件路径（codeTask=false），
  // 题面的失败陈述里也没有一个 raw 认得、可当承重的锚点（load 为空）。于是
  // G1~G7 全部**空转**：没有引号可查、没有落点可判、没有锚点可丢、没有命令可验，
  // 空稿当然也不算"抄"、不算"没压缩"。
  //
  // 后果非常坏：模型只要学会**什么都不输出**，就能白拿 18% 的分数，而没有任何指标报警。
  // 所以"没有受力点"必须显式判死，而不是默认放过。默认放过会让指标系统性报喜。
  // 这跟 preflight() 的 P5（no-load-bearing-anchors）是同一条道理，只是那道门
  // 拦在**花钱之前**，这道门拦在**打分之时**——两道都要有。
  // gen-ruler/4：G0 的结论提升成**顶层布尔** gaugeable，不再只是一个失败串。
  // 为什么必须这样：gaugeable 是**与稿子无关**的属性（它只读 raw/ctx），
  // 所以它在教师和学生身上**恒等**。实测 dev 89 条：G0 命中两边是同一批 16 条，
  // 不一致数 = 0。把它留在分母里，只是把两边同时压低、把对比稀释掉。
  // 之前只能靠字符串 'G0 no-leverage' 反查，任何一处措辞改动都会静默地让分母错位 ——
  // 所以这里给一个机器可判的布尔，调用方不许再解析失败串。
  const gaugeable = !(load.length === 0 && !codeTask)
  detail.leverage = {
    codeTask, loadBearing: load.length, gaugeable,
    why: gaugeable ? null : 'raw 里没有文件路径，题面失败陈述里也没有 raw 认得的承重锚点 —— 这一对没有受力点',
  }
  if (!gaugeable) failed.push('G0 no-leverage')

  // ---- G5 ----
  const rawPairs = new Set(causePairs(raw))
  const dPairs = causePairs(draft)
  const reversed = dPairs.filter((p) => {
    const [a, b] = p.split('>')
    return !rawPairs.has(p) && rawPairs.has(b + '>' + a) && REVERSE_RX.test(draft)
  })
  detail.causality = { rawPairs: rawPairs.size, reversed: reversed.slice(0, 3) }
  if (reversed.length) failed.push('G5 no-cause-inversion')

  // ---- G6 ----
  const cov = copyCoverage(draft, raw)
  detail.copy = { coverage: +cov.toFixed(4) }
  if (raw.length >= 400 && cov >= 0.5) failed.push('G6 not-copy')

  // ---- G7（gen-ruler/4：**出硬门，转软标准**）----
  //
  // 判据用 **token 比**，不是字符比（gen-ruler/2）。字符比会被「英文原文 → 中文稿」
  // 这种语言切换骗过：字符腰斩、token 不降。raw/draft 的字符数仍留在 detail 里供归因。
  //
  // v1~v3 把「压缩够了没有」当硬门（token 比 <= 0.55）。本地实测（dev 89 条，零成本重跑尺子）
  // 证明这个门是错的，四条证据：
  //   1. 24 条教师稿**只挂 G7 一件事**，其余七门全过。它们的软分均值 0.6993，
  //      教师整体 0.703 —— 尺子扔掉的那批和留下的那批一样好，这不是在筛质量。
  //   2. 这 24 条的 token 比从 0.5834 起跳。0.55 落在分布**内部**，那里没有任何自然断点，
  //      说明这个数是拍出来的，不是从数据里读出来的。
  //   3. 压缩本来就已经在软分里（S4 compressionGain，权重 0.13）。G7 是同一件事数两遍。
  //   4. 最要命的一条：阈值从 0.55 放宽到不设限，教师 42.5% -> 75.3%、学生 27.4% -> 34.2%。
  //      **差距不是缩小而是扩大**（15.1 点 -> 41.1 点）。G7 不是在压学生，是在压教师，
  //      顺带把学生的真实缺口遮住了。一条会掩盖待测对象缺陷的门，必须下架。
  //
  // 由此立下的规矩（这一版的核心）：**硬门只装布尔不变量，程度放软分。**
  //   「有没有编锚点」「有没有丢承重路径」「有没有编命令」「有没有倒因果」「有没有抄」
  //   「有没有受力点」—— 全是是/否。而「压到多少」是连续量，本来就该走软分。
  // 三个数以前互相打架：提示词要 10~20%，教师交 ~50%，尺子容忍 55%。
  // 现在只留一个权威数：COMPRESSION_TARGET。它**只记账，不拦稿**。
  // 以后再训练到 0.5 时，把 COMPRESSION_HARD_MAX 设成 0.5 就重新装上，别的都不用改。
  const ratio = raw.length ? draft.length / raw.length : 0
  const rawTok = estimateTokens(raw)
  const draftTok = estimateTokens(draft)
  const tokRatio = rawTok ? draftTok / rawTok : 0
  const meetsTarget = tokRatio <= COMPRESSION_TARGET
  const overRaw = tokRatio > COMPRESSION_SANITY
  detail.compression = {
    rawChars: raw.length, draftChars: draft.length, ratio: +ratio.toFixed(4),
    rawTokensEst: rawTok, draftTokensEst: draftTok, tokenRatio: +tokRatio.toFixed(4),
    target: COMPRESSION_TARGET, meetsTarget, overRaw,
  }
  // 只设上限，不设下限：压得太狠会先撞 G2/G3/G4（没落点、丢锚点、不动手），
  // 那是语义判据；在这里再放一个比例下限只会变成一个拍脑袋的截断。
  if (raw.length >= 800 && COMPRESSION_HARD_MAX != null && tokRatio > COMPRESSION_HARD_MAX) failed.push('G7 compressed')
  if (raw.length >= 800 && !meetsTarget) advisory.push('C1 target-' + COMPRESSION_TARGET + ' (tokRatio ' + tokRatio.toFixed(3) + ')')
  if (raw.length >= 800 && overRaw) advisory.push('C2 longer-than-raw (tokRatio ' + tokRatio.toFixed(3) + ')')

  // ---- 软分（只在过门稿上才有意义；不过门时照样算出来供归因） ----
  const rawAnchors = anchorsOf(raw)
  const mid = Math.floor(norm(raw).length / 2)
  const nraw = norm(raw)
  const tailAnchors = rawAnchors.filter((a) => nraw.indexOf(a) >= mid)
  const actionSentences = splitSentences(nraw).filter((s) => ACTION_RX.test(s))
  const decCov = actionSentences.length
    ? actionSentences.reduce((acc, s) => acc + retention(anchorsOf(s), draft), 0) / actionSentences.length
    : retention(rawAnchors, draft)
  const draftAnchors = anchorsOf(draft)
  const grounded = draftAnchors.length ? draftAnchors.filter((a) => norm(ev).includes(a) || norm(ev).includes(base(a))).length / draftAnchors.length : 0
  const gain = Math.max(0, Math.min(1, (1 - tokRatio - 0.10) / 0.75))
  const sub = {
    S1_anchorsKept: +retention(rawAnchors, draft).toFixed(4),
    S2_groundingDensity: +grounded.toFixed(4),
    S3_decisionCoverage: +decCov.toFixed(4),
    S4_compressionGain: +gain.toFixed(4),
    S5_tailRetention: +retention(tailAnchors, draft).toFixed(4),
    S6_quoteFidelity: detail.quotes.fidelity,
  }
  const W = { S1: 0.28, S2: 0.18, S3: 0.18, S4: 0.13, S5: 0.13, S6: 0.10 }
  const score = +(sub.S1_anchorsKept * W.S1 + sub.S2_groundingDensity * W.S2 + sub.S3_decisionCoverage * W.S3 + sub.S4_compressionGain * W.S4 + sub.S5_tailRetention * W.S5 + sub.S6_quoteFidelity * W.S6).toFixed(4)

  // gaugeable 与 pass 是**两个正交的维度**，调用方必须分开用：
  //   gaugeable=false  => 这把尺子对这对输入没有受力点，它的判决是「无意义」，不是「不过」。
  //                       拿它进分母会把两边的通过率同时压低（见 G0 段注释）。
  //   pass             => 在**有受力点**的前提下，这份稿子过没过硬门。
  // 还有一个 advisory：过了硬门、但没达到软标准（当前只有压缩这一项）。
  // 它**不拦稿**，只记账 —— 「现在先软标准，以后再训练到 0.5」就落在这个数组上。
  return { schema: 'cfb.gen-ruler/1', ruler: RULER_VERSION, pass: failed.length === 0, failed, gaugeable, advisory, score, sub, detail }
}

/**
 * raw 侧预检 —— 尺子里**不需要稿子**的那部分门。
 *
 * 为什么要单独有这个入口：尺子的主入口 judge() 需要 (raw, ctx, draft)，
 * 而 draft 是要**花钱生成**的。可 raw 矿有 10558 个单元、3500 万字 ——
 * 全喂给教师模型是 $5–15 甚至更多。所以要有一道**先于花钱**的门：
 * 哪些 (raw, ctx) 根本就不可能产出一份好稿，那就不该为它花钱。
 *
 * 它不是质量判据，是**花钱前的资格筛**。它说不了「这份稿好不好」（那是 judge 的事），
 * 只能说「这个输入值不值得去试」。这个区别必须写死在注释里，
 * 否则它就会变成仓库里第四处「抽取式正则假装自己是判断」。
 */
export function preflight(input) {
  const raw = String((input && input.raw) || '')
  const ctx = String((input && input.ctx) || '')
  const nraw = norm(raw)
  const reasons = []
  const signals = {
    rawChars: raw.length,
    ctxChars: ctx.length,
    anchors: anchorsOf(raw).length,
    anchorDensity: raw.length ? +(anchorsOf(raw).length / (raw.length / 1000)).toFixed(2) : 0,
  }
  // P1 太短就没得压（G7 只在 raw >= 800 时才要求压缩）
  if (raw.length < 800) reasons.push('P1 too-short')
  // P2 太长的输入在 2048 窗口里放不下，得先决定分段策略；先不花这份钱
  if (raw.length > 12000) reasons.push('P2 too-long-for-window')
  // P3 上下文缺席 => 没有可对齐的题面，压缩变成无参照的摘要
  if (ctx.length < 200) reasons.push('P3 ctx-missing')
  // P4 raw 若是工具转储而不是推理，压它等于压日志，学不到「压缩思维」
  let fence = 0
  for (const m of nraw.matchAll(new RegExp(TICK + TICK + TICK + '[\\s\\S]*?' + TICK + TICK + TICK, 'g'))) fence += m[0].length
  signals.fenceRatio = nraw.length ? +(fence / nraw.length).toFixed(3) : 0
  signals.toolMarkers = (nraw.match(/\[(?:result|call:|got)\]/g) || []).length
  if (signals.fenceRatio > 0.6) reasons.push('P4 mostly-code')
  if (signals.toolMarkers > 6) reasons.push('P4 mostly-tool-log')
  // P5 没有具体标识符 => 稿子没有任何必须保住的东西 => G3 无受力点 => 训练信号极弱
  if (signals.anchors < 3) reasons.push('P5 no-load-bearing-anchors')
  return { ok: reasons.length === 0, reasons, signals }
}

// ───────────────────────── CLI ─────────────────────────
function main() {
  const argv = process.argv.slice(2)
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const inFile = arg('--in')
  if (!inFile) { console.log('用法: node tools/gen-ruler.mjs --in <pairs.jsonl> [--out report.json]'); console.log('JSONL 每行: { id, raw, ctx, draft }'); process.exit(2) }
  const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  const rows = []
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    const r = judge({ raw: o.raw, ctx: o.ctx, draft: o.draft })
    rows.push({ id: o.id, family: o.family, pass: r.pass, gaugeable: r.gaugeable, failed: r.failed, advisory: r.advisory, score: r.score, ratio: r.detail.compression.ratio, copy: r.detail.copy.coverage, anchors: r.detail.anchors })
  }
  const failCount = {}
  for (const r of rows) for (const f of r.failed) failCount[f] = (failCount[f] || 0) + 1
  const pass = rows.filter((r) => r.pass).length
  // 三个分母都要报，而且不许合并成一个数（合并就是 v3 那个「34.8% 假天花板」的成因）：
  //   n        全部单元
  //   gaugeable 有受力点的单元 —— 只有这里面的通过率才是「尺子量出来的」
  //   target   有受力点、过门、且达到软标准（压缩 <= COMPRESSION_TARGET）的单元
  const gaugeable = rows.filter((r) => r.gaugeable)
  const gPass = gaugeable.filter((r) => r.pass).length
  // 达到软标准 = 有受力点 + 过硬门 + advisory 里没有 C1（压缩没到 COMPRESSION_TARGET）
  const target = gaugeable.filter((r) => r.pass && !(r.advisory || []).some((a) => a.startsWith('C1')))
  const advCount = {}
  for (const r of rows) for (const a of r.advisory || []) { const k = a.split(' ')[0]; advCount[k] = (advCount[k] || 0) + 1 }
  const out = { schema: 'cfb.gen-ruler-report/1', ruler: RULER_VERSION, at: new Date().toISOString(), input: inFile, n: rows.length, pass, fail: rows.length - pass, passRate: rows.length ? +(pass / rows.length).toFixed(4) : 0,
    gaugeable: gaugeable.length, gaugeablePass: gPass,
    gaugeablePassRate: gaugeable.length ? +(gPass / gaugeable.length).toFixed(4) : 0,
    target: { ratio: COMPRESSION_TARGET, hardMax: COMPRESSION_HARD_MAX, n: target.length,
      rate: gaugeable.length ? +(target.length / gaugeable.length).toFixed(4) : 0,
      note: '有受力点 + 过硬门 + 压缩达到软标准；这是要训练到的那个数，不是门' },
    advisoryCount: advCount, failCount, rows }
  const outFile = arg('--out', path.join(ROOT, '.cfb-offline', 'ruler', 'gen-ruler-report.json'))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n')
  console.log('尺子 ' + RULER_VERSION + '：' + rows.length + ' 条，过门 ' + pass + '，拒 ' + (rows.length - pass) + '（' + (out.passRate * 100).toFixed(1) + '%）')
  console.log('  有受力点 %d/%d，其中过门 %d = %s（**这个才是对比用的分母**）',
    gaugeable.length, rows.length, gPass, ((out.gaugeablePassRate) * 100).toFixed(1) + '%')
  console.log('  软标准：压缩 token 比 <= %s 且过门 %d = %s（要训练到的目标，不是门）',
    COMPRESSION_TARGET, target.length, ((out.target.rate) * 100).toFixed(1) + '%')
  for (const [k, v] of Object.entries(failCount).sort((a, b) => b[1] - a[1])) console.log('   [硬门] ' + k + ' x' + v)
  for (const [k, v] of Object.entries(advCount).sort((a, b) => b[1] - a[1])) console.log('   [软标准] ' + k + ' x' + v)
  console.log('报告：' + path.relative(ROOT, outFile))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
