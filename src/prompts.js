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
  const v = cfg && cfg.compressPrompt === 'v2' ? 'v2' : 'v3'
  const sys = cfg && cfg.compressSystemPrompt === true ? ':sys' : ''
  if (v === 'v2') return 'compress-v2' + sys
  // v3 把目标长度写进版本号 ⇒ trace / BOOT / A-B 分桶自动带上参数，无需另记字段。
  const t = compressTargets(cfg)
  return 'compress-v3:' + t.min + '-' + t.max + sys
}

/** 按配置构造压缩提示词；与 compressPromptVersion 同一口径（v2 显式选择，其余一律 v3）。 */
export function compressPromptFor(cfg, cot) {
  if (cfg && cfg.compressPrompt === 'v2') return buildCompressPrompt(cot)
  const t = compressTargets(cfg)
  return buildCompressPromptV3(cot, t.min, t.max)
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
