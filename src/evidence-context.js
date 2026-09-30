// 宿主消息装配/无损块访问。不是原稿摘要器；L0 是完整类型化契约/义务，L1/L2 只增不减。
import { assertEvidenceContract, assertEvidenceProgram, canonicalJson, evidenceDigest, immutableJson, evaluateEvidencePredicate } from './evidence-program.js'
import { isEvidenceStore, recoverEvidenceBlock } from './evidence-store.js'
import { isEvidenceVerifier } from './evidence-host.js'
import { createEvidenceIntents, replayEvidenceTrace, binaryEvidenceFeedback } from './evidence-intents.js'
import { estimateTokens } from './tokens.js'
const LEVELS = ['L0', 'L1', 'L2']
const PROTOCOL = '只按完整类型化契约、当前修订与宿主认证回执求解。unknown 不等于通过；动作通过不等于验收通过。失败 RAW/EXPLANATION 不回灌。层可独立读取，预算不足整层拒绝，不删约束。'
export function auditEvidenceSlots(value, contract) {
  let authorized = false
  try { if (contract) { assertEvidenceProgram(value, contract); authorized = true } } catch { /* 留作未授权提议 */ }
  const rows = (Array.isArray(value?.steps) ? value.steps : []).map((s) => {
    const typed = Array.isArray(s.expectedObservations)
    const expectation = typed && s.expectedObservations.length && s.expectedObservations.every((x) => { try { evaluateEvidencePredicate(x.predicate, {}); return typeof x.checkId === 'string' } catch { return false } })
    const action = s.action?.type === 'observe' || s.action?.type === 'replace' && [s.action.path, s.action.oldText, s.action.newText].every((x) => typeof x === 'string' && x)
    return { stepId: s.id || 'unknown', preconditions: Array.isArray(s.preconditions) ? 'present' : 'missing', action: action ? 'present' : 'missing',
      expectation: expectation ? 'present' : s.expectedObservation ? 'unknown' : 'missing',
      check: Array.isArray(s.checkCommand) && s.checkCommand.length ? 'present' : s.checkCommand ? 'unknown' : 'missing' }
  })
  const statuses = rows.flatMap(({ stepId, ...x }) => Object.values(x)), missing = statuses.filter((x) => x === 'missing').length + (rows.length ? 0 : 1), unknown = statuses.filter((x) => x === 'unknown').length
  return immutableJson({ schema: 'cfb.slot-audit/1', authorized, complete: authorized && !missing && !unknown, missing, unknown, rows })
}
export function createEvidenceContext({ store, contract, verifier, readRevision, readRuntime = () => ({}), clock = Date.now,
  maxTokensEst = 8192, maxReadBytes = 1048576, maxReadCalls = 128, maxArtifacts = 16, allowOptimizerReads = false }) {
  const c = assertEvidenceContract(contract)
  if (!isEvidenceStore(store) || !isEvidenceVerifier(verifier) || verifier.contract.digest !== c.digest ||
    typeof readRevision !== 'function' || typeof readRuntime !== 'function' || typeof clock !== 'function' || typeof allowOptimizerReads !== 'boolean' ||
    !Number.isInteger(maxTokensEst) || maxTokensEst < 1 || maxTokensEst > 131072 || !Number.isInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 8388608 ||
    !Number.isInteger(maxReadCalls) || maxReadCalls < 1 || maxReadCalls > 1024 || !Number.isInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > 32) throw new Error('context-authority-or-budget')
  const prefix = canonicalJson({ schema: 'cfb.stable-prefix/1', protocol: PROTOCOL, contract: c }), prefixDigest = evidenceDigest({ prefix })
  const intents = createEvidenceIntents({ contract: c, verifier, sessionId: store.sessionId, readRevision, clock })
  const records = new Map(), emitted = new Map()
  let latest = null, epoch = 0, tokensUsedEst = 0, readCalls = 0, layerDeliveries = 0
  const budget = () => ({ maxTokensEst, tokensUsedEst, remainingTokensEst: maxTokensEst - tokensUsedEst, maxReadBytes, maxReadCalls, remainingReadCalls: maxReadCalls - readCalls, readCalls, layerDeliveries,
    estimation: 'content:estimateTokens:cjk-0.6-other-0.3;render:prefix+full-layer-text', providerReportedUsage: null })
  const publish = (program, result) => {
    latest = null; epoch++ // 新归档损坏/读取失败先撤销旧的模型交付授权。
    const p = assertEvidenceProgram(program, c), index = store.getJson(result.artifactRef, { kind: 'index' })
    if (p.sessionId !== store.sessionId || index.schema !== 'cfb.artifact-index/1' || index.programId !== p.id || index.contractDigest !== c.digest || index.sessionId !== store.sessionId ||
      index.blocks.length !== p.steps.length + 2 || new Set(index.blocks.map((b) => b.id)).size !== index.blocks.length) throw new Error('context-artifact-binding')
    const trace = replayEvidenceTrace(p, result.receipts || [], verifier)
    if (result.state && trace && evidenceDigest(result.state) !== evidenceDigest(trace)) throw new Error('context-trace-mismatch')
    const revision = readRevision(), verified = result.ok === true && result.status === 'verified' && trace?.status === 'verified' && trace.revision === revision && verifier.intact()
    if (result.ok === true && !verified) throw new Error('context-unverified-claim')
    const at = clock(), blocks = index.blocks.map((b, i) => {
      const expectedId = i === 0 ? 'raw' : i === 1 ? 'explanation' : p.steps[i - 2].id
      const expectedType = i === 0 ? 'RAW' : i === 1 ? 'EXPLANATION' : 'STEP'
      const value = recoverEvidenceBlock(store, result.artifactRef, b.id), text = typeof value === 'string' ? value : canonicalJson(value)
      if (b.id !== expectedId || b.type !== expectedType || b.bytes !== Buffer.byteLength(text) ||
        i === 1 && value !== p.explanation || i >= 2 && evidenceDigest(value) !== evidenceDigest(p.steps[i - 2])) throw new Error('context-block-binding')
      const previous = records.get(result.artifactRef)?.blocks.find((x) => x.id === b.id)
      return { id: b.id, type: b.type, handle: b.handle, bytes: b.bytes, ...(b.chars === undefined ? {} : { chars: b.chars }), tokensEst: estimateTokens(text), createdAt: previous?.createdAt ?? at,
        readCalls: previous?.readCalls || 0, layerDeliveries: previous?.layerDeliveries || 0, lastAccessAt: previous?.lastAccessAt ?? null }
    })
    const feedback = binaryEvidenceFeedback({ program: p, receipts: result.receipts || [], diagnosticReceipts: result.diagnostic?.receipts || [], verifier, revision })
    const row = { ref: result.artifactRef, program: p, blocks, revision, status: result.status, verified, trace, feedback, epoch }
    records.delete(row.ref); records.set(row.ref, row); latest = row
    if (records.size > maxArtifacts) records.delete(records.keys().next().value)
    if (!verified && result.status !== 'proposed' && trace) intents.invalidateRound(trace.roundId)
    return row.ref
  }
  const canRead = (row, block, role) => {
    if (role === 'optimizer') return allowOptimizerReads
    if (role !== 'solver' || !latest || !verifier.intact() || row.revision !== readRevision()) return false
    if (block.type !== 'STEP') return row.verified
    const step = row.program.steps.find((s) => s.id === block.id)
    return !!step && row.trace?.verifiedSteps.includes(step.id) && step.expectedObservations.every(({ checkId }) =>
      row.trace.receiptIds.length && row.feedback.checks.some((x) => x.checkId === checkId && x.status === 'pass' && x.fresh))
  }
  const table = () => { const now = clock(), revision = readRevision(); return [...records.values()].flatMap((row) => row.blocks.map((b) => ({ ...b,
    indexRef: row.ref, programId: row.program.id, ageMs: Math.max(0, now - b.createdAt), accesses: b.readCalls + b.layerDeliveries,
    freshness: row.revision !== revision || !verifier.intact() ? 'stale-revision' : row === latest ? 'current' : 'older-artifact', verified: row.verified && row.revision === revision && verifier.intact(),
    solverReadable: canRead(row, b, 'solver') }))) }
  const readBlock = (indexRef, blockId, { role = 'solver', tokenBudgetEst = maxTokensEst - tokensUsedEst } = {}) => {
    const blocked = (reason) => immutableJson({ ok: false, reason })
    const row = records.get(indexRef), block = row?.blocks.find((b) => b.id === blockId)
    if (!block) return blocked('unknown-context-block')
    if (!canRead(row, block, role)) return blocked('block-role-or-proof-denied')
    if (readCalls >= maxReadCalls) return blocked('read-call-budget')
    if (!Number.isInteger(tokenBudgetEst) || tokenBudgetEst < 0 || block.bytes > maxReadBytes || block.tokensEst > Math.min(tokenBudgetEst, maxTokensEst - tokensUsedEst)) return blocked('block-read-budget')
    const value = recoverEvidenceBlock(store, indexRef, blockId), text = typeof value === 'string' ? value : canonicalJson(value)
    const cost = estimateTokens(text)
    if (cost !== block.tokensEst || Buffer.byteLength(text) !== block.bytes) return blocked('block-size-drift')
    tokensUsedEst += cost; readCalls++; block.readCalls++; block.lastAccessAt = clock()
    return immutableJson({ ok: true, value, tokensEst: cost, bytes: block.bytes, budget: budget() })
  }
  const render = ({ levels = ['L0'], tokenBudgetEst = maxTokensEst - tokensUsedEst } = {}) => {
    const blocked = (reason) => immutableJson({ ok: false, reason, prefix: null, layers: [], budget: budget() })
    if (!latest) return blocked('no-active-evidence')
    if (!Array.isArray(levels) || !levels.length || levels.length > 3 || new Set(levels).size !== levels.length || levels.some((x) => !LEVELS.includes(x)) || !Number.isInteger(tokenBudgetEst) || tokenBudgetEst < 0) throw new Error('context-layer-options')
    if (latest.revision !== readRevision() || !verifier.intact()) return blocked('context-stale')
    const runtime = readRuntime()
    const core = { schema: 'cfb.obligation-core/1', sessionId: store.sessionId, contract: c, programId: latest.program.id, steps: latest.program.steps,
      cycle: { epoch, roundId: latest.trace?.roundId || null, revision: latest.revision, status: latest.status, verified: latest.verified },
      slotAudit: auditEvidenceSlots(latest.program, c), obligations: intents.view(), feedback: latest.feedback,
      budgets: { rounds: runtime.rounds ?? null, maxRounds: runtime.maxRounds ?? null, repairs: runtime.repairs ?? null, maxRepairRounds: runtime.maxRepairRounds ?? null,
        checks: runtime.checks ?? null, maxChecks: runtime.maxChecks ?? null, context: budget() } }
    const coreDigest = evidenceDigest(core)
    const bodies = levels.map((level) => ({ schema: 'cfb.evidence-description/1', level, prefixDigest, coreDigest, core,
      annotations: level === 'L0' ? [] : latest.program.steps.map((s) => level === 'L1' ? { stepId: s.id, order: ['preconditions', 'action', 'postconditions'],
        rule: '仅前置回执通过才执行；全部验收通过才兑现。' } : { stepId: s.id, unavailable: '缺失/陈旧/条件不等价的观察一律 unknown；取消/失效义务不能执行。', acceptanceChecks: s.expectedObservations.map((x) => x.checkId) }) }))
    const texts = bodies.map(canonicalJson), cost = estimateTokens(prefix) + texts.reduce((sum, s) => sum + estimateTokens(s), 0)
    if (cost > Math.min(tokenBudgetEst, maxTokensEst - tokensUsedEst)) return blocked('context-token-budget')
    if (emitted.size + bodies.length > 256) return blocked('context-frame-budget')
    let refs
    try { refs = bodies.map((body) => store.putJson(body, { kind: 'description' })) } catch { return blocked('context-store-budget-or-error') }
    refs.forEach((ref, i) => emitted.set(ref, { coreDigest, level: levels[i] }))
    tokensUsedEst += cost; layerDeliveries += levels.length
    for (const b of latest.blocks) if (b.type === 'STEP') { b.layerDeliveries += levels.length; b.lastAccessAt = clock() }
    return immutableJson({ ok: true, prefix, prefixDigest, layers: refs.map((ref, i) => ({ ref, level: levels[i], text: texts[i], tokensEst: estimateTokens(texts[i]) })), tokensEst: cost, budget: budget() })
  }
  const decode = (refs) => {
    if (!Array.isArray(refs) || !refs.length || refs.length > 3 || new Set(refs).size !== refs.length) throw new Error('description-subset')
    const layers = refs.map((ref) => { if (!emitted.has(ref)) throw new Error('description-authority'); return store.getJson(ref, { kind: 'description' }) })
    const first = layers[0]
    if (new Set(layers.map((x) => x.level)).size !== layers.length || layers.some((x) => x.schema !== 'cfb.evidence-description/1' || x.prefixDigest !== prefixDigest || !x.core || evidenceDigest(x.core) !== x.coreDigest || x.coreDigest !== first.coreDigest ||
      x.core.sessionId !== store.sessionId || x.core.contract.digest !== c.digest || x.core.cycle.epoch !== epoch || x.core.cycle.revision !== readRevision() || !verifier.intact())) throw new Error('description-core-or-scope')
    const program = { schema: 'cfb.evidence-program/1', sessionId: first.core.sessionId, contractDigest: c.digest, explanation: latest.program.explanation, steps: first.core.steps }
    if (evidenceDigest(program) !== first.core.programId || !auditEvidenceSlots({ ...program, id: first.core.programId }, c).complete) throw new Error('description-core-incomplete')
    return immutableJson(first.core)
  }
  return Object.freeze({ stablePrefix: () => prefix, publish, render, decode, readBlock, intents,
    reset: () => { latest = null; epoch++ },
    view: () => immutableJson({ schema: 'cfb.context-dashboard/1', epoch, latest: latest?.ref || null, budget: budget(), blocks: table(), obligations: intents.view() }) })
}
