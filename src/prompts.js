// dsh-cot-form-b / prompts.js —— 副模型提示词与版本号（纯函数）
//
//   buildCompressPrompt    compress-v2：保真规则 + 相对长度目标
//   buildCompressPromptV3  compress-v3（缺省）：保真规则 + 绝对长度目标（compressTargetMin/Max）
//   compressPromptFor      按配置选提示词（与 compressPromptVersion 同一次裁决）
//   compressPromptVersion  版本号唯一裁决点（BOOT / 每次编译 / trace 共用）
//   v12.1：legacy 三态蒸馏提示词（= compress-v1）删除。它的两项优点已被 v3 吸收：绝对长度目标（v3 第 7 条）、
//          第三人称陈述不用祈使（v2/v3 第 5 条）；它独有的「已否决·不可重开」裁决式措辞被 v2 证明有害
//          （把犹豫与备选抹成定论），不保留。原文可从 git cfba57b 的 src/prompts.js 取回。
//   splitCompressPrompt    compressSystemPrompt 打开时拆成 system（规则前缀）+ user（原文），字节等价
//   buildCompressPromptV4  compress-v4-ops（v12.2，opt-in）：副模型**只做结构化标注**（JSON ops），
//                          出生文本由 src/compile-v4.js 按理论（第五卷 S1–S5）用代码写出
import { DEFAULTS } from './config.js'

/**
 * ★ 2026-09-23 compress-v2：**中性压缩**提示词（与 legacy 蒸馏的裁决式提示词分离）。
 *   旧 legacy 蒸馏提示词要求「已否决·不可重开」「删掉自我怀疑」—— 那是不可逆裁决，
 *   把 reasoning 里的犹豫与备选项抹掉。纯压缩的目标只是**更短且保真**：
 *     · 保留未决问题、备选方案与不确定性的措辞（不升级为结论）；
 *     · 路径 / 命令 / 数字 / 报错逐字保留；
 *     · 不新增事实、不给建议、不使用祈使句与第二人称（作为 user 角色注入时不得与当前任务冲突）。
 */
/** compress 提示词版本的唯一裁决点（BOOT、每次编译、trace 三处共用，杜绝硬编码漂移）。 */
export function compressPromptVersion(cfg) {
  const v = cfg && cfg.compressPrompt === 'v2' ? 'v2' : cfg && cfg.compressPrompt === 'v4' ? 'v4' : 'v3'
  const sys = cfg && cfg.compressSystemPrompt === true ? ':sys' : ''
  if (v === 'v2') return 'compress-v2' + sys
  // v4 把渲染预算与尾段开关写进版本号（它们改变产物；提示词本身不随参数变化）
  if (v === 'v4') return 'compress-v4-ops2:' + v4Budget(cfg) + (cfg && cfg.compressV4Tail === false ? ':notail' : '') +
    (v4Incremental(cfg) ? ':inc' + v4SegmentChars(cfg) : '') + sys
  // v3 把目标长度写进版本号 ⇒ trace / BOOT / A-B 分桶自动带上参数，无需另记字段。
  const t = compressTargets(cfg)
  return 'compress-v3:' + t.min + '-' + t.max + sys
}

/** 按配置构造压缩提示词；与 compressPromptVersion 同一口径（v2 显式选择，其余一律 v3）。 */
export function compressPromptFor(cfg, cot) {
  if (cfg && cfg.compressPrompt === 'v2') return buildCompressPrompt(cot)
  if (cfg && cfg.compressPrompt === 'v4') return buildCompressPromptV4(cot)
  const t = compressTargets(cfg)
  return buildCompressPromptV3(cot, t.min, t.max)
}

/** v4 的渲染预算（字符）：非必留条目按性价比装到这个长度为止；必留条目（当前方案 / 证伪路 / 未决）不受限。
 *  缺省跟随 compressTargetMax（与 v3 同一口径，便于 A/B）。 */
export function v4Budget(cfg) {
  const x = cfg && cfg.compressV4BudgetChars
  if (typeof x === 'number' && Number.isFinite(x) && x > 0) return Math.round(x)
  return compressTargets(cfg).max
}

/** v4 流式增量编译是否打开（缺省开；只对 v4 有意义）。 */
export function v4Incremental(cfg) { return !!cfg && cfg.compressPrompt === 'v4' && cfg.compressV4Incremental !== false }
/** v4 增量编译的分段目标长度（字符）。 */
export function v4SegmentChars(cfg) {
  const x = cfg && cfg.compressV4SegmentChars
  return typeof x === 'number' && Number.isFinite(x) && x >= 200 ? Math.round(x) : 1200
}

/** v3 的绝对长度目标（字符）。越界/非数一律回落缺省，绝不抛错。 */
export function compressTargets(cfg) {
  const num = (x, dflt) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : dflt)
  const d = (typeof DEFAULTS === 'object' && DEFAULTS) || {}
  const min = num(cfg && cfg.compressTargetMin, num(d.compressTargetMin, 250))
  const max = num(cfg && cfg.compressTargetMax, num(d.compressTargetMax, 450))
  // min 必须严格小于 max，否则模型会收到自相矛盾的区间。
  return max > min ? { min, max } : { min: Math.min(min, max), max: Math.max(min, max) + 1 }
}

