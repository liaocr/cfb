// dsh-cot-form-b / host-follow.js —— 宿主对话模型 / provider 跟随（v11.11）
//
// 用户原话（2026-09-15）：「宿主用哪个模型对话，我们就用那个模型压缩。」
// 机制：`llm/stream` 的 options 带 `model` / `provider`（= 本次对话调用用的模型）。
//
// v11.11 之前：看到新模型就**改写共享的 cfg.model / cfg.followProvider**。birth 路径在同一个同步调用里
//   立刻复制了一份（streamCfg），所以不受影响；但 checkpoint 的 early-fire、预热等后来才读 cfg 的地方，
//   会读到**别的调用**写进去的值（两个会话 / 子 agent / 标题生成交错时）。
// v11.11：共享 cfg 永不改写。每次 llm/stream 用 `callConfig(options)` 派生**本次调用专属**的配置。
//
// 不猜（语义与旧实现逐条相同）：
//   - 本次调用带了 model ⇒ 用它；没带 ⇒ 用最近一次见过的宿主模型；都没有 ⇒ patch 里显式写的 cfg.model
//     （可能为空串 ⇒ 下游直接抛 `no model:` ⇒ 原文放行）。
//   - followHostModel:false ⇒ 永远用显式 cfg.model。
//   - provider 同理（followHostProvider !== false 时跟随），决定端点与钥匙。
//   - 我们自己的副模型调用走 node:https 直连，不经过宿主 llm/stream ⇒ 不会把自己当成宿主。

/**
 * @param {object} cfg 归一化后的配置（只读）
 * @param {(tag: string, data: object) => void} trace
 */
export function createHostFollower(cfg, trace) {
  const explicitModel = cfg.model
  const explicitProvider = cfg.followProvider
  let hostModel = null
  let hostProvider = null

  /** 记录本次调用报出的宿主模型；变化时留 trace（与旧实现同名同字段）。从不抛。 */
  function observe(options, n) {
    try {
      const hm = options && options.model
      const hp = options && options.provider
      if ((hm && hm !== hostModel) || (hp && hp !== hostProvider)) {
        if (hm) hostModel = hm
        hostProvider = hp || hostProvider
        const eff = callConfig(options)
        trace('distill-endpoint-target', { hostProvider, followProvider: eff.followProvider || null })
        trace('host-model', {
          model: hm,
          provider: options && options.provider,
          followHostModel: cfg.followHostModel,
          effectiveModel: eff.model,
          n,
        })
      }
    } catch (e) { trace('host-model-error', { error: String((e && e.message) || e) }) }
  }

  /** 本次调用专属的配置副本（共享 cfg 不动）。 */
  function callConfig(options) {
    const hm = options && options.model
    const hp = options && options.provider
    const model = cfg.followHostModel ? (hm || hostModel || explicitModel) : explicitModel
    const followProvider = cfg.followHostProvider !== false ? (hp || hostProvider || explicitProvider) : explicitProvider
    return { ...cfg, model, followProvider }
  }

  return { observe, callConfig, hostModel: () => hostModel, explicitModel }
}
