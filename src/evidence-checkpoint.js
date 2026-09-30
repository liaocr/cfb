// 宿主/文件联合检查点：显式管理路径，乐观冲突检查，Git 与仓库根目录永不恢复/删除。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalJson, evidenceDigest, immutableJson, safeRelativePath } from './evidence-program.js'
import { evidenceFilePath, readEvidenceFile, replaceEvidenceFile } from './evidence-host.js'

/** JSON 状态包括上下文；进程/网络/计时器只能由有能力的宿主提供自定义适配器，不假装可恢复。 */
export function createFileStateAdapter({ root, paths, readState = () => ({}), writeState = () => {}, afterAction, readConditions = () => ({}), maxSnapshotBytes = 8 * 1024 * 1024 }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 64 || paths.some((p) => !safeRelativePath(p)) || new Set(paths).size !== paths.length ||
    [readState, writeState, readConditions].some((f) => typeof f !== 'function' || f.constructor.name === 'AsyncFunction') ||
    afterAction !== undefined && (typeof afterAction !== 'function' || afterAction.constructor.name === 'AsyncFunction') ||
    !Number.isInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 16 * 1024 * 1024) throw new Error('adapter-schema')
  const base = fs.realpathSync(root)
  if (base === path.parse(base).root || base.split(path.sep).some((x) => ['.git', '.secrets'].includes(x))) throw new Error('unsafe-adapter-root')
  const managed = [...paths].sort(), scopeDigest = evidenceDigest({ root: base, paths: managed })
  const fileSnapshot = (p) => {
    try {
      const file = evidenceFilePath(base, p), bytes = readEvidenceFile(base, p, maxSnapshotBytes)
      return { path: p, exists: true, mode: fs.statSync(file).mode & 0o777, data: bytes.toString('base64') }
    } catch (e) { if (e.code === 'ENOENT') return { path: p, exists: false, mode: 0, data: '' }; throw e }
  }
  const capture = () => {
    const snapshot = { schema: 'cfb.host-snapshot/1', scopeDigest, state: JSON.parse(canonicalJson(readState())), conditions: JSON.parse(canonicalJson(readConditions())), files: managed.map(fileSnapshot) }
    if (Buffer.byteLength(canonicalJson(snapshot)) > maxSnapshotBytes) throw new Error('snapshot-budget')
    return immutableJson(snapshot)
  }
  const validate = (s) => {
    if (s?.schema !== 'cfb.host-snapshot/1' || s.scopeDigest !== scopeDigest || !Array.isArray(s.files) || s.files.length !== managed.length ||
      s.files.some((f, i) => f.path !== managed[i] || typeof f.exists !== 'boolean' || !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o777 || typeof f.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data) || !f.exists && f.data !== '')) throw new Error('snapshot-scope')
    if (Buffer.byteLength(canonicalJson(s)) > maxSnapshotBytes) throw new Error('snapshot-budget')
  }
  const parentDirs = (p) => {
    let at = base
    for (const part of p.split('/').slice(0, -1)) {
      at = path.join(at, part)
      try { fs.mkdirSync(at, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
      const s = fs.lstatSync(at); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('restore-symlink')
    }
  }
  const apply = (snapshot) => {
    const staging = []
    try {
      // 全部目标先校验/暂存，之后才改变正式文件。
      for (const f of snapshot.files) {
        evidenceFilePath(base, f.path, { missing: true })
        if (f.exists) {
          parentDirs(f.path)
          const tmp = path.join(path.dirname(path.join(base, f.path)), '.cfb-restore-' + crypto.randomUUID())
          const fd = fs.openSync(tmp, 'wx', f.mode)
          // 一旦成功创建即纳入 finally；写入/chmod/fsync/关闭中途失败也不留下原状态副本。
          staging.push({ tmp, file: path.join(base, f.path) })
          try { fs.writeFileSync(fd, Buffer.from(f.data, 'base64')); fs.fchmodSync(fd, f.mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        }
      }
      for (const { tmp, file } of staging) fs.renameSync(tmp, file)
      for (const f of snapshot.files) if (!f.exists) {
        const file = evidenceFilePath(base, f.path, { missing: true })
        try { fs.unlinkSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
      }
      const result = writeState(JSON.parse(canonicalJson(snapshot.state)))
      if (result && typeof result.then === 'function') throw new Error('async-restore-forbidden')
    } finally { for (const { tmp } of staging) { try { fs.unlinkSync(tmp) } catch { /* renamed / absent */ } } }
  }
  const revision = () => evidenceDigest(capture())
  const restore = (snapshot, { expectedRevision } = {}) => {
    validate(snapshot)
    const current = capture()
    if (typeof expectedRevision !== 'string' || evidenceDigest(current) !== expectedRevision) throw new Error('rollback-conflict')
    try {
      apply(snapshot)
      if (evidenceDigest(capture()) !== evidenceDigest(snapshot)) throw new Error('restore-mismatch')
    } catch (e) {
      try {
        apply(current)
        if (evidenceDigest(capture()) !== evidenceDigest(current)) throw new Error('restore-backout-mismatch')
      } catch { throw new Error('restore-failed-unknown-state', { cause: e }) }
      throw new Error('restore-failed-current-preserved', { cause: e })
    }
    return immutableJson({ restored: true, revision: revision() })
  }
  const perform = (action) => {
    if (!managed.includes(action.path) || action.type !== 'replace') throw new Error('action-outside-adapter')
    const r = replaceEvidenceFile(base, action)
    if (afterAction) { const v = afterAction(action); if (v && typeof v.then === 'function') throw new Error('async-action-forbidden') }
    return r
  }
  return Object.freeze({ root: base, paths: immutableJson(managed), scopeDigest, capture, revision, restore, perform,
    readConditions: () => immutableJson(readConditions()) })
}
export function createEvidenceCheckpoints({ store, adapter, sessionId, contractDigest, authenticate }) {
  if (store.sessionId !== sessionId || typeof contractDigest !== 'string' || !contractDigest || typeof authenticate !== 'function') throw new Error('checkpoint-schema')
  const take = ({ kind = 'before-round', artifactRef = null, program = null, state = null, receipts = [] } = {}) => {
    if (!['before-round', 'preconditions', 'verified-step'].includes(kind)) throw new Error('checkpoint-kind')
    const snapshot = adapter.capture()
    if (kind !== 'before-round') {
      const step = kind === 'preconditions' ? program?.steps[state?.cursor] : program?.steps[state?.cursor - 1]
      const required = kind === 'preconditions' ? step?.preconditions : step?.expectedObservations.map((x) => x.checkId)
      const phase = kind === 'preconditions' ? 'preconditions' : 'postconditions'
      if (kind === 'preconditions' ? state?.phase !== 'action' || state.status !== 'ready' : !state?.cursor || !['ready', 'verified'].includes(state.status) || state.verifiedSteps?.at(-1) !== step?.id) throw new Error('checkpoint-unverified')
      if (!program || program.sessionId !== sessionId || program.contractDigest !== contractDigest || state?.programId !== program.id ||
        state.revision !== evidenceDigest(snapshot) || !required || receipts.length !== required.length || new Set(receipts.map((r) => r.subjectId)).size !== required.length ||
        receipts.some((r) => !authenticate(r) || !r.ok || r.status !== 'pass' || !required.includes(r.subjectId) || r.binding.sessionId !== sessionId ||
          r.binding.programId !== program.id || r.binding.contractDigest !== contractDigest || r.binding.revision !== state.revision || r.binding.roundId !== state.roundId || r.binding.stepId !== step.id || r.binding.phase !== phase)) throw new Error('checkpoint-unverified')
    }
    const record = { schema: 'cfb.evidence-checkpoint/1', sessionId, contractDigest, kind, artifactRef,
      programId: program?.id || null, state, receiptIds: receipts.map((r) => r.id), snapshot }
    return immutableJson({ handle: store.putJson(record, { kind: 'checkpoint' }), revision: evidenceDigest(snapshot), kind, artifactRef })
  }
  const restore = (handle, expectedRevision) => {
    const record = store.getJson(handle, { kind: 'checkpoint' })
    if (record.schema !== 'cfb.evidence-checkpoint/1' || record.sessionId !== sessionId || record.contractDigest !== contractDigest) throw new Error('checkpoint-session-contract')
    const result = adapter.restore(record.snapshot, { expectedRevision })
    return immutableJson({ ...result, artifactRef: record.artifactRef, programId: record.programId, state: record.state, kind: record.kind })
  }
  return Object.freeze({ take, restore })
}