/** v2/v3 共用的前缀与保真规则 1~6。
 *  ⚠ **逐字冻结**：拆出来只是去重，v2 的最终输出必须与重构前字节一致
 *    （coverage-provenance.selftest.mjs 断言 v2 保持中性、不得出现裁决式措辞）。
 */
const COMPRESS_PREAMBLE =
  '你是上下文压缩器。把下面这段 Agent 上一轮的思维链，改写成一份更短的等价记录。\n\n' +
  '只输出记录本身。不要解释，不要 markdown 代码围栏，不要客套。\n\n' +
  '保真规则（优先级高于长度）：\n'

const COMPRESS_FIDELITY_RULES =
  '1. 保留原文的确定程度：已确定的写成已确定；原文仍在犹豫、比较或存疑的，保留"尚未确定 / 两种可能 / 待验证"的表述，不得升级为结论，也不得删掉。\n' +
  '2. 保留被考虑过但未采用的方案及其原因（一句话即可）。\n' +
  '3. 路径、文件名、命令、变量名、数字、错误信息原文逐字保留，不许意译。\n' +
  '4. 不新增原文没有的事实，不给建议，不评价。\n' +
  '5. 用中文；第三人称陈述句；不得出现祈使句，不得使用"你 / 您"。\n' +
  '6. 删除重复表述与逐字复读的工具输出；合并同义段落。\n'

export function buildCompressPrompt(cot) {
  return (
    COMPRESS_PREAMBLE +
    COMPRESS_FIDELITY_RULES +
    '7. 目标长度为原文的 20%~35%；原文很短时宁可少删。\n\n' +
    '【上一轮思维链】\n' +
    cot
  )
}

/**
 * ★ 2026-09-23 compress-v3：**v2 的保真规则 + v1 的绝对长度目标**。
 *
 *  为什么存在：2026-09-23 本机实测（同一 trace.log，按输入大小分桶平均）——
 *    v1（绝对 200~400 字符）：输入 892→9,794（11 倍），输出仅 403→801（2 倍）⇒ 压缩比 45.2%→8.2%
 *    v2（相对 20%~35%）    ：输出 344/788/1120，稳定贴住输入的 30%
 *    且在输入 <1,500 时 v2 比 v1 更短（344 vs 403）
 *  ⇒ **v2 那 1~6 条保真规则不花长度**；长度差异 100% 来自第 7 条的口径（相对 vs 绝对）。
 *  因此 v3 = v2 的规则原封不动 + v1 的绝对目标，并用第 8 条明确「长度服从保真」。
 *
 *  为什么用绝对值而不是更小的百分比：百分比对小输入是灾难
 *    （900 字符按 20% 压到 180 必然丢信息）；绝对值在 892→9,794 的跨度上已被 v1 验证过。
 *
 *  ⚠ 第 8 条是对绝对目标的必要对冲：绝对目标比百分比更紧，模型必须知道
 *    「宁可超出目标，也不许删事实」，否则保真规则会被长度目标压穿。
 *
 * @param cot 上一轮推理原文
 * @param minChars 目标下限（字符）
 * @param maxChars 目标上限（字符）
 */
/**
 * ★ v11.7：把 v2/v3 提示词拆成 { system, user } 两段，**字节级等价于**原单段文本
 *   （system + '\n\n' + user === 单段），供缓存友好形状使用。只做切分，不改任何字。
 */
export function splitCompressPrompt(prompt) {
  const marker = '【上一轮思维链】\n'
  const i = typeof prompt === 'string' ? prompt.indexOf(marker) : -1
  if (i <= 0) return null
  // 单段形状里 marker 前有 '\n\n'；system 取到它之前，user 从 marker 起
  const head = prompt.slice(0, i)
  const system = head.endsWith('\n\n') ? head.slice(0, -2) : head
  return { system, user: prompt.slice(i) }
}

export function buildCompressPromptV3(cot, minChars, maxChars) {
  const num = (x, dflt) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : dflt)
  const min = num(minChars, 250)
  const max = num(maxChars, 450)
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return (
    COMPRESS_PREAMBLE +
    COMPRESS_FIDELITY_RULES +
    '7. 目标长度 ' + lo + '~' + hi + ' 字符（**绝对长度**，不随原文比例伸缩）；原文很短（不足 800 字符）时宁可少删。\n' +
    '8. ★ 长度目标服从保真规则：若在 ' + hi + ' 字符内无法保留全部待定项、备选方案与逐字标识符，**宁可超出目标，不得删除**。\n\n' +
    '【上一轮思维链】\n' +
    cot
  )
}

