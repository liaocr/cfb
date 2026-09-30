// 证据程序的宿主 IO 边界。默认无进程执行、无文件编辑；能力必须由宿主显式开放。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { assertEvidenceContract, canonicalJson, evidenceDigest, evaluateEvidencePredicate, immutableJson, safeRelativePath } from './evidence-program.js'

/** 不跟随链接，不触碰 Git/密钥/根目录。宿主仍须提供独占工作区（不是 OS 沙箱）。 */
export function evidenceFilePath(root, relative, { missing = false } = {}) {
  if (!safeRelativePath(relative)) throw new Error('unsafe-path')
  const base = fs.realpathSync(root), parts = relative.split('/')
  let at = base
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i])
    try {
      const s = fs.lstatSync(at)
      if (s.isSymbolicLink() || (i < parts.length - 1 ? !s.isDirectory() : !s.isFile())) throw new Error('unsafe-file-type')
    } catch (e) { if (missing && e.code === 'ENOENT') return path.join(base, relative); throw e }
  }
  return at
}
export function readEvidenceFile(root, relative, maxBytes = 4 * 1024 * 1024) {
  const file = evidenceFilePath(root, relative)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try { if (fs.fstatSync(fd).size > maxBytes) throw new Error('file-budget'); return fs.readFileSync(fd) }
  finally { fs.closeSync(fd) }
}
export function replaceEvidenceFile(root, action) {
  const file = evidenceFilePath(root, action.path), before = readEvidenceFile(root, action.path), text = before.toString('utf8')
  if (text.split(action.oldText).length !== 2) throw new Error('old-text-not-unique')
  const next = text.replace(action.oldText, action.newText), tmp = file + '.cfb-' + crypto.randomUUID()
  try {
    fs.writeFileSync(tmp, next, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 })
    if (!readEvidenceFile(root, action.path).equals(before)) throw new Error('concurrent-file-change')
    // Revalidate immediately before rename; arbitrary concurrent writers require an external lock.
    evidenceFilePath(root, action.path); fs.renameSync(tmp, file)
    return { changed: true }
  } finally { try { fs.unlinkSync(tmp) } catch { /* already renamed / not created */ } }
}
const stopChild = (child) => { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* exited */ } } }
function localCommand(check, root, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ error: 'aborted' })
    let child, timer, finished = false, error = null, bytes = 0, stdout = '', stderr = ''
    const limit = check.maxOutputBytes || 65536
    const done = (code) => {
      if (finished) return
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      resolve(error ? { error } : { value: { exitCode: code, stdout, stderr } })
    }
    const kill = (why) => { error = why; if (child) stopChild(child) }
    const abort = () => kill('aborted')
    try {
      child = spawn(check.executable, check.args, { cwd: root, shell: false, detached: process.platform !== 'win32',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: root, ...check.env }, stdio: ['ignore', 'pipe', 'pipe'] })
      timer = setTimeout(() => kill('check-timeout'), check.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      const data = (which, chunk) => {
        bytes += chunk.length
        if (bytes > limit) { kill('output-budget'); return }
        if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
      }
      child.stdout.on('data', (c) => data('out', c)); child.stderr.on('data', (c) => data('err', c))
      child.on('error', (e) => { error = 'spawn-error:' + e.code; done(null) }); child.on('close', done)
      if (signal?.aborted) abort()
    } catch (e) { error = 'spawn-error:' + (e.code || e.message); done(null) }
  })
}
async function boundedObservation(fn, check, binding, signal) {
  if (signal?.aborted) return { error: 'aborted' }
  let timer, abort
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(check, immutableJson(binding), signal)).catch(() => ({ error: 'observation-error' })),
      new Promise((r) => {
        timer = setTimeout(() => r({ error: 'observation-timeout' }), check.timeoutMs || 1000)
        abort = () => r({ error: 'aborted' }); signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }),
    ])
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}
/** 私有 HMAC 回执权。哈希只校验内容，签名才认证本验证器产出的回执。 */
export function createEvidenceVerifier({ contract, root, observe, perform, readRevision, readConditions, allowCommands = false, allowEdits = false }) {
  const c = assertEvidenceContract(contract), base = fs.realpathSync(root), secret = crypto.randomBytes(32)
  const sign = (body) => {
    const v = { schema: 'cfb.evidence-receipt/1', ...body }, id = evidenceDigest(v)
    return immutableJson({ ...v, id, signature: crypto.createHmac('sha256', secret).update(id).digest('hex') })
  }
  const authenticate = (receipt) => {
    try {
      const { id, signature, ...body } = receipt
      if (body.schema !== 'cfb.evidence-receipt/1' || evidenceDigest(body) !== id || !/^[0-9a-f]{64}$/.test(signature)) return false
      const expected = crypto.createHmac('sha256', secret).update(id).digest()
      return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))
    } catch { return false }
  }
  const result = (subjectId, binding, status, reason, sample = null, nextRevision = null) => sign({ subjectId, binding,
    status, ok: status === 'pass', reason, observationDigest: sample == null ? null : evidenceDigest(sample), nextRevision })
  const bindingValid = (b) => b && b.contractDigest === c.digest && ['sessionId', 'programId', 'roundId', 'revision', 'stepId', 'phase'].every((k) => typeof b[k] === 'string' && b[k])
  async function check(id, binding, { signal } = {}) {
    if (!bindingValid(binding)) throw new Error('verifier-binding')
    const spec = c.checks.find((x) => x.id === id)
    if (!spec) return result(id, binding, 'unknown', 'unregistered-check')
    const role = binding.phase === 'preconditions' ? 'precondition' : binding.phase === 'diagnostic' ? 'diagnostic' : binding.phase === 'postconditions' ? 'acceptance' : null
    if (spec.role !== role) return result(id, binding, 'unknown', 'wrong-check-role')
    let sample
    try {
      if (spec.kind === 'file') sample = { value: { text: readEvidenceFile(base, spec.path).toString('utf8') }, revision: binding.revision, roundId: binding.roundId, conditions: typeof readConditions === 'function' ? readConditions() : {} }
      else if (spec.kind === 'command') {
        if (!allowCommands) return result(id, binding, 'unknown', 'command-not-authorized')
        sample = await localCommand(spec, base, signal)
        sample = { ...sample, revision: binding.revision, roundId: binding.roundId, conditions: typeof readConditions === 'function' ? readConditions() : {} }
      } else {
        if (typeof observe !== 'function') return result(id, binding, 'unknown', 'no-observer')
        sample = await boundedObservation(observe, spec, binding, signal)
      }
      if (signal?.aborted) return result(id, binding, 'unknown', 'aborted')
      if (!sample || sample.error) return result(id, binding, 'unknown', sample?.error || 'missing-observation')
      if (sample.revision !== binding.revision || sample.roundId !== binding.roundId || (typeof readRevision === 'function' && readRevision() !== binding.revision)) return result(id, binding, 'unknown', 'stale-observation', sample)
      if (Object.entries(spec.conditions).some(([k, v]) => !Object.hasOwn(sample.conditions || {}, k) || canonicalJson(sample.conditions[k]) !== canonicalJson(v))) return result(id, binding, 'unknown', 'condition-mismatch', sample)
      const ok = evaluateEvidencePredicate(spec.predicate, sample.value)
      return result(id, binding, ok === true ? 'pass' : ok === false ? 'fail' : 'unknown', ok === null ? 'missing-field' : ok ? 'verified' : 'predicate-failed', sample)
    } catch { return result(id, binding, 'unknown', 'check-error') }
  }
  /** 同步动作：不允许晚到的异步写入在已经回滚后再次污染工作区。 */
  function action(id, binding) {
    if (!bindingValid(binding) || binding.phase !== 'action') throw new Error('action-binding')
    const spec = c.actions.find((x) => x.id === id)
    if (!spec) return result(id, binding, 'unknown', 'unregistered-action')
    try {
      if (typeof readRevision === 'function' && readRevision() !== binding.revision) return result(id, binding, 'unknown', 'stale-action')
      let output = { observed: true }
      if (spec.type !== 'observe') {
        if (!allowEdits) return result(id, binding, 'unknown', 'edit-not-authorized')
        output = typeof perform === 'function' ? perform(spec) : replaceEvidenceFile(base, spec)
        if (!output || typeof output.then === 'function' || output.changed !== true) return result(id, binding, 'unknown', 'action-not-confirmed')
      }
      const next = typeof readRevision === 'function' ? readRevision() : binding.revision
      return result(id, binding, 'pass', 'action-applied', output, next)
    } catch { return result(id, binding, 'unknown', 'action-error') }
  }
  return Object.freeze({ contract: c, check, action, authenticate })
}
