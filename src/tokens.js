// dsh-cot-form-b / tokens.js —— 按书写系统区分的 token 粗估（纯函数，零依赖）
//
// 为什么需要它（v11.10）：
//   插件的门槛与净收益原来全部按「字符」算，但压缩提示词要求用中文输出，而原推理可能是英文。
//   DeepSeek 官方口径（api-docs.deepseek.com/quick_start/token_usage）：
//     1 个英文字符 ≈ 0.3 token；1 个中文字符 ≈ 0.6 token
//   ⇒ 同样 1,000 字符，中文的 token 约是英文的 2 倍。按字符判「省了」时，按 token 可能没省
//     （英文原文 3,100 字符 ≈ 930 token；中文摘要 1,600 字符 ≈ 960 token —— 字符净省 1,500，token 反增）。
//
// ⚠ 口径纪律：这是**估算**，不是分词器读数，更不是钱。真账单只认 provider 返回的 usage。
//   trace 里的 *TokensEst 字段一律带 Est 后缀，与 providerReportedUsage 严格分开。

export const TOKENS_PER_CJK_CHAR = 0.6
export const TOKENS_PER_OTHER_CHAR = 0.3

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
