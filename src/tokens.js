// dsh-cot-form-b / tokens.js —— 按书写系统区分的 token 粗估（纯函数，零依赖）
//
// 为什么需要它（v11.10）：
//   插件的门槛与净收益原来全部按「字符」算，但压缩提示词要求用中文输出，而原推理可能是英文。
//   ⇒ 同样 1,000 字符，中文的 token 远多于英文。按字符判「省了」时，按 token 可能没省。
//
// ⚠ 口径纪律：这是**估算**，不是分词器读数，更不是钱。真账单只认 provider 返回的 usage。
//   trace 里的 *TokensEst 字段一律带 Est 后缀，与 providerReportedUsage 严格分开。
//
// ★ 2026-10 校准（此前 0.6/0.3 是**手写常数、从未量过**，出自已不可考的 DeepSeek 文档口径）：
//   用 330 次真实调用的 providerReportedUsage 对「宽字符数 / 其余字符数」做最小二乘，
//   输入侧与输出侧各 330 个观测联合拟合（n=660，不带截距以保持本函数接口）：
//     中文/全角 0.8084 · 其余 0.2600 · 平均绝对误差 3.87%（现行 0.6/0.3 为 7.07%）
//   留出验证（8:2）：输入侧 6.03% → 2.61%，输出侧 9.79% → 5.47%。
//   共线性检查：corr(宽, 其余) = 0.13（输入）/ −0.10（输出）⇒ 两个系数是可分辨的，不是拟合噪声。
//   旧常数错在两处：低估中文 28%（0.6 vs 0.81），且把中英比例当成 2.00x（实为 3.11x）。
//   ⚠ 该 3.11x 的代价正是「英文原文 → 中文稿」这种写法：字符腰斩而 token 不降。
//   复算：tools/analyze-trace.mjs 的 addCalibration（读 trace 的 promptWideChars + usage）。

export const TOKENS_PER_CJK_CHAR = 0.81
export const TOKENS_PER_OTHER_CHAR = 0.26

// 中日韩统一表意文字（含扩展 A）、兼容表意、假名、谚文、CJK 符号与全角标点。
// 与 fidelity.js 的 RE_CJK（只看基本区汉字）不同：这里要估的是**全部**宽字符。
const RE_WIDE = /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g

/**
 * 估算 token 数（向上取整）。非字符串按 String() 处理；空串 = 0。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text)
  if (!s) return 0
  const wide = (s.match(RE_WIDE) || []).length
  const other = s.length - wide
  return Math.ceil(wide * TOKENS_PER_CJK_CHAR + other * TOKENS_PER_OTHER_CHAR)
}

/**
 * 宽字符（CJK）占比，0~1。用于 trace 画像：解释为什么同样的字符门槛在不同语言下代价不同。
 */
export function wideShare(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s) return 0
  return Number(((s.match(RE_WIDE) || []).length / s.length).toFixed(3))
}

/**
 * v11.11：按书写系统拆分字符数 —— 供 token 估算**校准**（trace 记录 wide/other，离线与 provider usage 回归出真实系数）。
 * 只记数量，不记内容。
 * @returns {{ wide: number, other: number }}
 */
export function scriptCounts(text) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text)
  if (!s) return { wide: 0, other: 0 }
  const wide = (s.match(RE_WIDE) || []).length
  return { wide, other: s.length - wide }
}
