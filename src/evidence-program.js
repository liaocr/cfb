// 证据程序的纯内核：JSON/谓词/冻结契约/类型化步骤/步骤闸。无 IO、无模型调用。
import crypto from 'node:crypto'

export const EVIDENCE_SCHEMA = 'cfb.evidence-program/1'
export const CONTRACT_SCHEMA = 'cfb.evidence-contract/1'
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
export function canonicalJson(value) {
  const seen = new Set()
  const walk = (v, depth) => {
    if (depth > 32) throw new Error('json-depth')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && !plain(v))) throw new Error('not-json')
    seen.add(v)
    let out
    if (Array.isArray(v)) out = '[' + v.map((x) => walk(x, depth + 1)).join(',') + ']'
    else {
      const keys = Object.keys(v).sort()
      if (keys.some((k) => BAD_KEYS.has(k))) throw new Error('unsafe-key')
      out = '{' + keys.map((k) => JSON.stringify(k) + ':' + walk(v[k], depth + 1)).join(',') + '}'
    }
    seen.delete(v); return out
  }
  return walk(value, 0)
}
export const evidenceDigest = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
export function immutableJson(value) {
  const v = JSON.parse(canonicalJson(value))
  const freeze = (x) => { if (x && typeof x === 'object') { for (const y of Object.values(x)) freeze(y); Object.freeze(x) } return x }
  return freeze(v)
}
export function safeRelativePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 500 && !/[\\\x00-\x1f]/.test(p) && !p.startsWith('/') && !p.includes(':') &&
    p.split('/').every((x) => x && x !== '.' && x !== '..' && x !== '.git' && x !== '.secrets' && x !== '.cfb-runtime' && !/^(?:\.credentials|\.env|keys\.env)(?:$|[.])/i.test(x))
}
const get = (value, field) => {
  if (field === '') return value
  if (typeof field !== 'string' || field.split('.').some((k) => BAD_KEYS.has(k) || !k)) return undefined
  let v = value
  for (const k of field.split('.')) { if (v == null || !Object.hasOwn(v, k)) return undefined; v = v[k] }
  return v
}
function validatePredicate(p, depth = 0) {
  if (!plain(p) || depth > 8) throw new Error('predicate-schema')
  if (p.op === 'and' || p.op === 'or') {
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 32) throw new Error('predicate-items')
    p.items.forEach((x) => validatePredicate(x, depth + 1)); return
  }
  if (p.op === 'not') { validatePredicate(p.item, depth + 1); return }
  if (!['equals', 'includes', 'absent', 'at-least', 'at-most', 'before'].includes(p.op)) throw new Error('predicate-op')
  if (typeof p.field !== 'string' || p.field.split('.').some((k) => BAD_KEYS.has(k))) throw new Error('predicate-field')
  if (p.op === 'before') { if (typeof p.other !== 'string' || p.other.split('.').some((k) => BAD_KEYS.has(k))) throw new Error('predicate-other') }
  else if (!Object.hasOwn(p, 'value') || (['includes', 'absent'].includes(p.op) && (typeof p.value !== 'string' || !p.value)) ||
    (['at-least', 'at-most'].includes(p.op) && !Number.isFinite(p.value))) throw new Error('predicate-value')
}
/** 三值逻辑：null 是缺失/不可判，不得用 not 把 unknown 变成 true。 */
export function evaluateEvidencePredicate(predicate, value) {
  validatePredicate(predicate)
  const evalP = (p) => {
    if (p.op === 'and' || p.op === 'or') {
      const a = p.items.map(evalP)
      if (p.op === 'and') return a.includes(false) ? false : a.includes(null) ? null : true
      return a.includes(true) ? true : a.includes(null) ? null : false
    }
    if (p.op === 'not') { const r = evalP(p.item); return r === null ? null : !r }
    const x = get(value, p.field)
    if (x === undefined) return null
    switch (p.op) {
      case 'equals': return evidenceDigest(x) === evidenceDigest(p.value)
      case 'includes': return typeof x === 'string' ? x.includes(p.value) : null
      case 'absent': return typeof x === 'string' ? !x.includes(p.value) : null
      case 'at-least': return Number.isFinite(x) ? x >= p.value : null
      case 'at-most': return Number.isFinite(x) ? x <= p.value : null
      case 'before': { const y = get(value, p.other); return Number.isFinite(x) && Number.isFinite(y) ? x < y : null }
    }
  }
  return evalP(predicate)
}
const uniqueIds = (rows, label) => {
  if (!Array.isArray(rows) || rows.length > 128) throw new Error(label + '-schema')
  const ids = rows.map((r) => r?.id)
  if (ids.some((id) => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length) throw new Error(label + '-id')
}
/** 仅宿主调用；生成器没有改判据/动作能力。digest 是防漂移哈希，不伪称数字签名。 */
export function freezeEvidenceContract(def) {
  const body = JSON.parse(canonicalJson(def))
  if (!plain(body) || Object.hasOwn(body, 'schema') || Object.hasOwn(body, 'digest') || typeof body.task !== 'string' || !body.task || typeof body.version !== 'string' || !body.version) throw new Error('contract-scope')
  body.actions ??= []
  uniqueIds(body.checks, 'checks'); uniqueIds(body.actions, 'actions')
  for (const c of body.checks) {
    if (!['file', 'observation', 'command'].includes(c.kind) || !['precondition', 'acceptance', 'diagnostic'].includes(c.role)) throw new Error('check-kind-role')
    validatePredicate(c.predicate)
    c.conditions ??= {}; if (!plain(c.conditions)) throw new Error('check-conditions'); canonicalJson(c.conditions)
    if (c.kind === 'file' && !safeRelativePath(c.path)) throw new Error('check-path')
    if (c.kind === 'command') {
      if (c.localOnly !== true || typeof c.executable !== 'string' || !c.executable.startsWith('/') || !Array.isArray(c.args) ||
        c.args.some((a) => typeof a !== 'string' || a.includes('\0')) || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > 30000) throw new Error('command-capability')
      if (c.maxOutputBytes !== undefined && (!Number.isInteger(c.maxOutputBytes) || c.maxOutputBytes < 1 || c.maxOutputBytes > 1048576)) throw new Error('command-output-budget')
      if (c.env && (!plain(c.env) || Object.entries(c.env).some(([k, v]) => !/^[A-Za-z_][\w]*$/.test(k) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k) || typeof v !== 'string'))) throw new Error('command-env')
    }
  }
  body.protectedFiles ??= []
  if (!Array.isArray(body.protectedFiles) || body.protectedFiles.length > 64 || body.protectedFiles.some((f) => !safeRelativePath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256)) || new Set(body.protectedFiles.map((f) => f.path)).size !== body.protectedFiles.length) throw new Error('protected-files-schema')
  const checkMap = new Map(body.checks.map((c) => [c.id, c]))
  for (const a of body.actions) {
    if (!['replace', 'observe'].includes(a.type)) throw new Error('action-kind')
    if (a.type === 'replace' && (body.protectedFiles.some((f) => f.path === a.path) || !safeRelativePath(a.path) || typeof a.oldText !== 'string' || !a.oldText || typeof a.newText !== 'string' || a.oldText === a.newText)) throw new Error('action-replace')
    if (!Array.isArray(a.preconditions) || !Array.isArray(a.checks) || new Set(a.preconditions).size !== a.preconditions.length || new Set(a.checks).size !== a.checks.length || !a.checks.length || (a.type === 'replace' && !a.preconditions.length)) throw new Error('action-checks')
    for (const id of a.preconditions) if (checkMap.get(id)?.role !== 'precondition') throw new Error('action-precondition')
    for (const id of a.checks) if (checkMap.get(id)?.role !== 'acceptance') throw new Error('action-acceptance')
  }
  return immutableJson({ schema: CONTRACT_SCHEMA, ...body, digest: evidenceDigest(body) })
}
export function assertEvidenceContract(contract) {
  const { schema, digest, ...body } = contract || {}
  if (schema !== CONTRACT_SCHEMA || evidenceDigest(body) !== digest) throw new Error('contract-drift')
  const checked = freezeEvidenceContract(body)
  if (checked.digest !== digest) throw new Error('contract-drift')
  return checked
}
/** 类型化步骤的检查命令与期望谓词全部从冻结契约派生，散文不参与通过判定。 */
export function createEvidenceProgram(explanation, { contract, actionIds, sessionId }) {
  const c = assertEvidenceContract(contract)
  if (typeof explanation !== 'string' || typeof sessionId !== 'string' || !sessionId || !Array.isArray(actionIds) || !actionIds.length || actionIds.length > 32) throw new Error('program-schema')
  if (new Set(actionIds).size !== actionIds.length) throw new Error('duplicate-action')
  const checks = new Map(c.checks.map((x) => [x.id, x]))
  const steps = actionIds.map((id, i) => {
    const a = c.actions.find((x) => x.id === id)
    if (!a) throw new Error('unapproved-action:' + id)
    return { id: 'step-' + (i + 1), preconditions: a.preconditions, action: a,
      expectedObservations: a.checks.map((id) => ({ checkId: id, predicate: checks.get(id).predicate })),
      checkCommand: a.checks.map((id) => { const x = checks.get(id); return { checkId: id, kind: x.kind, command: x.label || id } }) }
  })
  const body = { schema: EVIDENCE_SCHEMA, sessionId, contractDigest: c.digest, explanation, steps }
  return immutableJson({ ...body, id: evidenceDigest(body) })
}
export function assertEvidenceProgram(program, contract) {
  const { id, ...body } = program || {}
  if (body.schema !== EVIDENCE_SCHEMA || evidenceDigest(body) !== id) throw new Error('program-drift')
  const expected = createEvidenceProgram(body.explanation, { contract, sessionId: body.sessionId, actionIds: body.steps.map((s) => s.action.id) })
  if (expected.id !== id) throw new Error('program-contract-mismatch')
  return expected
}

