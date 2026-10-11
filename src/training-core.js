// 训练数据/切分/发布的纯内核；不训练、不联网、不授予工具或生产模型权限。
import { evidenceDigest, immutableJson } from './evidence-program.js'
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/
const HEX = /^[a-f0-9]{64}$/
export const CONSUMED_TRAINING_FAMILIES = Object.freeze(['chunked-header', 'delayed-headers'])
export const TRAINING_SCHEMA = 'cfb.training-example/1'
export const hasTrainingSecrets = (v) => /(?:\bsk-[A-Za-z0-9_-]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b)/.test(typeof v === 'string' ? v : JSON.stringify(v))
export function normalizeTrainingExample(def) {
  if (hasTrainingSecrets(def)) throw new Error('training-secret-material')
  if (!def || def.schema !== TRAINING_SCHEMA || Object.keys(def).some((k) => !['schema', 'uid', 'family', 'lineage', 'objective', 'source', 'messages', 'target', 'chosen', 'rejected', 'digest', 'reviewRef'].includes(k)) || ['uid', 'family', 'lineage'].some((k) => !ID.test(def[k] || '')) || !['sft', 'preference'].includes(def.objective)) throw new Error('training-example-schema')
  if (def.reviewRef !== undefined && typeof def.reviewRef !== 'string') throw new Error('training-review-reference')
  const source = def.source
  if (!source || !['operator', 'historical', 'fixture'].includes(source.kind) || typeof source.id !== 'string' || !source.id || !HEX.test(source.sha256 || '') || typeof source.trainingAllowed !== 'boolean' || typeof source.license !== 'string' || Object.keys(source).some((k) => !['kind', 'id', 'sha256', 'trainingAllowed', 'license'].includes(k))) throw new Error('training-source-schema')
  if (!Array.isArray(def.messages) || !def.messages.length || def.messages.length > 32 || def.messages.some((m) => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || Object.keys(m).some((k) => !['role', 'content'].includes(k))) || def.messages.at(-1).role !== 'user') throw new Error('training-messages')
  const labels = def.objective === 'sft' ? ['target'] : ['chosen', 'rejected']
  if (labels.some((k) => typeof def[k] !== 'string' || !def[k]) || def.objective === 'preference' && def.chosen === def.rejected || def.objective === 'sft' && (def.chosen !== undefined || def.rejected !== undefined) || def.objective === 'preference' && def.target !== undefined) throw new Error('training-target')
  const body = { schema: TRAINING_SCHEMA, uid: def.uid, family: def.family, lineage: def.lineage, objective: def.objective, source, messages: def.messages, ...Object.fromEntries(labels.map((k) => [k, def[k]])) }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1024 * 1024) throw new Error('training-example-budget')
  if (hasTrainingSecrets(body)) throw new Error('training-secret-material')
  const digest = evidenceDigest(body)
  if (def.digest && def.digest !== digest) throw new Error('training-example-drift')
  return immutableJson({ ...body, digest, ...(def.reviewRef ? { reviewRef: def.reviewRef } : {}) })
}
const normalized = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim()
export function trainingFingerprints(record) {
  const row = normalizeTrainingExample(record)
  return immutableJson({ family: row.family, lineage: row.lineage,
    input: evidenceDigest(row.messages.map((m) => ({ role: m.role, content: normalized(m.content) }))),
    targets: (row.objective === 'sft' ? [row.target] : [row.chosen, row.rejected]).map((s) => evidenceDigest(normalized(s))) })
}
/** family/lineage/重复输入与目标的连通分量整体切分；不改变文本本身。 */
export function splitTrainingGroups(records, options = {}) {
  if (!Array.isArray(records)) throw new Error('training-split-budget')
  return splitTrainingFingerprints(records.map((r) => { const x = normalizeTrainingExample(r); return { digest: x.digest, fingerprints: trainingFingerprints(x) } }), options)
}
export function splitTrainingFingerprints(rows, { seed = 'cfb-training-v1' } = {}) {
  if (!Array.isArray(rows) || rows.length > 100000 || typeof seed !== 'string' || !seed || rows.some((r) => !HEX.test(r.digest || '') || !r.fingerprints)) throw new Error('training-split-budget')
  const parent = rows.map((_, i) => i), links = new Map()
  const root = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b) }
  rows.forEach((r, i) => {
    const f = r.fingerprints, keys = ['family:' + f.family, 'lineage:' + f.lineage, 'input:' + f.input, ...f.targets.map((t) => 'target:' + t)]
    for (const k of keys) { if (links.has(k)) join(i, links.get(k)); else links.set(k, i) }
  })
  const components = new Map(); rows.forEach((r, i) => { const k = root(i); if (!components.has(k)) components.set(k, []); components.get(k).push(r) })
  const groups = [...components.values()].map((g) => ({ id: evidenceDigest(g.map((r) => r.digest).sort()), rows: g })).sort((a, b) => evidenceDigest({ seed, id: a.id }).localeCompare(evidenceDigest({ seed, id: b.id })))
  if (groups.length < 3) throw new Error('training-insufficient-independent-groups')
  const testCount = Math.max(1, Math.floor(groups.length * 0.15)), selectionCount = Math.max(1, Math.floor(groups.length * 0.15))
  const assignment = {}, counts = { train: 0, selection: 0, test: 0 }
  groups.forEach((g, i) => { const split = i < testCount ? 'test' : i < testCount + selectionCount ? 'selection' : 'train'; for (const r of g.rows) { assignment[r.digest] = split; counts[split]++ } })
  return immutableJson({ schema: 'cfb.training-split/1', seed, groups: groups.length, counts, assignment,
    groupDigest: evidenceDigest(groups.map((g) => ({ id: g.id, rows: g.rows.map((r) => r.digest).sort(), split: assignment[g.rows[0].digest] }))) })
}
export function trainingExportRow(record) {
  const r = normalizeTrainingExample(record)
  // 模型可见只有完整输入与目标；family/split/审核/判据/参考均不上传。
  return r.objective === 'sft' ? { messages: [...r.messages, { role: 'assistant', content: r.target }] } : {
    prompt: r.messages, chosen: [{ role: 'assistant', content: r.chosen }], rejected: [{ role: 'assistant', content: r.rejected }],
  }
}
export function freezeTrainingEvaluation(def) {
  if (!def || !ID.test(def.id || '') || !/^[a-f0-9]{64}$/.test(def.evaluatorDigest || '') || !Array.isArray(def.items) || !def.items.length || def.items.length > 10000) throw new Error('training-evaluation-suite')
  const items = def.items.map((x) => ({ split: x.split, taskId: x.taskId, family: x.family, criterion: x.criterion })), keys = new Set(), families = new Map()
  for (const x of items) {
    const k = `${x.split}|${x.taskId}|${x.criterion}`
    if (!['train', 'selection', 'test'].includes(x.split) || ['taskId', 'family', 'criterion'].some((f) => !ID.test(x[f] || '')) || keys.has(k) || families.has(x.family) && families.get(x.family) !== x.split) throw new Error('training-evaluation-leakage-or-shape')
    keys.add(k); families.set(x.family, x.split)
  }
  if (['train', 'selection', 'test'].some((s) => !items.some((x) => x.split === s))) throw new Error('training-evaluation-missing-split')
  const body = { schema: 'cfb.training-evaluation/1', id: def.id, evaluatorDigest: def.evaluatorDigest, items }
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
/** loss仅用于训练；真实发布只接受逐项客观无负/unknown、selection/test严格提升。 */
export function gateTrainingRelease(effects, { simulated = false, suite = null } = {}) {
  if (simulated) return { ok: false, reason: 'training-simulation-not-release' }
  if (!Array.isArray(effects) || !effects.length || effects.length > 10000) return { ok: false, reason: 'training-release-evidence-missing' }
  if (!suite) return { ok: false, reason: 'training-release-frozen-suite-required' }
  const { digest, ...suiteBody } = suite
  if (evidenceDigest(suiteBody) !== digest || freezeTrainingEvaluation(suiteBody).digest !== digest || suite.items.length !== effects.length) return { ok: false, reason: 'training-release-suite-drift-or-omission' }
  for (const x of suite.items) if (!effects.some((e) => ['split', 'taskId', 'family', 'criterion'].every((k) => e[k] === x[k]))) return { ok: false, reason: 'training-release-suite-omission' }
  const seen = new Set(), families = new Map()
  for (const e of effects) {
    if (CONSUMED_TRAINING_FAMILIES.some((f) => String(e.family || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(f.replace(/[^a-z0-9]/g, '')))) return { ok: false, reason: 'training-release-consumed-family' }
    const key = `${e.split}|${e.taskId}|${e.criterion}`
    if (!['train', 'selection', 'test'].includes(e.split) || !ID.test(e.taskId || '') || !ID.test(e.family || '') || !ID.test(e.criterion || '') || seen.has(key)) return { ok: false, reason: 'training-release-shape' }
    seen.add(key)
    if (families.has(e.family) && families.get(e.family) !== e.split) return { ok: false, reason: 'training-release-leakage' }
    families.set(e.family, e.split)
    if (typeof e.before !== 'boolean' || typeof e.after !== 'boolean') return { ok: false, reason: 'training-release-unknown' }
    if (e.before && !e.after) return { ok: false, reason: 'training-release-regression' }
  }
  for (const split of ['train', 'selection', 'test']) {
    const rows = effects.filter((e) => e.split === split)
    if (!rows.length) return { ok: false, reason: 'training-release-missing-' + split }
    if (split !== 'train' && !rows.some((e) => !e.before && e.after)) return { ok: false, reason: 'training-release-tie-' + split }
  }
  return { ok: true, reason: 'training-release-strict-objective-improvement' }
}