/**
 * ★ v12.2 compress-v4-ops：副模型**不写出生文本**，只把推理拆成带类型的原子条目（JSON）。
 *   理论出处：docs/theory/CFB-THEORY-COMPLETE.md 第五卷 S2（op 模式）与 S4（提示词草案）。
 *   与 v3 的根本区别：长度、顺序、措辞、人称、否定形式全部由代码决定（src/compile-v4.js），
 *   副模型的文风与长度偏好无法再影响结果；每条都必须带原文逐字锚点，编造可被机械检出。
 *   末尾标记与 v2/v3 相同 ⇒ splitCompressPrompt（compressSystemPrompt）照样可用。
 */
const V4_HEAD = (
    '你是推理解析器。把下面这段 Agent 上一轮的思维链拆成原子条目，只输出一个 JSON 对象。' +
    '不要解释，不要 markdown 代码围栏。你不写摘要，只做标注；最终文本由程序按你的标注生成。\n\n' +
    '输出格式：\n' +
    '{"ops":[{"id":"o1","k":"FACT","ev":"tool","kind2":"localize","text":"…","anchor":"…","key":"…","src":"…","alt":"…","why":"…","trigger":"…","supersedes":"…","deps":["o0"]}]}\n' +
    '必填：id、k、ev、text、anchor。其余字段只在适用时给出，不适用就省略。\n\n' +
    '字段：\n' +
    '- k（七选一）：FACT 观察到的事实；COMPUTED 推理或计算得出的结论；INCUMBENT 当前采用的方案或结论；' +
    'REFUTED 被工具观测证伪而放弃的路；SHELVED 没有观测证据、只是暂时搁置的路；OPEN 仍未解决的问题；PLAN 当时打算做的下一步。\n' +
    '- ev（依据）：tool（工具输出、命令结果、文件内容等外部观测）/ derived（推理得出）/ guess（猜测）。没有工具观测就不是 tool。\n' +
    '- kind2（这句在推理中的作用）：pivot（"等等 / 换个思路 / 这说明"类转折）/ plan / hypothesize / localize（缩小范围）/ ' +
    'inspect（查看）/ compute / verify（复核已知结论）/ restate（复述工具输出）/ answer。\n' +
    '- text：这一条的内容，一句话，用原文的语言；只写结论本身，删掉"让我想想 / 好像 / 再看看"之类的过程措辞。\n' +
    '- anchor：从原文逐字复制的 5–20 字短片段，标明这条出自哪里，必须一字不差。\n' +
    '- key：这条若是在给某个量定值（配置路径、版本、根因等），写一个简短键名；同一个键只保留最新的值。\n' +
    '- src：ev=tool 时写来源（原文里出现过的工具名或文件名），否则省略。\n' +
    '- REFUTED 与 SHELVED 必须写 alt（放弃它之后转向的方案；没有明确方案时写仍在考虑的方向）和 why（放弃的理由）；SHELVED 另写 trigger（出现什么情况值得回来）。\n' +
    '- supersedes：这条取代了先前的哪个值（原文里的旧值）。\n' +
    '- deps：理解这条必需的其他条目 id。\n\n' +
    '规则：\n' +
    '1. 路径、文件名、命令、变量名、数字、错误信息逐字照抄，不许意译。\n' +
    '2. 只标注原文实际出现的内容；不新增事实，不给建议，不评价。\n' +
    '3. 原文仍在犹豫或存疑的，标 OPEN、SHELVED 或 ev=guess，不得升级为已确定。\n' +
    '4. 被放弃的路一定要标出来（REFUTED 或 SHELVED）：它们防止同一条死路再走一遍。\n' +
    '5. 同一内容只标一次；逐字复读工具输出、复核已知结论的句子不要标（程序本来就会丢弃）。\n' +
    '6. 不使用"你 / 您"，不写祈使句。\n' +
    '7. 若给出了【此前已标注】（同一段推理前面部分的标注结果），只标注【本段】里的新内容，不要重复；' +
    '本段推翻或取代了此前某条时，在新条目里写 retracts（被推翻条目的 id 列表）；anchor 仍须摘自【本段】。\n' +
    '8. 宁少勿多：只标会影响下一步判断的条目，每 1000 字原文至多 6 条；text 不超过 40 字。\n\n'
)

export function buildCompressPromptV4(cot) {
  return V4_HEAD + '【上一轮思维链】\n' + cot
}

/**
 * v12.2 增量编译的分段提示词：规则前缀与整块 v4 **逐字相同**（缓存前缀稳定），
 * 此前片段已编译出的条目放在 user 段里（它每段都变，放进 system 会打碎缓存）。
 * @param seg   本段推理原文
 * @param prior 此前片段的条目摘要行（'s1.o3 [INCUMBENT] …'），可空
 */
export function buildCompressPromptV4Segment(seg, prior = []) {
  const lines = Array.isArray(prior) ? prior.filter((x) => typeof x === 'string' && x) : []
  if (!lines.length) return V4_HEAD + '【上一轮思维链】\n' + seg
  return V4_HEAD + '【上一轮思维链】\n【此前已标注】\n' + lines.join('\n') + '\n\n【本段】\n' + seg
}