/** 旧稿只生成提议；未知路径、判据和命令保留 null，不猜、不运行。 */
export function parseEvidenceProposal(text, { calls = [], ctx = '' } = {}) {
  const explanation = typeof text === 'string' ? text : ''
  const steps = []
  const toolCalls = []
  for (const c of calls) { try { const args = typeof c.args === 'string' ? JSON.parse(c.args) : c.args; if (plain(args)) toolCalls.push({ name: c.name, args }) } catch {} }
  for (const m of explanation.matchAll(/\[tool_call\s+([\w.-]+)\]\s*(\{[^\n]*\})/g)) { try { toolCalls.push({ name: m[1], args: JSON.parse(m[2]) }) } catch {} }
  const commands = toolCalls.filter((c) => /(?:^|\.)bash$/.test(c.name) && typeof c.args.command === 'string').map((c) => c.args.command)
  const verify = explanation.match(/验收(?:是|命令(?:是|为)?)[^`\n。]{0,100}`([^`\n]+)`/)
  const command = verify?.[1] || commands[0] || null
  const expectation = explanation.match(/(?:预期|验收先写下)[：:]?[^。\n]{1,450}/)?.[0] || null
  const triples = [...explanation.matchAll(/old_text\s*(?:是|为|[:：])\s*`([^`]+)`[\s\S]{0,240}?new_text\s*(?:是|为|[:：])\s*`([^`]+)`/g)]
  // 当前落定句之后优先，避免把延续段里的上一轮编辑当下一步。
  const start = explanation.lastIndexOf('所以下一步工具调用是')
  const chosen = triples.find((m) => start >= 0 && m.index >= start) || triples[0]
  if (chosen) {
    const before = explanation.slice(Math.max(0, chosen.index - 250), chosen.index)
    const paths = [...before.matchAll(/(?:edit_file\s+|改\s+)([\w./-]+\.(?:[cm]?js|tsx?|json|ya?ml|py))/g)]
    const fromCall = toolCalls.find((c) => c.args.old_text === chosen[1] && c.args.new_text === chosen[2])
    const fromCtx = [...String(ctx).matchAll(/(?:edit_file\s+)([\w./-]+)[（(]old_text/g)].pop()
    const file = paths.at(-1)?.[1] || fromCall?.args.path || fromCtx?.[1] || null
    steps.push({ id: 'proposal-1', preconditions: [{ type: 'file-contains', path: file, text: chosen[1] }],
      action: { type: 'replace', path: file, oldText: chosen[1], newText: chosen[2] }, expectedObservation: expectation, checkCommand: command })
  } else {
    for (const c of toolCalls) {
      if (/edit_file$/.test(c.name) && typeof c.args.path === 'string' && typeof c.args.old_text === 'string' && typeof c.args.new_text === 'string') {
        steps.push({ id: 'proposal-' + (steps.length + 1), preconditions: [{ type: 'file-contains', path: c.args.path, text: c.args.old_text }],
          action: { type: 'replace', path: c.args.path, oldText: c.args.old_text, newText: c.args.new_text }, expectedObservation: expectation, checkCommand: command })
      }
    }
  }
  if (!steps.length && command) steps.push({ id: 'proposal-1', preconditions: [], action: { type: 'observe' }, expectedObservation: expectation, checkCommand: command })
  return immutableJson({ schema: 'cfb.evidence-proposal/1', explanation, steps, parsed: steps.length > 0, authorized: false })
}
export function bindEvidenceProposal(proposal, contract, sessionId) {
  const c = assertEvidenceContract(contract), ids = []
  for (const s of proposal.steps || []) {
    const a = c.actions.find((a) => a.type === s.action.type && (a.type === 'observe' ||
      a.path === s.action.path && a.oldText === s.action.oldText && a.newText === s.action.newText) &&
      a.checks.some((id) => c.checks.find((x) => x.id === id)?.label === s.checkCommand))
    if (!a || ids.includes(a.id)) return { ok: false, reason: 'unapproved-proposal' }
    ids.push(a.id)
  }
  if (!ids.length) return { ok: false, reason: 'no-steps' }
  return { ok: true, program: createEvidenceProgram(proposal.explanation, { contract: c, actionIds: ids, sessionId }) }
}
export function initialEvidenceState(program, { roundId, revision }) {
  if (typeof roundId !== 'string' || !roundId || typeof revision !== 'string' || !revision) throw new Error('state-binding')
  return immutableJson({ programId: program.id, contractDigest: program.contractDigest, sessionId: program.sessionId, roundId, revision,
    cursor: 0, phase: 'preconditions', status: 'ready', verifiedSteps: [], receiptIds: [] })
}
export function evidenceBinding(program, state) {
  return { sessionId: program.sessionId, programId: program.id, contractDigest: program.contractDigest,
    roundId: state.roundId, revision: state.revision, stepId: program.steps[state.cursor]?.id || '', phase: state.phase }
}
/** 唯一推进入口。authenticate 必须由宿主验证器提供，生成器/旧记录没有回执签名权。 */
export function advanceEvidenceState(program, state, receipts, authenticate) {
  const block = (reason) => immutableJson({ ...state, status: 'blocked', reason })
  if (state.status !== 'ready') return block('not-ready')
  if (state.programId !== program.id || state.contractDigest !== program.contractDigest || state.sessionId !== program.sessionId) return block('state-program-mismatch')
  const step = program.steps[state.cursor]
  if (!step) return block('missing-step')
  const required = state.phase === 'preconditions' ? step.preconditions : state.phase === 'action' ? [step.action.id] : state.phase === 'postconditions' ? step.expectedObservations.map((c) => c.checkId) : null
  if (!required || !Array.isArray(receipts) || receipts.length !== required.length) return block('receipt-count')
  const binding = evidenceBinding(program, state), seen = new Set()
  for (const r of receipts) {
    if (!r || seen.has(r.subjectId) || !required.includes(r.subjectId)) return block('receipt-subject')
    seen.add(r.subjectId)
    if (typeof authenticate !== 'function' || authenticate(r) !== true) return block('receipt-unauthenticated')
    if (Object.entries(binding).some(([k, v]) => r.binding?.[k] !== v)) return block('receipt-stale')
    if (r.status !== 'pass' || r.ok !== true) return block(r.reason || 'check-not-passed')
  }
  const next = { ...state, receiptIds: [...state.receiptIds, ...receipts.map((r) => r.id)] }
  if (state.phase === 'preconditions') next.phase = 'action'
  else if (state.phase === 'action') {
    const revision = receipts[0]?.nextRevision
    if (typeof revision !== 'string' || !revision) return block('missing-revision')
    next.revision = revision; next.phase = 'postconditions'
  } else {
    next.verifiedSteps = [...state.verifiedSteps, step.id]; next.cursor++
    next.phase = 'preconditions'; next.status = next.cursor === program.steps.length ? 'verified' : 'ready'
  }
  return immutableJson(next)
}
