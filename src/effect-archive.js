// 规则/事实/疫苗签名档案：逐项二元效果，冻结三切分，盲测只关门一次。
import crypto from 'node:crypto'
import { canonicalJson, evidenceDigest, evaluateEvidencePredicate, immutableJson } from './evidence-program.js'
const KINDS = new Set(['rule', 'fact', 'vaccine'])
export function createMemoryCandidate(def) {
  if (!KINDS.has(def.kind) || typeof def.body !== 'string' || !def.body || def.body.length > 2400 || !def.signature ||
    ['taskFamily', 'environment', 'contractVersion'].some((k) => typeof def.signature[k] !== 'string' || !def.signature[k]) ||
    !Array.isArray(def.sources) || !def.sources.length || def.sources.some((s) => typeof s !== 'string' || !s) ||
    typeof def.trigger !== 'object' || !def.trigger) throw new Error('memory-schema')
  // 验证 DSL；未知值没有事实含义，只检测谓词是否合法。
  evaluateEvidencePredicate(def.trigger, {})
  if (def.expiresAt !== undefined && (!Number.isFinite(def.expiresAt) || def.expiresAt < 0)) throw new Error('memory-expiry')
  const body = { schema: 'cfb.memory-candidate/1', kind: def.kind, body: def.body,
    signature: def.signature, trigger: def.trigger, sources: def.sources, ...(def.expiresAt === undefined ? {} : { expiresAt: def.expiresAt }) }
  return immutableJson({ ...body, id: evidenceDigest(body) })
}
export function freezeEffectSuite(def) {
  if (typeof def.id !== 'string' || !def.id || typeof def.evaluatorVersion !== 'string' || !def.evaluatorVersion) throw new Error('suite-schema')
  const ids = new Set(), families = new Map(), parts = {}
  for (const split of ['train', 'selection', 'test']) {
    if (!Array.isArray(def[split]) || !def[split].length || def[split].length > 96) throw new Error('suite-split')
    parts[split] = def[split].map((f) => {
      if (typeof f.id !== 'string' || !f.id || ids.has(f.id) || typeof f.family !== 'string' || !f.family || !Object.hasOwn(f, 'input')) throw new Error('fixture-schema')
      ids.add(f.id)
      if (families.has(f.family) && families.get(f.family) !== split) throw new Error('family-leakage')
      families.set(f.family, split); evaluateEvidencePredicate(f.predicate, {})
      return { id: f.id, family: f.family, input: f.input, predicate: f.predicate }
    })
  }
  const body = { schema: 'cfb.effect-suite/1', id: def.id, evaluatorVersion: def.evaluatorVersion, ...parts }
  return immutableJson({ ...body, digest: evidenceDigest(body), testDigest: evidenceDigest(parts.test) })
}
/** 宿主长期持有；同任务族的盲测不能换个 cycle/id 重复搜索。快照供持久化，不能交生成器。 */
export function createHoldoutRegistry(initial = []) {
  if (!Array.isArray(initial) || initial.length > 4096 || initial.some((f) => typeof f !== 'string' || !f) || new Set(initial).size !== initial.length) throw new Error('holdout-registry-schema')
  const spent = new Set(initial)
  return Object.freeze({
    consume: (families) => {
      if (!Array.isArray(families) || families.some((f) => typeof f !== 'string' || !f || spent.has(f))) throw new Error('holdout-already-consumed')
      if (spent.size + families.length > 4096) throw new Error('holdout-registry-budget')
      families.forEach((f) => spent.add(f))
    },
    snapshot: () => immutableJson([...spent].sort()),
  })
}
const effectSign = (before, after) => before === null || after === null ? '?' : before === after ? '0' : after ? '+' : '-'
const summary = (effects) => ({ positive: effects.filter((x) => x.sign === '+').length, negative: effects.filter((x) => x.sign === '-').length,
  ties: effects.filter((x) => x.sign === '0').length, unknown: effects.filter((x) => x.sign === '?').length })
