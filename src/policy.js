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
        const anchor = ['【风格样例】', '【第 2 轮样例】', '【当前任务与观察】', '【上一轮思维链】'].find((a) => p.includes(a))
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
      if (patch.section === 'contrastive') {
        const anchor = ['【风格样例】', '【第 2 轮样例】', '【当前任务与观察】', '【上一轮思维链】'].find((a) => p.includes(a))
        if (!anchor) throw new Error('policy-patch:' + i + ':exemplar-anchor')
        p = p.replace(anchor, '【正反对比示范（飞轮偏好对蒸馏）】\n' + patch.text.trim() + '\n\n' + anchor)
      } else {
        const m = p.match(/【(?:风格样例|第 2 轮样例)】[^\n]*\n([\s\S]*?)(?=\n\n|$)/)
        if (!m) throw new Error('policy-patch:' + i + ':exemplar-anchor')
        p = p.replace(m[1], patch.text.trim())
      }
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

/** v14.12.3：策略可携带的**配置键**（白名单 + 类型）。提示词补丁改副模型写什么；这些键改程序写什么 / 什么时候压 / 什么稿放行。
 *   两类：
 *   · 程序部件：continuationPath（F6 延续段形态）。
 *   · **制度键（regime）**：birthMinChars（触发地板）/ birthMinSavedChars（净省保本线，负数 = 允许增补）/ birthTokenGate。
 *     v14.12.4 归因：生产地板 3100 由 v11.6 的 token 成本模型反解（净收益 = (R−1)·d·(B−B′) − T − 5·B′），它给稿对结局的作用记 0；
 *     而 traj1–3 里 auto 比 raw 多修好的那些轨迹，31 个压缩轮里 55% 是稿比原文长（增补）、只有 23% 过得了 3100 地板。
 *     制度键让「换制度」成为可预注册、按结局比的候选，而不是改源码；plan-traj 看到制度键会按「第 1 轮就分歧、每轮都压」计费并打提示。
 *   不在白名单的键（模型、提示词版本、闸的开关 identifierGate 等）不许借策略改。 */
