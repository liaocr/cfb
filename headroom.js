/**
 * D10：基于「上下文剩余空间百分比」的动态门槛（Headroom-Aware）。
 *
 * 为什么不用步数：Step 单调递增，但上下文体积是锯齿形震荡的 ——
 * 宿主一次大压缩能把占用从 85% 打回 20%，而步数还在无脑往前数。
 * 唯一有物理意义的量是「距离下一次宿主压缩还剩多少跑道」。
 *
 * 标尺（免疫模型差异：128k / 262k / 1M 全自洽）：
 *   剩余 > 70%   ⇒ 350 字符  【宽阔跑道】刚开局或刚大压缩完，吃满长程复利
 *   剩余 >= 30%  ⇒ 500 字符  【稳定巡航】标准生产中枢
 *   其余         ⇒ 800 字符  【迫近压缩】宿主压缩在即，严格防倒贴
 *
 * 边界语义显式声明（inclusive），不吃浮点运气。
 *
 * @module dsh-cot-form-b/headroom
 */

/**
 * 默认标尺。命中规则：从上往下取第一个满足 
 *   inclusive ? headroom >= minHeadroom : headroom > minHeadroom
 * 的档位。末档 minHeadroom = -Infinity 且 inclusive，故必然命中，无需兜底分支。
 */
export const DEFAULT_BANDS = Object.freeze([
  Object.freeze({ minHeadroom: 0.70, inclusive: false, minRawChars: 350 }),
  Object.freeze({ minHeadroom: 0.30, inclusive: true, minRawChars: 500 }),
  Object.freeze({ minHeadroom: Number.NEGATIVE_INFINITY, inclusive: true, minRawChars: 800 }),
])

/** 读数不可信时退回的保守档：绝不因缺读数而过度压缩（宁可少赚，不可倒贴）。 */
export const CONSERVATIVE_MIN_CHARS = 800

/**
 * 剩余跑道比例 = 1 - 占用 / 窗口。
 * @param usedTokens 当前请求 prompt 侧 token 占用
 * @param contextWindowTokens 模型物理窗口
 * @returns 剩余比例；读数不可信时返回 undefined
 */
export function headroomOf(usedTokens, contextWindowTokens) {
  if (typeof usedTokens !== 'number' || typeof contextWindowTokens !== 'number') return undefined
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindowTokens)) return undefined
  if (contextWindowTokens <= 0) return undefined
  if (usedTokens < 0) return undefined
  return 1 - usedTokens / contextWindowTokens
}

/**
 * 取本轮该用的 minRawChars。
 * @param usedTokens 当前占用（缺失 ⇒ 保守档）
 * @param contextWindowTokens 模型窗口（缺失 ⇒ 保守档）
 * @param cfg { bands, staticMinRawChars }
 *   staticMinRawChars 一旦是有限数即完全接管（保留静态覆盖的逃生门）
 */
export function minRawCharsFor(usedTokens, contextWindowTokens, cfg = {}) {
  if (Number.isFinite(cfg.staticMinRawChars)) return cfg.staticMinRawChars
  const bands = Array.isArray(cfg.bands) && cfg.bands.length > 0 ? cfg.bands : DEFAULT_BANDS
  const headroom = headroomOf(usedTokens, contextWindowTokens)
  if (headroom === undefined) return CONSERVATIVE_MIN_CHARS
  for (const band of bands) {
    const hit = band.inclusive === false ? headroom > band.minHeadroom : headroom >= band.minHeadroom
    if (hit) return band.minRawChars
  }
  return CONSERVATIVE_MIN_CHARS
}

/** 档位名，仅用于 trace 可读性。 */
export function bandNameFor(minRawChars) {
  if (minRawChars <= 350) return 'wide-runway'
  if (minRawChars <= 500) return 'steady-cruise'
  return 'near-compaction'
}