/** 不允许负项抵消：每个测试均不退步，selection/test 至少一项严格提升。 */
export function gateSignedEffects(effects, { requireTest = true } = {}) {
  for (const split of requireTest ? ['train', 'selection', 'test'] : ['train', 'selection']) {
    const rows = effects.filter((x) => x.split === split)
    if (!rows.length) return { ok: false, reason: 'missing-' + split }
    const s = summary(rows)
    if (s.unknown) return { ok: false, reason: 'unknown-' + split }
    if (s.negative) return { ok: false, reason: 'regression-' + split }
    if (split !== 'train' && !s.positive) return { ok: false, reason: 'tie-' + split }
  }
  return { ok: true, reason: 'strict-heldout-improvement' }
}
/** 独立执行器 evaluate 只收到输入和候选，收不到 split/判据/参考输出，且必须同步、无副作用。 */
export function createEffectCycle({ suite, evaluate, registry, maxCandidates = 8 }) {
  const { digest, testDigest, ...body } = suite || {}
  if (evidenceDigest(body) !== digest || evidenceDigest(body.test) !== testDigest || typeof evaluate !== 'function' || !registry ||
    !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32) throw new Error('cycle-schema')
  const secret = crypto.randomBytes(32), cycleId = crypto.randomUUID(), screened = new Map(), baseline = new Map()
  const evaluatorDigest = evidenceDigest({ version: body.evaluatorVersion, code: String(evaluate) })
  let closed = false, attempts = 0
  const seal = (report) => {
    const value = { schema: 'cfb.effect-certificate/1', cycleId, suiteDigest: digest, evaluatorDigest, ...report }, id = evidenceDigest(value)
    return immutableJson({ ...value, id, signature: crypto.createHmac('sha256', secret).update(id).digest('hex') })
  }
  const authenticate = (report) => {
    try {
      const { id, signature, ...r } = report
      if (r.cycleId !== cycleId || r.suiteDigest !== digest || r.evaluatorDigest !== evaluatorDigest || evidenceDigest(r) !== id || !/^[a-f0-9]{64}$/.test(signature)) return false
      return crypto.timingSafeEqual(crypto.createHmac('sha256', secret).update(id).digest(), Buffer.from(signature, 'hex'))
    } catch { return false }
  }
  const execute = (entry, fixture) => {
    try {
      const output = evaluate(entry, immutableJson(fixture.input))
      if (output && typeof output.then === 'function') return null
      canonicalJson(output)
      return evaluateEvidencePredicate(fixture.predicate, output)
    } catch { return null }
  }
  const effectsFor = (entry, splits) => splits.flatMap((split) => body[split].map((f) => {
    if (!baseline.has(f.id)) baseline.set(f.id, execute(null, f))
    const before = baseline.get(f.id), after = execute(entry, f)
    return { fixtureId: f.id, family: f.family, split, before, after, sign: effectSign(before, after) }
  }))
  const screen = (candidate) => {
    if (closed) throw new Error('cycle-closed')
    const entry = createMemoryCandidate(candidate)
    if (candidate.id && entry.id !== candidate.id) throw new Error('candidate-drift')
    if (screened.has(entry.id)) return screened.get(entry.id).report
    if (++attempts > maxCandidates) throw new Error('candidate-budget')
    const effects = effectsFor(entry, ['train', 'selection']), gate = gateSignedEffects(effects, { requireTest: false })
    const report = seal({ candidateId: entry.id, phase: 'screen', effects, gate })
    screened.set(entry.id, { entry, report }); return report
  }
  const finalize = (candidateIds) => {
    if (closed) throw new Error('cycle-closed')
    if (!Array.isArray(candidateIds) || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => !screened.get(id)?.report.gate.ok)) throw new Error('finalist-schema')
    if (!candidateIds.length) { closed = true; return [] } // 全拒绝时关周期，不触碰盲测。
    // 从此盲测不可再用于本周期的候选选择；失败也消耗这批留出族。
    registry.consume([...new Set(body.test.map((f) => f.family))]); closed = true
    return candidateIds.map((id) => {
      const { entry, report } = screened.get(id), effects = [...report.effects, ...effectsFor(entry, ['test'])]
      return seal({ candidateId: id, phase: 'final', effects, gate: gateSignedEffects(effects) })
    })
  }
  return Object.freeze({ cycleId, suiteDigest: digest, screen, finalize, authenticate,
    view: () => immutableJson({ cycleId, suiteDigest: digest, evaluatorDigest, attempts, maxCandidates, closed }) })
}
/** 档案宿主侧持有：拒绝缓冲与失败证据不自动进入上下文，默认只检索 1 条。 */
export function createEvidenceArchive({ maxEntries = 64, maxRejected = 32, clock = Date.now } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 512 || !Number.isInteger(maxRejected) || maxRejected < 1 || maxRejected > 128 || typeof clock !== 'function') throw new Error('archive-budget')
  const active = new Map(), rejected = new Map(), retired = new Map(), candidates = new Map(), events = []
  const registry = createHoldoutRegistry()
  let cycle = null
  const event = (type, id, reason) => { events.push({ type, id, reason }); if (events.length > 128) events.shift() }
  const reject = (entry, effects, reason) => {
    // 一格一条保留不同 kind/signature/reason 的失败，不让近重复淹没缓冲。
    const cell = evidenceDigest({ kind: entry.kind, signature: entry.signature, reason })
    rejected.delete(cell); rejected.set(cell, { entry, effects, reason })
    if (rejected.size > maxRejected) rejected.delete(rejected.keys().next().value)
    event('reject', entry.id, reason)
  }
  const beginCycle = (options) => {
    if (cycle && !cycle.view().closed) throw new Error('previous-cycle-open')
    cycle = createEffectCycle({ ...options, registry }); candidates.clear(); return cycle.view()
  }
  const consider = (def) => {
    if (!cycle) throw new Error('no-effect-cycle')
    const entry = createMemoryCandidate(def)
    if (retired.has(entry.id)) throw new Error('retired-candidate')
    const report = cycle.screen(entry)
    if (!cycle.authenticate(report)) throw new Error('effect-certificate-invalid')
    if (report.gate.ok) candidates.set(entry.id, entry)
    else reject(entry, report.effects, report.gate.reason)
    return report
  }
  const finalize = () => {
    if (!cycle) throw new Error('no-effect-cycle')
    const reports = cycle.finalize([...candidates.keys()])
    for (const report of reports) {
      const entry = candidates.get(report.candidateId)
      if (!cycle.authenticate(report)) throw new Error('effect-certificate-invalid')
      if (!report.gate.ok) { reject(entry, report.effects, report.gate.reason); continue }
      const cell = evidenceDigest({ kind: entry.kind, signature: entry.signature, trigger: entry.trigger })
      const prior = [...active.values()].find((x) => x.cell === cell)
      // 同一适用格已有技能，不用对裸基线的提升冒充对在库技能的提升。
      if (prior && prior.entry.id !== entry.id) { reject(entry, report.effects, 'occupied-cell-needs-paired-ablation'); continue }
      if (!prior && active.size >= maxEntries) { reject(entry, report.effects, 'archive-capacity'); continue }
      if (retired.size >= maxEntries * 2) { reject(entry, report.effects, 'retirement-budget'); continue }
      active.set(entry.id, { entry, cell, effects: report.effects, certificateId: report.id, suiteDigest: report.suiteDigest })
      event('accept', entry.id, 'strict-heldout-improvement')
    }
    candidates.clear(); return reports
  }
  const retire = (id, reason = 'counterexample') => {
    if (typeof reason !== 'string' || !reason) throw new Error('retirement-reason')
    const item = active.get(id)
    if (!item) return false
    active.delete(id); retired.set(id, { ...item, reason }); event('retire', id, reason); return true
  }
  const retrieve = (context, { k = 1 } = {}) => {
    if (!Number.isInteger(k) || k < 0 || k > 1) throw new Error('retrieval-budget')
    const now = clock(), fp = evidenceDigest(context.signature)
    const matches = [...active.values()].filter(({ entry }) => evidenceDigest(entry.signature) === fp &&
      (entry.expiresAt === undefined || now < entry.expiresAt) && evaluateEvidencePredicate(entry.trigger, context.observation) === true)
    // 不使用 Likert/总分排名；确定性顺序，默认 k=1，候选同样先过独立门。
    return immutableJson(matches.sort((a, b) => a.entry.id.localeCompare(b.entry.id)).slice(0, k).map((x) => ({ id: x.entry.id, kind: x.entry.kind, body: x.entry.body, sources: x.entry.sources })))
  }
  const snapshot = () => immutableJson({ schema: 'cfb.effect-archive/1', active: [...active.values()], rejected: [...rejected.values()], retired: [...retired.values()],
    heldoutFamiliesSpent: registry.snapshot(), events, cycle: cycle?.view() || null })
  return Object.freeze({ beginCycle, consider, finalize, retire, retrieve, snapshot })
}
