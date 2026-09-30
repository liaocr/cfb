// 有界宿主搜索：只接批准的候选，异步本地执行先留原记录，再交同步 R3 证书内核。
import { canonicalJson, evidenceDigest, immutableJson } from './evidence-program.js'
import { createMemoryCandidate, freezeEffectSuite, createEvidenceArchive } from './effect-archive.js'
import { isEvidenceStore } from './evidence-store.js'
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/
export function createEvidenceDocument({ protected: protectedFields, sections, requiredSections = [] }) {
  if (!protectedFields || !Array.isArray(sections) || !sections.length || sections.length > 32 || new Set(sections.map((x) => x.id)).size !== sections.length ||
    sections.some((x) => !ID.test(x.id) || typeof x.text !== 'string' || x.text.length > 2400) || !Array.isArray(requiredSections) || requiredSections.some((id) => !sections.some((x) => x.id === id))) throw new Error('edit-document-schema')
  const body = { schema: 'cfb.bounded-document/1', protected: protectedFields, sections, requiredSections }
  return immutableJson({ ...body, id: evidenceDigest(body) })
}
export function editEvidenceDocument(document, operations, { maxEdits = 4, maxChangedChars = 256, maxFinalChars = 2400 } = {}) {
  const { id, ...original } = document || {}
  if (evidenceDigest(original) !== id) throw new Error('edit-document-drift')
  createEvidenceDocument(original)
  if (!Array.isArray(operations) || !Number.isInteger(maxEdits) || maxEdits < 0 || maxEdits > 8 || operations.length > maxEdits ||
    !Number.isInteger(maxChangedChars) || maxChangedChars < 0 || maxChangedChars > 2400 || !Number.isInteger(maxFinalChars) || maxFinalChars < 1 || maxFinalChars > 2400) throw new Error('edit-budget')
  const sections = original.sections.map((x) => ({ ...x })); let changedChars = 0
  for (const op of operations) {
    if (!op || !['add', 'replace', 'delete'].includes(op.type) || op.path !== undefined || !ID.test(op.id)) throw new Error('protected-or-invalid-edit')
    const at = sections.findIndex((x) => x.id === op.id)
    if (op.type !== 'delete' && (typeof op.text !== 'string' || !op.text)) throw new Error('edit-text')
    if (op.type === 'add') { if (at >= 0 || sections.length >= 32) throw new Error('edit-add'); sections.push({ id: op.id, text: op.text }); changedChars += op.text.length }
    else if (op.type === 'replace') { if (at < 0 || op.expectedText !== sections[at].text) throw new Error('edit-stale'); changedChars += Math.max(sections[at].text.length, op.text.length); sections[at].text = op.text }
    else { if (at < 0 || original.requiredSections.includes(op.id)) throw new Error('protected-section'); changedChars += sections[at].text.length; sections.splice(at, 1) }
  }
  if (changedChars > maxChangedChars || sections.reduce((n, x) => n + x.text.length, 0) > maxFinalChars) throw new Error('edit-budget')
  const updated = createEvidenceDocument({ ...original, sections })
  return immutableJson({ document: updated, edits: operations.length, changedChars, protectedDigest: evidenceDigest(updated.protected) })
}
export function createEvidenceIssues({ store, maxIssues = 32, clock = Date.now } = {}) {
  if (!isEvidenceStore(store) || !Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 64 || typeof clock !== 'function') throw new Error('issue-authority-or-budget')
  let head = store.readHead('evidence-issues')
  const recovered = head ? store.getJson(head.ref, { kind: 'issues' }) : null
  if (recovered && (recovered.schema !== 'cfb.evidence-issues/1' || recovered.owner !== store.sessionId || !Array.isArray(recovered.entries) || recovered.entries.length > maxIssues)) throw new Error('issue-restore')
  const entries = new Map((recovered?.entries || []).map((x) => [x.id, x])), seen = new Set(recovered?.seen || [])
  const record = ({ signature, family, component, reason, evidenceRef }) => {
    if ([family, component, reason].some((x) => typeof x !== 'string' || !x || x.length > 128)) throw new Error('issue-schema')
    store.getJson(evidenceRef, { kind: 'search-record' })
    if (seen.has(evidenceRef)) return false
    if (seen.size >= 4096) throw new Error('issue-evidence-budget')
    seen.add(evidenceRef)
    const id = evidenceDigest({ signature, family, component, reason }), current = entries.get(id)
    entries.set(id, { id, signature, family, component, reason, count: (current?.count || 0) + 1, status: 'open', firstAt: current?.firstAt ?? clock(), lastAt: clock(),
      samples: [...(current?.samples || []), evidenceRef].slice(-4) })
    if (entries.size > maxIssues) { const lowest = [...entries.values()].sort((a, b) => a.count - b.count || a.lastAt - b.lastAt || a.id.localeCompare(b.id))[0]; entries.delete(lowest.id) }
    return true
  }
  const view = () => immutableJson([...entries.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.id.localeCompare(b.id)))
  const persist = () => {
    const ref = store.putJson({ schema: 'cfb.evidence-issues/1', owner: store.sessionId, entries: view(), seen: [...seen] }, { kind: 'issues' })
    head = store.setHead('evidence-issues', ref, { expectedRevision: head?.revision || null }); return ref
  }
  return Object.freeze({ record, view, persist, resolve: (id) => { const row = entries.get(id); if (!row) return false; entries.set(id, { ...row, status: 'resolved' }); return true } })
}
export function compareEvidencePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length > 4096) throw new Error('paired-budget')
  const rows = pairs.map((p) => {
    const answerKnown = p.before && p.after && Object.hasOwn(p.before, 'answer') && Object.hasOwn(p.after, 'answer') && p.before.answer !== undefined && p.after.answer !== undefined
    const actionKnown = p.before && p.after && Object.hasOwn(p.before, 'action') && Object.hasOwn(p.after, 'action') && p.before.action !== undefined && p.after.action !== undefined
    return { id: String(p.id), answerUnchanged: answerKnown ? evidenceDigest(p.before.answer) === evidenceDigest(p.after.answer) : null,
      actionChanged: actionKnown ? evidenceDigest(p.before.action) !== evidenceDigest(p.after.action) : null }
  })
  const metric = (field) => ({ n: rows.filter((x) => x[field] === true).length, total: rows.filter((x) => x[field] !== null).length, unknown: rows.filter((x) => x[field] === null).length })
  return immutableJson({ schema: 'cfb.paired-observations/1', rows, answerUnchanged: metric('answerUnchanged'), actionChanged: metric('actionChanged'),
    note: '仅测已有 JSON 观测；没有 forced answering/LLM 因果消融/信息率/logprob，缺失答案不猜。' })
}
export async function runEvidenceSearch({ store, suite, candidates, evaluateAsync, maxCandidates = 8, maxEvaluations = 1024, evaluationTimeoutMs = 10000, evaluationScope = null }) {
  if (!isEvidenceStore(store) || typeof evaluateAsync !== 'function' || !Array.isArray(candidates) || candidates.length > 64 ||
    evaluationScope !== null && (typeof evaluationScope !== 'string' || !/^[a-f0-9]{64}$/.test(evaluationScope)) || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 8 || !Number.isInteger(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 2048 ||
    !Number.isInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1 || evaluationTimeoutMs > 30000) throw new Error('search-authority-or-budget')
  const { digest, testDigest, ...definition } = suite || {}
  if (evidenceDigest(definition) !== digest || evidenceDigest(definition.test) !== testDigest) throw new Error('search-suite-drift')
  const evaluatorSourceDigest = evidenceDigest({ code: String(evaluateAsync), version: suite.evaluatorVersion, evaluationScope })
  const frozen = freezeEffectSuite({ ...definition, evaluatorVersion: suite.evaluatorVersion + ':' + evaluatorSourceDigest })
  const archive = createEvidenceArchive({ store }), issues = createEvidenceIssues({ store }), memo = new Map(), screened = new Map(), finalists = new Map()
  const key = (entry, input) => evidenceDigest({ candidateId: entry?.id || null, input })
  let rejectionHead = store.readHead('search-rejections')
  const priorBuffer = rejectionHead ? store.getJson(rejectionHead.ref, { kind: 'search-rejections' }) : null
  if (priorBuffer && (priorBuffer.schema !== 'cfb.search-rejections/1' || priorBuffer.owner !== store.sessionId || !Array.isArray(priorBuffer.items) || priorBuffer.items.length > 128)) throw new Error('search-rejections-schema')
  const rejectionScope = evidenceDigest({ suiteDigest: frozen.digest, evaluatorSourceDigest, evaluationScope })
  const rejections = new Map((priorBuffer?.items || []).map((x) => [x.key, x]))
  const remember = (entry, report) => {
    if (evaluationScope === null) return // 无宿主环境/依赖指纹时，不把旧失败永久当成当前失败。
    const k = evidenceDigest({ rejectionScope, candidateId: entry.id })
    rejections.delete(k); rejections.set(k, { key: k, scope: rejectionScope, candidateId: entry.id, report })
    if (rejections.size > 128) rejections.delete(rejections.keys().next().value)
    const ref = store.putJson({ schema: 'cfb.search-rejections/1', owner: store.sessionId, items: [...rejections.values()] }, { kind: 'search-rejections' })
    rejectionHead = store.setHead('search-rejections', ref, { expectedRevision: rejectionHead?.revision || null })
  }
  let evaluations = 0, testEvaluations = 0, duplicates = 0, priorRejections = 0
  const execute = async (entry, fixture, split) => {
    const k = key(entry, fixture.input)
    if (memo.has(k)) return memo.get(k)
    if (evaluations >= maxEvaluations) throw new Error('search-evaluation-budget')
    evaluations++; if (split === 'test') testEvaluations++
    const abort = new AbortController(); let timer, output, error = null
    try {
      output = await Promise.race([Promise.resolve().then(() => evaluateAsync(entry, immutableJson(fixture.input), abort.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('search-evaluation-timeout')) }, evaluationTimeoutMs) })])
      canonicalJson(output)
    } catch (e) { error = e.message || 'evaluation-error'; output = {} }
    finally { clearTimeout(timer) }
    const record = { schema: 'cfb.search-record/1', evaluatorSourceDigest, suiteDigest: frozen.digest, candidateId: entry?.id || null, fixtureId: fixture.id,
      inputDigest: evidenceDigest(fixture.input), split, output, error }
    const ref = store.putJson(record, { kind: 'search-record' }), item = { ...record, ref }
    memo.set(k, item); return item
  }
  const cachedEvaluate = (entry, input) => { const item = memo.get(key(entry, input)); if (!item) throw new Error('unevaluated-cache-slot'); return item.output }
  archive.beginCycle({ suite: frozen, evaluate: cachedEvaluate, maxCandidates })
  for (const definition of candidates) {
    const entry = createMemoryCandidate(definition)
    if (screened.has(entry.id)) { duplicates++; continue }
    if (screened.size >= maxCandidates) break
    const prior = evaluationScope === null ? null : rejections.get(evidenceDigest({ rejectionScope, candidateId: entry.id }))
    if (prior) {
      if (prior.scope !== rejectionScope || prior.candidateId !== entry.id || prior.report.candidateId !== entry.id || prior.report.gate.ok !== false) throw new Error('search-rejection-scope')
      screened.set(entry.id, { ...prior.report, cachedFromPriorCycle: true }); priorRejections++; continue
    }
    for (const split of ['train', 'selection']) for (const fixture of frozen[split]) { await execute(null, fixture, split); await execute(entry, fixture, split) }
    const report = archive.consider(entry); screened.set(entry.id, report)
    if (report.gate.ok) finalists.set(entry.id, entry)
    else { remember(entry, report); for (const effect of report.effects.filter((x) => ['-', '?'].includes(x.sign) || x.after === false)) {
      const fixture = [...frozen.train, ...frozen.selection].find((f) => f.id === effect.fixtureId), item = memo.get(key(entry, fixture.input))
      issues.record({ signature: entry.signature, family: effect.family, component: String(fixture.input.profile || 'base'), reason: report.gate.reason, evidenceRef: item.ref })
    } }
  }
  // 固定候选之后，先持久预占 test。不得先跑异步 test，再补写消耗日志。
  if (finalists.size) {
    archive.reserveHoldout()
    for (const fixture of frozen.test) { await execute(null, fixture, 'test'); for (const entry of finalists.values()) await execute(entry, fixture, 'test') }
  }
  const final = archive.finalize(), archiveRef = archive.persist(), issuesRef = issues.persist()
  return immutableJson({ schema: 'cfb.evidence-search/1', suiteDigest: frozen.digest, evaluatorSourceDigest, archiveRef, issuesRef,
    counters: { candidates: screened.size, maxCandidates, evaluations, maxEvaluations, testEvaluations, duplicates, priorRejections },
    screened: [...screened.values()], final, activeIds: archive.snapshot().active.map((x) => x.entry.id), issues: issues.view(), records: [...memo.values()] })
}
