// 有界训练→独立二元评测→下一批准候选。无内置模型/网络调用；test只在选择完成后一次消费。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createEvidenceStore } from '../../src/evidence-store.js'
import { evidenceDigest, immutableJson, evaluateEvidencePredicate } from '../../src/evidence-program.js'
import { freezeEffectSuite } from '../../src/effect-archive.js'
import { CONSUMED_TRAINING_FAMILIES, hasTrainingSecrets } from '../../src/training-core.js'
import { assertTrainingPlan, trainingSourceDigest } from './training-plan.mjs'
import { privateTrainingPath } from './training-io.mjs'
import { readJson, writeJson, assertSafePath, syncDirectory } from './eval-files.mjs'
const SID = 'cfb.training-iteration-registry/1', NS = crypto.createHash('sha256').update(SID).digest('hex')
const sign = (before, after) => before === null || after === null ? '?' : before === after ? '0' : after ? '+' : '-'
export function freezeTrainingIteration({ id, candidatePlans, suite, evaluationScope, maxCandidates = 3, maxComputeSteps, maxHttpRequests = 0, timeoutMs = 30000 }) {
  if (typeof id !== 'string' || !/^[\w.-]{1,100}$/.test(id) || !Array.isArray(candidatePlans) || !candidatePlans.length || candidatePlans.length > 8 || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 8 || candidatePlans.length > maxCandidates || !/^[a-f0-9]{64}$/.test(evaluationScope || '') || !Number.isSafeInteger(maxComputeSteps) || maxComputeSteps < 1 || !Number.isInteger(maxHttpRequests) || maxHttpRequests < 0 || maxHttpRequests > 512 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error('training-iteration-definition')
  for (const plan of candidatePlans) assertTrainingPlan(plan)
  const baseline = candidatePlans[0], projection = (p) => ({ dataset: p.dataset.digest, authority: p.dataset.reviewAuthorityId, objective: p.dataset.objective, backend: p.profile.backend, model: p.profile.model, base: p.baseModelCache?.digest || null, activation: p.defaultActivation, simulated: p.simulated })
  if (candidatePlans.some((p) => evidenceDigest(projection(p)) !== evidenceDigest(projection(baseline))) || new Set(candidatePlans.map((p) => p.digest)).size !== candidatePlans.length) throw new Error('training-iteration-protected-fields')
  const { digest, testDigest, schema, ...def } = suite || {}, frozenSuite = freezeEffectSuite(def)
  if (frozenSuite.digest !== digest || frozenSuite.testDigest !== testDigest) throw new Error('training-iteration-suite-drift')
  const body = { schema: 'cfb.training-iteration/1', id, candidatePlans, suite: frozenSuite, evaluationScope, maxCandidates, maxComputeSteps, maxHttpRequests, timeoutMs, sourceDigest: trainingSourceDigest(), simulated: baseline.simulated }
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
function openJournal(directory, markerPath) {
  privateTrainingPath(directory, { directory: true }); assertSafePath(markerPath)
  const home = path.join(path.resolve(directory), NS), exists = fs.existsSync(markerPath)
  if (exists && (!fs.existsSync(path.join(home, '.head-training-iterations.json')) || !fs.existsSync(path.join(home, 'authority.key')))) throw new Error('training-iteration-restore-required')
  const store = createEvidenceStore({ directory, sessionId: SID, maxTotalBytes: 128 * 1024 * 1024 })
  const projection = (head, value) => {
    const body = { schema: 'cfb.training-iteration-watermark/1', authorityId: store.authorityId, sequence: head.sequence, revision: head.revision,
      consumedTestFamilies: value.consumedTestFamilies, cycles: Object.values(value.cycles).sort((a, b) => a.digest.localeCompare(b.digest)).map((c) => ({ digest: c.digest, status: c.status, reservedCandidates: c.reservedCandidates, computeUpperReserved: c.computeUpperReserved, httpUpperReserved: c.httpUpperReserved, testReserved: c.testReserved, pending: c.pending })) }
    return { ...body, digest: evidenceDigest(body) }
  }
  const read = () => {
    const head = store.readHead('training-iterations')
    if (!head) return { head, value: { schema: 'cfb.training-iteration-registry/1', cycles: {}, consumedTestFamilies: [...CONSUMED_TRAINING_FAMILIES] } }
    const value = store.getJson(head.ref, { kind: 'training-iterations' }), marker = readJson(markerPath), { digest, ...body } = marker
    if (digest !== evidenceDigest(body) || digest !== projection(head, value).digest) throw new Error('training-iteration-watermark-conflict')
    return { head, value }
  }
  const save = (head, value, initial = false) => { const h = store.setHead('training-iterations', store.putJson(value, { kind: 'training-iterations' }), { expectedRevision: head?.revision || null }); syncDirectory(store.directory); writeJson(markerPath, projection(h, value), { exclusive: initial }) }
  if (!store.readHead('training-iterations')) { if (exists) throw new Error('training-iteration-restore-required'); save(null, read().value, true) }
  read()
  const update = (fn) => { const { head, value } = read(), next = fn(value); save(head, next); return immutableJson(next) }
  return { store, read: () => read().value, update }
}
const developmentGate = (effects) => {
  for (const split of ['train', 'selection']) { const rows = effects.filter((e) => e.split === split); if (!rows.length || rows.some((e) => e.sign === '?' || e.sign === '-')) return false; if (split === 'selection' && !rows.some((e) => e.sign === '+')) return false }
  return true
}
export async function runTrainingIteration({ definition, directory, markerPath, propose, train, evaluate, authenticateTraining, authenticateObservation, signal = null }) {
  const { digest, ...body } = definition || {}
  if (body.schema !== 'cfb.training-iteration/1' || evidenceDigest(body) !== digest || body.sourceDigest !== trainingSourceDigest() || freezeTrainingIteration(body).digest !== digest || [propose, train, evaluate, authenticateTraining, authenticateObservation].some((f) => typeof f !== 'function')) throw new Error('training-iteration-authority-or-drift')
  const journal = openJournal(directory, markerPath), leasePath = path.join(directory, '.training-iteration.lock')
  let fd; try { fd = fs.openSync(leasePath, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') throw new Error('training-iteration-busy'); throw e }
  try {
    let cycle = journal.read().cycles[digest]
    if (cycle?.status === 'closed') return { cached: true, ...journal.store.getJson(cycle.reportRef, { kind: 'training-iteration-report' }) }
    if (cycle) throw new Error('training-iteration-unresolved-no-retry')
    const wantedFamilies = [...new Set(body.suite.test.map((f) => f.family))]
    if (wantedFamilies.some((f) => journal.read().consumedTestFamilies.includes(f) || CONSUMED_TRAINING_FAMILIES.some((old) => f.toLowerCase().replace(/[^a-z0-9]/g, '').includes(old.replace(/[^a-z0-9]/g, ''))))) throw new Error('training-iteration-test-already-consumed')
    cycle = { digest, status: 'development', reservedCandidates: 0, computeUpperReserved: 0, httpUpperReserved: 0, testReserved: false, pending: null, candidateDigests: [], feedback: [], selected: null, reportRef: null }
    const saveCycle = (next) => { journal.update((r) => ({ ...r, cycles: { ...r.cycles, [digest]: next } })); cycle = next }
    saveCycle(cycle)
    const baseline = new Map(), incumbent = { candidate: null, plan: null, observations: null }, feedback = [], known = new Set(), evaluated = []
    const call = async (fn, args) => {
      if (signal?.aborted) throw new Error('training-iteration-aborted')
      let rejectAbort; const ctl = new AbortController(), abort = () => { ctl.abort(); rejectAbort?.(new Error('training-iteration-aborted')) }; signal?.addEventListener('abort', abort, { once: true }); let timer
      try { return await Promise.race([Promise.resolve().then(() => fn(...args, ctl.signal)), new Promise((_, reject) => { rejectAbort = reject }), new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('training-iteration-timeout')) }, body.timeoutMs) })]) }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    }
    const observation = async (candidate, fixture) => {
      const result = await call(evaluate, [{ candidate, input: immutableJson(fixture.input) }])
      // 回调不收到split/判据/参考；认证必须同步true。失败/原始正文只留私有仓。
      if (hasTrainingSecrets(result)) return null
      if (authenticateObservation(result, { candidateDigest: candidate?.digest || null, inputDigest: evidenceDigest(fixture.input), evaluationScope: body.evaluationScope }) !== true) return null
      journal.store.putJson({ candidateDigest: candidate?.digest || null, inputDigest: evidenceDigest(fixture.input), result }, { kind: 'iteration-observation' })
      return evaluateEvidencePredicate(fixture.predicate, result.observation)
    }
    for (let slot = 0; slot < body.maxCandidates; slot++) {
      const chosen = await call(propose, [{ stage: 'development-only', allowedCandidateDigests: body.candidatePlans.map((p) => p.digest).filter((d) => !known.has(d)), feedback: immutableJson(feedback), remainingCandidateSlots: body.maxCandidates - slot }])
      if (chosen === null) break
      const plan = body.candidatePlans.find((p) => p.digest === chosen)
      if (!plan || known.has(chosen)) throw new Error('training-iteration-candidate-outside-frozen-space')
      const compute = plan.profile.limits.maxComputeSteps ?? plan.profile.recipe.maxSteps, http = plan.profile.backend === 'remote-finetune' ? plan.profile.limits.maxHttpRequests : 0
      if (cycle.computeUpperReserved + compute > body.maxComputeSteps || cycle.httpUpperReserved + http > body.maxHttpRequests) throw new Error('training-iteration-budget')
      known.add(chosen); saveCycle({ ...cycle, reservedCandidates: cycle.reservedCandidates + 1, computeUpperReserved: cycle.computeUpperReserved + compute, httpUpperReserved: cycle.httpUpperReserved + http,
        candidateDigests: [...cycle.candidateDigests, chosen], pending: { phase: 'train', candidatePlanDigest: chosen } })
      const trained = await call(train, [{ plan }])
      if (!trained?.candidate || authenticateTraining(trained, { planDigest: chosen, datasetDigest: plan.dataset.digest }) !== true || trained.candidate.planDigest !== chosen || trained.candidate.datasetDigest !== plan.dataset.digest || trained.candidate.simulated !== body.simulated) throw new Error('training-iteration-training-unverified')
      const candidate = immutableJson(trained.candidate), effects = [], after = new Map()
      for (const split of ['train', 'selection']) for (const f of body.suite[split]) {
        const key = `${split}|${f.id}`
        if (!baseline.has(key)) baseline.set(key, await observation(null, f))
        const a = await observation(candidate, f), b = baseline.get(key); after.set(key, a)
        effects.push({ split, taskId: f.id, family: f.family, before: b, after: a, sign: sign(b, a) })
      }
      const good = developmentGate(effects), entry = { candidateDigest: candidate.digest, planDigest: chosen, effects, accepted: good, incumbentChanged: false }
      if (good) {
        const compared = incumbent.observations ? effects.map((e) => ({ ...e, before: incumbent.observations.get(`${e.split}|${e.taskId}`), sign: sign(incumbent.observations.get(`${e.split}|${e.taskId}`), e.after) })) : effects
        if (developmentGate(compared)) { incumbent.candidate = candidate; incumbent.plan = plan; incumbent.observations = after; entry.incumbentChanged = true }
      }
      const ref = journal.store.putJson(entry, { kind: 'iteration-development' }); evaluated.push(entry)
      // 只给开发二元符号；无test/失败正文/loss/参考文本。
      feedback.push({ candidatePlanDigest: chosen, selected: entry.incumbentChanged, signs: effects.map((e) => ({ phase: e.split, checkId: e.taskId, sign: e.sign })) })
      saveCycle({ ...cycle, pending: null, feedback: [...cycle.feedback, ref], selected: incumbent.plan?.digest || null })
    }
    const testEffects = []
    if (incumbent.candidate) {
      const families = [...new Set(body.suite.test.map((f) => f.family))], spent = journal.read().consumedTestFamilies
      if (families.some((f) => spent.includes(f))) throw new Error('training-iteration-test-already-consumed')
      // 先锁定选择+持久消耗，再执行任何test；异常也不返还，不供后续propose。
      journal.update((r) => ({ ...r, consumedTestFamilies: [...r.consumedTestFamilies, ...families].sort(), cycles: { ...r.cycles, [digest]: { ...cycle, status: 'final-test', testReserved: true, pending: { phase: 'test', candidatePlanDigest: incumbent.plan.digest } } } }))
      cycle = journal.read().cycles[digest]
      for (const f of body.suite.test) {
        const before = await observation(null, f), after = await observation(incumbent.candidate, f)
        testEffects.push({ split: 'test', taskId: f.id, family: f.family, before, after, sign: sign(before, after) })
      }
    }
    const testPassed = testEffects.length > 0 && !testEffects.some((e) => ['-', '?'].includes(e.sign)) && testEffects.some((e) => e.sign === '+')
    const report = { schema: 'cfb.training-iteration-report/1', definitionDigest: digest, evaluations: evaluated, selectedPlanDigest: incumbent.plan?.digest || null,
      selectedCandidate: incumbent.candidate, testEffects, accepted: !!incumbent.candidate && testPassed, simulated: body.simulated, released: false, productionActivated: false,
      reservedCandidates: cycle.reservedCandidates, computeUpperReserved: cycle.computeUpperReserved, httpUpperReserved: cycle.httpUpperReserved,
      note: '框架只证冻结受控迭代；真实评测/训练/模型收益取决于受保护宿主回调，模拟永不发布。' }
    const reportRef = journal.store.putJson(report, { kind: 'training-iteration-report' }); saveCycle({ ...cycle, status: 'closed', pending: null, reportRef })
    return immutableJson({ cached: false, ...report })
  } catch (e) {
    try { const r = journal.read(), c = r.cycles[digest]; if (c && c.status !== 'closed') journal.update((v) => ({ ...v, cycles: { ...v.cycles, [digest]: { ...c, status: 'unknown', pending: c.pending || { phase: 'iteration', reason: /^training-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'training-iteration-callback-error' } } } })) } catch {}
    throw new Error(/^training-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'training-iteration-callback-error')
  } finally { fs.closeSync(fd); fs.unlinkSync(leasePath) }
}