export const POLICY_CONFIG_KEYS = Object.freeze({
  continuationPath: Object.freeze({ enum: Object.freeze(['full', 'bounded', 'none']) }),
  programParts: Object.freeze({ enum: Object.freeze(['all', 'compact', 'no-closing', 'no-hints', 'continuation-only', 'none']) }),
  promptMode: Object.freeze({ enum: Object.freeze(['full', 'modular']) }),
  compressV4DirectMaxChars: Object.freeze({ int: Object.freeze([600, 4000]) }),
  compressV4DirectBind: Object.freeze({ bool: true }),
  compressLocalModel: Object.freeze({ bool: true }),
  forceGeneralPath: Object.freeze({ bool: true }),   // v14.13 测量臂：跳过 5 个手写原型模板强制走兜底路径（= 真实用户仓的处境；缺省不出现 ⇒ 生产不变）
  birthAdaptiveFloor: Object.freeze({ bool: true, regime: true }),
  birthMinChars: Object.freeze({ int: Object.freeze([1, 20000]), regime: true }),
  birthMinSavedChars: Object.freeze({ int: Object.freeze([-4000, 4000]), regime: true }),
  birthTokenGate: Object.freeze({ bool: true, regime: true }),
})
export const POLICY_REGIME_KEYS = Object.freeze(Object.entries(POLICY_CONFIG_KEYS).filter(([, v]) => v.regime).map(([k]) => k))
export function validatePolicyConfig(config) {
  if (config == null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('policy:config-shape')
  const out = {}
  for (const [k, v] of Object.entries(config)) {
    const spec = POLICY_CONFIG_KEYS[k]
    if (!spec) throw new Error('policy:config-key:' + k)
    if (spec.enum) { if (!spec.enum.includes(v)) throw new Error('policy:config-value:' + k + '=' + String(v)) }
    else if (spec.int) { if (!Number.isInteger(v) || v < spec.int[0] || v > spec.int[1]) throw new Error('policy:config-value:' + k + '=' + String(v)) }
    else if (spec.bool) { if (typeof v !== 'boolean') throw new Error('policy:config-value:' + k + '=' + String(v)) }
    out[k] = v
  }
  return out
}
/** 策略是否改了制度（触发 / 放行闸）—— 计划与回执都要标出来：它比的是「换制度」而不是「调稿」。 */
export function policyRegimeKeys(policy) {
  const c = policy && policy.config
  return c ? POLICY_REGIME_KEYS.filter((k) => c[k] !== undefined) : []
}
/** 把策略的配置键落到 cfg 顶层（normalizeConfig 末尾调用；生产与评测同一函数）。返回被覆盖的键名列表。 */
export function applyPolicyConfig(c) {
  const conf = c && c.compressPolicy && c.compressPolicy.config
  if (!conf) return []
  const applied = []
  for (const [k, v] of Object.entries(conf)) { if (POLICY_CONFIG_KEYS[k] && c[k] !== v) { c[k] = v; applied.push(k) } else if (POLICY_CONFIG_KEYS[k]) applied.push(k) }
  return applied
}
/** 策略生效后的程序部件配置：policy.config 覆盖 cfg 顶层键（缺省 full = 被测对象不变）。 */
export function effectiveContinuationPath(cfg) {
  const fromPolicy = cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.continuationPath
  const v = fromPolicy || (cfg && cfg.continuationPath) || 'full'
  return POLICY_CONFIG_KEYS.continuationPath.enum.includes(v) ? v : 'full'
}
/** 策略生效后的程序拼接件配置：控制延续段 / 验收提示 / 收工三问的开关组合（缺省 all = 全部保留）。 */
export function effectiveProgramParts(cfg) {
  const fromPolicy = cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.programParts
  const v = fromPolicy || (cfg && cfg.programParts) || 'all'
  return POLICY_CONFIG_KEYS.programParts.enum.includes(v) ? v : 'all'
}
/** 策略生效后的提示词裁剪模式：full（缺省）| modular（按轮次态与台账态动态裁剪冗余样例与重复尾重申）。 */
export function effectivePromptMode(cfg) {
  const fromPolicy = cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.promptMode
  const v = fromPolicy || (cfg && cfg.promptMode) || 'full'
  return POLICY_CONFIG_KEYS.promptMode.enum.includes(v) ? v : 'full'
}
/** 策略生效后的动态水位/打转感知触发器开关（缺省 false = 固定门槛）。 */
export function effectiveAdaptiveFloor(cfg) {
  const fromPolicy = cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.birthAdaptiveFloor
  return typeof fromPolicy === 'boolean' ? fromPolicy : !!(cfg && cfg.birthAdaptiveFloor)
}
/** 策略生效后的本地微模型编译器开关（缺省 false = 远程副模型；true = 走 compileV5Local 零网络微模型）。 */
export function effectiveLocalModel(cfg) {
  const fromPolicy = cfg && cfg.compressPolicy && cfg.compressPolicy.config && cfg.compressPolicy.config.compressLocalModel
  return typeof fromPolicy === 'boolean' ? fromPolicy : !!(cfg && cfg.compressLocalModel)
}

/** 配置里的策略归一化：null/undefined/'base' ⇒ null（无策略）；对象必须有 string id 与合法 patches（或合法 config）。坏的抛。 */
export function normalizePolicy(x) {
  if (x == null || x === '' || x === 'base' || x === false) return null
  if (typeof x !== 'object') throw new Error('policy:shape')
  const patches = validatePolicyPatches(x.patches || [])
  const config = validatePolicyConfig(x.config)
  if (!patches.length && !Object.keys(config).length) return null   // 空补丁 + 空配置 = 无策略（与 base 逐字节相同）
  if (typeof x.id !== 'string' || !x.id) throw new Error('policy:id')
  const regime = POLICY_REGIME_KEYS.filter((k) => config[k] !== undefined)
  return Object.freeze({ id: x.id, patches: Object.freeze(patches.map((p) => Object.freeze({ ...p }))), ...(Object.keys(config).length ? { config: Object.freeze(config) } : {}), ...(regime.length ? { regime: Object.freeze(regime) } : {}) })
}
