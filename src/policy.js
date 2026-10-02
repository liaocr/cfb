// src/policy.js —— 压缩器提示词策略（v14.10 / 闭环 v4.5）：生产与评测共用的**同一份**补丁应用函数。
//
//   策略 = 对 compress-v4d9 提示词的受限补丁集 {id, patches:[append:rules|tail / replace(唯一命中) / exemplar]}。
//   之前只有评测工具（tools/helpers/generation.mjs）会应用补丁，生产提示词是源码常量 ⇒ 评测里的 policy:<id> 臂
//   走的是工具自己拼的请求体，与生产 makeBirthCompiler 不同路，需要一道「路径等价（parity）」付费校准。
//   v14.10 起策略进配置（cfg.compressPolicy），compressPromptFor 在生产路径里应用补丁：
//     · policy:base（patches=[]）与无策略逐字节相同 ⇒ auto ≡ policy:base **由构造保证**，parity 不再需要付费；
//     · 采纳 = 把策略对象写进配置（回滚 = 删掉），不改源码；trace 的 promptVersion 带 `+<policy.id>`。
//   补丁不合法即抛（不静默跳过）：生产启动时 normalizeConfig 先 validatePolicy，坏策略回到无策略并留痕。

export const POLICY_PATCH_LIMITS = Object.freeze({ maxPatches: 3, maxAddedChars: 900, maxReplaceChars: 400, maxExemplarChars: 1200 })

/** 把补丁应用到提示词：append(rules|tail) / replace(from 必须恰好出现一次) / exemplar（换样例正文）。 */
export function applyPolicyPatches(prompt, patches) {
  let p = String(prompt)
  for (const [i, patch] of (patches || []).entries()) {
    if (patch.op === 'append') {
      if (typeof patch.text !== 'string' || !patch.text.trim()) throw new Error('policy-patch:' + i + ':text')
      if (patch.section === 'tail') p = p + '\n' + patch.text.trim() + '\n'
      else {
        const anchor = ['【风格样例】', '【当前任务与观察】', '【上一轮思维链】'].find((a) => p.includes(a))
        if (!anchor) throw new Error('policy-patch:' + i + ':anchor')
        p = p.replace(anchor, '【补充规则】\n' + patch.text.trim() + '\n\n' + anchor)
      }
    } else if (patch.op === 'replace') {
      if (typeof patch.from !== 'string' || !patch.from || typeof patch.to !== 'string') throw new Error('policy-patch:' + i + ':replace')
      const n = p.split(patch.from).length - 1
      if (n !== 1) throw new Error('policy-patch:' + i + ':from-occurs-' + n)
      p = p.replace(patch.from, patch.to)
    } else if (patch.op === 'exemplar') {
      if (typeof patch.text !== 'string' || patch.text.trim().length < 40) throw new Error('policy-patch:' + i + ':exemplar-text')
      const m = p.match(/【风格样例】[^\n]*\n([\s\S]*?)(?=\n\n|$)/)
      if (!m) throw new Error('policy-patch:' + i + ':exemplar-anchor')
      p = p.replace(m[1], patch.text.trim())
    } else throw new Error('policy-patch:' + i + ':op')
  }
  return p
}

/** 预算 + 形状校验（不看内容聪不聪明，只看越不越界）。合法返回 patches；否则抛。 */
export function validatePolicyPatches(patches, limits = POLICY_PATCH_LIMITS) {
  if (!Array.isArray(patches)) throw new Error('policy:patches-not-array')
  if (patches.length > limits.maxPatches) throw new Error('policy:too-many-patches')
  let added = 0
  for (const [i, p] of patches.entries()) {
    if (!p || typeof p !== 'object') throw new Error('policy-patch:' + i + ':shape')
    if (p.op === 'append') { if (!['rules', 'tail'].includes(p.section)) throw new Error('policy-patch:' + i + ':section'); if (typeof p.text !== 'string') throw new Error('policy-patch:' + i + ':text'); added += p.text.length }
    else if (p.op === 'replace') { if (typeof p.from !== 'string' || typeof p.to !== 'string') throw new Error('policy-patch:' + i + ':replace'); if (p.to.length > limits.maxReplaceChars) throw new Error('policy-patch:' + i + ':replace-too-long'); added += Math.max(0, p.to.length - p.from.length) }
    else if (p.op === 'exemplar') { if (typeof p.text !== 'string' || p.text.length > limits.maxExemplarChars) throw new Error('policy-patch:' + i + ':exemplar') }
    else throw new Error('policy-patch:' + i + ':op')
  }
  if (added > limits.maxAddedChars) throw new Error('policy:too-many-added-chars')
  return patches
}

/** 配置里的策略归一化：null/undefined/'base' ⇒ null（无策略）；对象必须有 string id 与合法 patches。坏的抛。 */
export function normalizePolicy(x) {
  if (x == null || x === '' || x === 'base' || x === false) return null
  if (typeof x !== 'object') throw new Error('policy:shape')
  const patches = validatePolicyPatches(x.patches || [])
  if (!patches.length) return null   // 空补丁 = 无策略（与 base 逐字节相同）
  if (typeof x.id !== 'string' || !x.id) throw new Error('policy:id')
  return Object.freeze({ id: x.id, patches: Object.freeze(patches.map((p) => Object.freeze({ ...p }))) })
}
