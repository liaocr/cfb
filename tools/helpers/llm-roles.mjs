// tools/helpers/llm-roles.mjs —— 用户规定（2026-10-02，v14.9）：**只用 deepseek-v4.1-flash，且只用在实战里真实存在的两个位置：主模型（Agent 思考）与副模型（压缩器，同模型关思考）。**
//   其他一切需要「大模型」的地方 —— 提议器 / 评委 / 打标 / 写场景 / 分析 —— 由助手代工，不发 API。
//   这不是省钱技巧，是被测对象 = 目标对象的硬约束：钱只花在能迁移到生产的那两种调用上。
export const RULE = Object.freeze({
  model: 'deepseek-v4.1-flash',
  // 允许付费的角色（都是生产里真实存在的调用形态）
  paidRoles: Object.freeze(['main', 'compress', 'compile', 'mint-a', 'mint-b']),   // compile = 副模型按策略压 side；mint-a/b = 主模型在场景里当 Agent 产生思维链
  // 必须由助手代工的角色（生产里不存在这些调用）
  assistantRoles: Object.freeze(['propose', 'judge', 'label', 'scenario', 'analysis']),
  note: '提议器 / 评委 / 打标 / 写场景 / 分析由助手代工（零 API）；主模型与副模型只用 deepseek-v4.1-flash。',
})
export function assertPaidRole(role) {
  if (RULE.assistantRoles.includes(role)) throw new Error(`rule:assistant-role:${role}（用户规定：${RULE.note}）`)
  if (!RULE.paidRoles.includes(role)) throw new Error(`rule:unknown-role:${role}`)
  return true
}
export function assertModel(model) {
  if (model && model !== RULE.model) throw new Error(`rule:model:${model}（用户规定只用 ${RULE.model}）`)
  return true
}
