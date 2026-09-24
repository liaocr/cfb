/**
 * ★★ 结构化状态快照持久化（2026-09-22，用户批准的"快照持久化"路线）★★
 *
 * 为什么需要这个模块
 * ─────────────────
 * 真机已证实的死锁（trace + 会话日志逐条核对）：
 *   ① 编译成功产出的**结构化 entries 只存在于内存**（lateMemory / checkpoint 通路）；
 *   ② 宿主压缩会把带看板的消息从 surface 上**删掉**（实测 seq=27097 替换掉 [26309,26733]，
 *      171 个节点消失，两个看板 26210 / 26579 一并消失）；
 *   ③ 于是下一轮 priorMemory=0 ⇒ 覆盖判据不成立 ⇒ 全量重发 ~24.5k ⇒ 提纯超时 ⇒ 又没有新看板。
 *
 * 结论：**"从看板里捞快照"这条路本身不可靠** —— 看板是渲染产物、且会被宿主回收。
 *   正确做法是把编译成功后的**完整有效状态**直接存下来，看板只负责展示。
 *
 * 本模块的定位
 * ───────────
 *   · 只做一件事：把 `{schemaVersion, compilerVersion, sessionId, branchId, revision,
 *     parentRevision, sourceCutSeq, coverage, applied, entries}` 可靠地存下来、读回来。
 *   · **不解析任何消息文本**，不靠 role / <cot-ledger> 标记推断来源。
 *     关联方式 = 插件自己保存的 (sessionId, branchId) 指针 —— 这比"从正文里认标记"更强，
 *     因为标记可能出现在引用、日志和普通回答里（用户明确指出的缺陷）。
 *   · 落盘顺序严格：**先写完整快照，再原子替换指针**（同一文件 tmp+rename ⇒ 不存在
 *     "水位已推进但 entries 还没写"的中间态）。
 *
 * 覆盖语义（用户 2026-09-22 第 2 点）
 * ─────────────────────────────────
 *   coverage.coveredSeqs = **本轮编译输入里真实存在、且已成功编译进去的**工具结果事件 seq 集合。
 *   不是"某个 max seq"：水位线会跳过未采集 / 迟到返回的结果，集合不会。
 *   过滤判据 = 精确成员判定（resultSeq ∈ coveredSeqs），因此：
 *     · 未采集到的证据 → 不在集合里 → 照发；
 *     · 迟到返回的结果 → 其 resultSeq 不在集合里 → 照发；
 *     · 已编译进快照的证据 → 在集合里 → 省略（其内容已在注入的快照里）。
 *
 * "编译已覆盖" vs "宿主已应用"（用户第 4 点）
 * ────────────────────────────────────────
 *   coverage.at   = 编译已覆盖：这批证据进入了一份**已可靠保存**的有效状态。
 *   applied.at    = 宿主已应用：这份记忆**已提交到主请求面**（surface replace / deferred claim）。
 *   两者绝不混同；applied 只在真正发射时由 markSnapshotApplied() 写入，初始为 null。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { mergeByEvidence, renderCheckpoint, SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION, MEMORY_POLICY_VERSION, MODEL_MEMORY_PREAMBLE } from './state-memory.js'

/** 快照文件格式版本。与 state-memory 的 SCHEMA_VERSION 是两件事，各自演进。 */
// 视图回执：sha256 十六进制串。只用于校验/保留旧快照里的 viewReceipts 字段
//   （证据视图 stateEvidenceViews 已于 v7 退役、代码于 v11.8 移除；字段保留以兼容已落盘的快照）。
export const validReceipt = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)

export const SNAPSHOT_SCHEMA_VERSION = 1

/** 覆盖集合上限：超过就只保留最大的 N 个（防无界增长）。仅影响极长会话。 */
export const COVERED_SEQ_MAX = 4000


// ── 路径 ────────────────────────────────────────────────────────────────────
/** Follow the same DSH_HOME contract as the plugin; do not cache a foreign home. */
export function snapshotsDir() {
  try {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
    const d = path.join(home, 'storages', 'cot-form-b', 'snapshots')
    fs.mkdirSync(d, { recursive: true })
    return d
  } catch { return null }
}

/** 分支键：宿主当前没有分支概念 ⇒ 恒为 'main'；一旦宿主提供 branchId，不同分支互不串味。 */
export function normalizeBranchId(session) {
  if (session && typeof session === 'object') {
    for (const k of ['branchId', 'branch', 'parentId', 'forkFrom']) {
      const v = session[k]
      if (v != null && String(v).trim()) return String(v).trim()
    }
  }
  if (typeof session === 'string' && session.trim()) return session.trim()
  return 'main'
}

function safeKey(s) {
  // 只保留文件名安全字符；其余用其 sha 前 8 位，保证可逆性无关紧要但唯一性够用
  const raw = String(s == null ? '' : s)
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return cleaned + '-' + h
}

/** 快照文件路径（一个会话+分支一个文件；原子替换即"指针更新"）。 */
export function snapshotPath(sessionId, branchId) {
  const d = snapshotsDir()
  if (!d) return null
  return path.join(d, safeKey(sessionId) + '__' + safeKey(branchId == null ? 'main' : branchId) + '.json')
}

/** 快照身份（进 trace / 看板关联用）：与 (sessionId, branchId, revision) 一一对应。 */
export function snapshotIdOf(sessionId, branchId, revision) {
  try {
    return 'snap-' + crypto.createHash('sha256')
      .update(String(sessionId) + '|' + String(branchId == null ? 'main' : branchId) + '|' + String(revision))
      .digest('hex').slice(0, 16)
  } catch { return null }
}

// No Atomics.wait/busy loop on the gateway thread. Lock contention must fail
// closed, never turn into an unlocked read/merge/write. Stale locks are not
// stolen by age: a suspended live writer can still own one.
function acquireLock(file) {
  const lock = file + '.lock'
  let fd
  try {
    fd = fs.openSync(lock, 'wx')
    fs.writeSync(fd, String(process.pid) + '@' + Date.now())
    return true
  } catch {
    if (fd !== undefined) { try { fs.unlinkSync(lock) } catch {} }
    return false
  } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} } }
}
function releaseLock(file) { try { fs.unlinkSync(file + '.lock') } catch {} }
function atomicWrite(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
    fs.renameSync(tmp, file)
  } finally { try { fs.unlinkSync(tmp) } catch {} }
}

// ── 构造 / 校验 ─────────────────────────────────────────────────────────────

/** 空快照（cold start 的起点：没有任何覆盖、没有任何 entries）。 */
export function emptySnapshot(sessionId, branchId) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    memoryPolicyVersion: MEMORY_POLICY_VERSION,
    rendererVersion: RENDERER_VERSION,
    sessionId: sessionId == null ? null : String(sessionId),
    branchId: branchId == null ? 'main' : String(branchId),
    revision: 0,
    parentRevision: null,
    sourceCutSeq: null,
    coverage: { coveredSeqs: [], upTo: null, entries: 0, at: null, sourceCutSeq: null },
    applied: null,
    entries: [],
    viewReceipts: [],
  }
}

/**
 * 严格校验（不抛错）。任何一项不成立都返回 {ok:false, reason} —— 调用方必须按"无快照"处理。
 * 绝不"尽力解释"一个格式不对的快照：那会把伪造/损坏的状态喂给模型。
 */
export function validateSnapshot(obj, opts = {}) {
  try {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-object' }
    if (Number(obj.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) return { ok: false, reason: 'schema-mismatch' }
    if (String(obj.compilerVersion || '') !== COMPILER_VERSION) return { ok: false, reason: 'compiler-mismatch' }
    if (opts.sessionId != null && String(obj.sessionId || '') !== String(opts.sessionId)) return { ok: false, reason: 'session-mismatch' }
    if (opts.branchId != null && String(obj.branchId == null ? 'main' : obj.branchId) !== String(opts.branchId == null ? 'main' : opts.branchId)) {
      return { ok: false, reason: 'branch-mismatch' }
    }
    if (!Array.isArray(obj.entries)) return { ok: false, reason: 'entries-not-array' }
    if (!obj.entries.every((e) => e && typeof e.content === 'string' && e.content.trim()
      && ['goal', 'state', 'judgment', 'constraint', 'attempt', 'gap'].includes(e.category))) {
      return { ok: false, reason: 'invalid-entry' }
    }
    if (!Number.isSafeInteger(obj.revision) || obj.revision < 0) return { ok: false, reason: 'invalid-revision' }
    const cov = obj.coverage && typeof obj.coverage === 'object' ? obj.coverage : {}
    const seqs = Array.isArray(cov.coveredSeqs) ? cov.coveredSeqs : []
    if (seqs.length && !obj.entries.length) return { ok: false, reason: 'coverage-without-state' }
    if (!seqs.every((n) => Number.isSafeInteger(n) && n >= 0)) return { ok: false, reason: 'invalid-coverage' }
    const policy = obj.memoryPolicyVersion == null ? 1 : obj.memoryPolicyVersion
    if (!Number.isSafeInteger(policy) || policy < 1 || policy > MEMORY_POLICY_VERSION) {
      return { ok: false, reason: 'memory-policy-mismatch' }
    }
    const legacy = policy < MEMORY_POLICY_VERSION
    if (obj.viewReceipts != null && (!Array.isArray(obj.viewReceipts) || !obj.viewReceipts.every(validReceipt) || (obj.viewReceipts.length && !obj.entries.length))) return { ok: false, reason: 'invalid-view-receipts' }
    // Preserve old prose, but never treat the old blanket 'observed' assignment
    // as independent verification. Read migration does not modify the file.
    const entries = obj.entries.map((e) => {
      const unverified = e.evidence === 'observed' &&
        (e.origin === 'model' || e.source === 'model' || (e.origin == null && e.source == null))
      return unverified ? { ...e, evidence: 'inferred', legacyEvidence: 'observed' } : { ...e }
    })
    const clean = []
    for (const v of seqs) { const n = Number(v); if (Number.isFinite(n) && n >= 0) clean.push(n) }
    clean.sort((a, b) => a - b)
    // Old merges may already have conflated compile-local m1 IDs. No safe way
    // to infer which evidence survived: retain prose, revoke omission authority.
    if (legacy) clean.length = 0
    return {
      ok: true,
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        compilerVersion: COMPILER_VERSION,
        memoryPolicyVersion: MEMORY_POLICY_VERSION,
        migratedFromPolicy: legacy ? policy : (obj.migratedFromPolicy ?? null),
        rendererVersion: String(obj.rendererVersion || RENDERER_VERSION),
        sessionId: obj.sessionId == null ? null : String(obj.sessionId),
        branchId: obj.branchId == null ? 'main' : String(obj.branchId),
        revision: Number(obj.revision) || 0,
        parentRevision: obj.parentRevision == null ? null : Number(obj.parentRevision),
        sourceCutSeq: obj.sourceCutSeq == null ? null : Number(obj.sourceCutSeq),
        coverage: {
          coveredSeqs: dedupeSeqs(clean),
          upTo: clean.length ? clean[clean.length - 1] : null,
          entries: Number(cov.entries) || 0,
          at: legacy ? null : (cov.at == null ? null : Number(cov.at)),
          sourceCutSeq: cov.sourceCutSeq == null ? null : Number(cov.sourceCutSeq),
        },
        applied: (!legacy && obj.applied && typeof obj.applied === 'object')
          ? { at: obj.applied.at == null ? null : Number(obj.applied.at), revision: obj.applied.revision == null ? null : Number(obj.applied.revision), mode: obj.applied.mode == null ? null : String(obj.applied.mode), seq: obj.applied.seq == null ? null : Number(obj.applied.seq) }
          : null,
        entries,
        viewReceipts: legacy ? [] : [...new Set(obj.viewReceipts || [])].slice(-4000),
      },
    }
  } catch (e) { return { ok: false, reason: 'validate-threw:' + String((e && e.message) || e) } }
}

function dedupeSeqs(list) {
  const out = []
  let prev = null
  for (const v of list) { if (v !== prev) { out.push(v); prev = v } }
  if (out.length > COVERED_SEQ_MAX) return out.slice(out.length - COVERED_SEQ_MAX)
  return out
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/**
 * 载入快照。返回 snapshot（含兼容性标记）或 null。
 * 损坏 / 格式不符 / 会话或分支不匹配 ⇒ null（调用方按 cold start 处理，全量发送）。
 */
export function loadSnapshot(sessionId, branchId, opts = {}) {
  try {
    if (sessionId == null) return null
    const f = opts.file || snapshotPath(sessionId, branchId)
    if (!f || !fs.existsSync(f)) return null
    const text = fs.readFileSync(f, 'utf8')
    if (!text.trim()) return null
    let obj = null
    try { obj = JSON.parse(text) } catch { return null }
    const v = validateSnapshot(obj, { sessionId, branchId })
    if (!v.ok) {
      // 保留证据：不删文件，但明确不采用（下次成功编译会覆盖成新格式）
      return null
    }
    return v.snapshot
  } catch { return null }
}

/**
 * ★ 提交一次成功编译的状态。
 *
 * 语义（与用户要求逐条对应）：
 *   · entries 是**完整有效状态**（由 mergeByEvidence 归并后的全量），不是本轮局部摘要，
 *     也不是六栏展示文本 —— 展示文本由 renderCheckpoint() 现场渲染，不进存储。
 *   · **先归并再写**：磁盘上的旧快照是权威基线，本轮 entries 与它归并 ⇒ 迟到的旧任务
 *     绝不会覆盖更新的快照（只会被并进去）。
 *   · **先写 entries 再替换指针**：tmp 写完后 rename 覆盖，单文件原子 ⇒ 不存在
 *     "水位推进了但 entries 没落盘"的中间态。
 *   · revision 单调递增；parentRevision 记录基线版本，可审计。
 *
 * @param {object} o
 *   sessionId, branchId, entries(本轮结构化条目), coveredSeqs(本轮真实编译进快照的结果 seq 数组),
 *   sourceCutSeq(本轮时间截面), at
 * @returns {{ok:boolean, snapshot:object|null, reason?:string, mergedFrom?:number, added?:number}}
 */
// ★ 条目有界（v11.8）：hybrid 模式的条目没有 objectKey ⇒ mergeByEvidence 不去重，
//   同一批判断反复提交会让 entries 无限增长、且每次整文件重写（实测同样 2 条提交 5 次 = 10 条）；
//   超过 snapshotToText 的 12000 字符上限后快照还会整体失去可读性。
//   ① 同一陈述（忽略 id / at / blockIndex / 归并注记）只留最后一次出现；② 总数封顶，保留最新。
export const SNAPSHOT_ENTRIES_MAX = 256
const VOLATILE_ENTRY_KEYS = new Set(['id', 'at', 'blockIndex', 'note', 'relation'])
function entryIdentity(e) {
  const o = {}
  for (const k of Object.keys(e || {}).sort()) if (!VOLATILE_ENTRY_KEYS.has(k)) o[k] = e[k]
  return JSON.stringify(o)
}
export function boundSnapshotEntries(entries, max = SNAPSHOT_ENTRIES_MAX) {
  const list = Array.isArray(entries) ? entries : []
  const ids = list.map(entryIdentity)
  const last = new Map()
  ids.forEach((id, i) => last.set(id, i))
  const kept = list.filter((_, i) => last.get(ids[i]) === i)
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

export function commitSnapshot(o = {}) {
  const sessionId = o.sessionId == null ? null : String(o.sessionId)
  if (sessionId == null) return { ok: false, snapshot: null, reason: 'no-session' }
  const branchId = o.branchId == null ? 'main' : String(o.branchId)
  const f = snapshotPath(sessionId, branchId)
  if (!f) return { ok: false, snapshot: null, reason: 'no-dir' }

  const locked = acquireLock(f)
  if (!locked) return { ok: false, snapshot: null, reason: 'lock-busy' }
  try {
    // ① 权威基线 = 磁盘现值（**每次重新读**，不用内存缓存 ⇒ 跨进程也安全）
    const loaded = loadSnapshot(sessionId, branchId, { file: f })
    if (!loaded && fs.existsSync(f)) return { ok: false, snapshot: null, reason: 'invalid-existing-snapshot' }
    const prev = loaded || emptySnapshot(sessionId, branchId)

    // ② 归并 entries：证据驱动，时间顺序只决定处理顺序
    const incoming = Array.isArray(o.entries) ? o.entries : []
    if (o.viewReceipts != null && (!Array.isArray(o.viewReceipts) || !o.viewReceipts.every(validReceipt))) return { ok: false, reason: 'invalid-view-receipts' }
    const incomingCheck = validateSnapshot({ ...emptySnapshot(sessionId, branchId), entries: incoming })
    if (!incoming.length || !incomingCheck.ok) {
      return { ok: false, snapshot: null, reason: 'invalid-entries' }
    }
    let mergedEntries = prev.entries
    let added = 0
    try {
      const clone = (x) => JSON.parse(JSON.stringify(x))
      const all = prev.entries.map(clone).concat(incomingCheck.snapshot.entries.map(clone))
      const m = mergeByEvidence(all)
      if (Array.isArray(m)) {
        mergedEntries = boundSnapshotEntries(m)
        added = Math.max(0, mergedEntries.length - prev.entries.length)
      }
    } catch (e) {
      // Never retain old coverage while discarding the state it represents.
      return { ok: false, snapshot: null, reason: 'merge-failed:' + String(e.message || e) }
    }

    // ③ 覆盖集合 = 并集（只增不减；本轮新覆盖的并入基线）
    const seqSet = new Set(prev.coverage.coveredSeqs || [])
    let newSeqs = 0
    for (const v of (Array.isArray(o.coveredSeqs) ? o.coveredSeqs : [])) {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) continue
      if (!seqSet.has(n)) { seqSet.add(n); newSeqs++ }
    }
    const coveredSeqs = dedupeSeqs(Array.from(seqSet).sort((a, b) => a - b))

    const cut = o.sourceCutSeq == null ? null : Number(o.sourceCutSeq)
    const prevCut = prev.sourceCutSeq == null ? null : Number(prev.sourceCutSeq)
    const sourceCutSeq = (cut != null && (prevCut == null || cut > prevCut)) ? cut : prevCut

    const revision = (Number(prev.revision) || 0) + 1
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      compilerVersion: COMPILER_VERSION,
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      migratedFromPolicy: prev.migratedFromPolicy ?? null,
      rendererVersion: RENDERER_VERSION,
      sessionId,
      branchId,
      revision,
      parentRevision: Number(prev.revision) || 0,
      sourceCutSeq,
      coverage: {
        coveredSeqs,
        upTo: coveredSeqs.length ? coveredSeqs[coveredSeqs.length - 1] : null,
        entries: mergedEntries.length,
        at: o.at == null ? Date.now() : Number(o.at),
        sourceCutSeq,
      },
      // ★ 宿主已应用：提交编译结果**不等于**已经进入主请求面。初始一律 null。
      applied: prev.applied || null,
      entries: mergedEntries,
      viewReceipts: [...new Set([...(prev.viewReceipts || []), ...(o.viewReceipts || [])])].slice(-4000),
    }

    // ④ 先写完整快照，再原子替换（tmp 与目标同目录 ⇒ rename 同文件系统，原子）
    atomicWrite(f, snapshot)

    return { ok: true, snapshot, mergedFrom: Number(prev.revision) || 0, added, newSeqs, locked }
  } catch (e) {
    return { ok: false, snapshot: null, reason: String((e && e.message) || e) }
  } finally {
    if (locked) releaseLock(f)
  }
}

/**
 * 标记「宿主已应用」。只在记忆**真的**提交到主请求面时调用。
 * 与 coverage.at（编译已覆盖）严格区分；两者永不互相赋值。
 */
export function markSnapshotApplied(sessionId, branchId, info = {}) {
  const f = snapshotPath(sessionId, branchId)
  if (!f) return false
  const locked = acquireLock(f)
  if (!locked) return false
  try {
    const prev = loadSnapshot(sessionId, branchId, { file: f })
    if (!prev || info.revision !== prev.revision) return false
    const next = Object.assign({}, prev, {
      applied: {
        at: info.at == null ? Date.now() : Number(info.at),
        revision: prev.revision,
        mode: info.mode == null ? null : String(info.mode),
        seq: info.seq == null ? null : Number(info.seq),
      },
    })
    atomicWrite(f, next)
    return true
  } catch { return false } finally {
    if (locked) releaseLock(f)
  }
}

// ── 消费侧 ──────────────────────────────────────────────────────────────────

/** 覆盖集合 → Set（消费侧精确成员判定用）。 */
export function coveredSeqSet(snapshot) {
  const s = new Set()
  if (!snapshot || snapshot.memoryPolicyVersion !== MEMORY_POLICY_VERSION) return s
  try {
    const list = snapshot && snapshot.coverage && Array.isArray(snapshot.coverage.coveredSeqs) ? snapshot.coverage.coveredSeqs : []
    for (const v of list) { const n = Number(v); if (Number.isFinite(n)) s.add(n) }
  } catch {}
  return s
}

/**
 * 渲染成注入用的**完整**状态文本。
 * ⚠ 不经过 priorMemory 通路（那条路会 slice(0,1200)，看板实测可达 5735 字符 ⇒ 会被腰斩）。
 */
export function snapshotToText(snapshot, opts = {}) {
  try {
    const checked = validateSnapshot(snapshot)
    if (!checked.ok || !checked.snapshot.entries.length) return ''
    snapshot = checked.snapshot
    const max = opts.maxChars == null ? 12000 : Number(opts.maxChars)
    const preamble = snapshot.entries.some(e => e.origin === 'model' && e.evidence !== 'observed')
      ? MODEL_MEMORY_PREAMBLE : undefined
    const text = String(renderCheckpoint(snapshot.entries, { preamble }) || '')
    // Partial rendering cannot justify filtering the full coverage set.
    // No silent slicing or fallback that drops scope/conflict/superseded markers.
    if (!text.trim() || !(max > 0) || text.length > max) return ''
    return text
  } catch { return '' }
}

/** 统计（进 trace）。 */
export function snapshotStats(snapshot) {
  try {
    if (!snapshot) return null
    return {
      revision: snapshot.revision,
      memoryPolicyVersion: snapshot.memoryPolicyVersion ?? 1,
      migratedFromPolicy: snapshot.migratedFromPolicy ?? null,
      entries: (snapshot.entries || []).length,
      covered: (snapshot.coverage && snapshot.coverage.coveredSeqs ? snapshot.coverage.coveredSeqs.length : 0),
      upTo: snapshot.coverage ? snapshot.coverage.upTo : null,
      sourceCutSeq: snapshot.sourceCutSeq,
      appliedAt: snapshot.applied ? snapshot.applied.at : null,
      snapshotId: snapshotIdOf(snapshot.sessionId, snapshot.branchId, snapshot.revision),
    }
  } catch { return null }
}

// ── 冷启动恢复（deliverable 3）───────────────────────────────────────────────

/** CAS 目录（dsh-context-memory-bundle 提供）。 */
export function casCatalogPath() {
  try { return path.join(process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'storages', 'dsh-context-memory', 'catalog.jsonl') } catch { return null }
}

/**
 * 扫描 CAS catalog，找出该会话下指定 producer 的记录（按 ts 降序）。
 * 纯读文件，不依赖 store 实例 ⇒ 可以在没有宿主上下文时离线审计。
 */
export function scanCatalog(opts = {}) {
  const out = []
  try {
    const f = opts.catalogPath || casCatalogPath()
    if (!f || !fs.existsSync(f)) return { ok: false, reason: 'no-catalog', records: [] }
    const raw = fs.readFileSync(f, 'utf8')
    const wantProducer = opts.producer ? new Set([].concat(opts.producer)) : null
    const wantSession = opts.sessionId == null ? null : String(opts.sessionId)
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let r = null
      try { r = JSON.parse(s) } catch { continue }
      if (!r) continue
      if (wantProducer && !wantProducer.has(r.producer)) continue
      if (wantSession != null && String(r.sessionId || '') !== wantSession) continue
      out.push(r)
    }
    out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    return { ok: true, records: out, total: out.length }
  } catch (e) { return { ok: false, reason: String((e && e.message) || e), records: [] } }
}

/** 通过 store 读回一条 CAS 记录的全文（按 catalog 的 lines 数逐页读）。 */
export async function readCasText(store, rec, sessionId) {
  try {
    if (!store || typeof store.readRangeByHandle !== 'function') return null
    const lines = []
    let start = 1, chars = 0
    for (let guard = 0; guard < 200; guard++) {
      const out = await store.readRangeByHandle(rec.handle, sessionId, start, 400)
      if (!out || !Array.isArray(out.lines) || !out.lines.every(l => typeof l === 'string')) return null
      chars += out.lines.reduce((n, l) => n + l.length + 1, 0)
      if (chars > 4 * 1024 * 1024) return null
      lines.push(...out.lines)
      if (out.atEof === true) return lines.length ? lines.join('\n') : null
      if (!out.lines.length || !Number.isSafeInteger(out.nextLine) || out.nextLine <= start) return null
      start = out.nextLine
    }
    return null // no EOF, no complete artifact
  } catch { return null }
}

/**
 * ★ 冷启动恢复：先本地，再 CAS。
 *
 * ⚠ 诚实边界（用户明确要求不得混淆）：
 *   · 只有**结构化快照**（本模块写出的 JSON）才能用来初始化覆盖集合；
 *   · 只有**渲染后的看板文本**（历史材料）一律标记 unverified，**绝不**用它初始化覆盖水位；
 *   · 恢复不出来 ⇒ 返回 ok:false ⇒ 必须重新跑出一次完整成功，冷启动**没有**被解决。
 */
export async function recoverSnapshot(o = {}) {
  const sessionId = o.sessionId == null ? null : String(o.sessionId)
  const branchId = o.branchId == null ? 'main' : String(o.branchId)
  const report = { ok: false, snapshot: null, source: null, local: null, cas: null, unverifiedBoards: [], reason: null }
  if (sessionId == null) { report.reason = 'no-session'; return report }

  // ① 本地文件（权威）
  const local = loadSnapshot(sessionId, branchId)
  report.local = local ? snapshotStats(local) : null
  if (local) { report.ok = true; report.snapshot = local; report.source = 'local'; return report }

  // ② CAS 镜像（producer='cot-snapshot'）
  const scan = scanCatalog({ producer: 'cot-snapshot', sessionId })
  report.cas = { records: scan.records.length, ok: scan.ok, reason: scan.reason || null }
  if (scan.ok && scan.records.length && o.store) {
    const candidates = []
    for (const rec of scan.records.slice(0, 100)) {
      const text = await readCasText(o.store, rec, sessionId)
      if (!text || typeof rec.sha256 !== 'string' || crypto.createHash('sha256').update(text).digest('hex') !== rec.sha256) continue
      let obj = null
      try { obj = JSON.parse(text) } catch { continue }
      const v = validateSnapshot(obj, { sessionId, branchId })
      if (v.ok) candidates.push(v.snapshot)
    }
    candidates.sort((a, b) => b.revision - a.revision)
    if (candidates.length) {
      const top = candidates.filter(s => s.revision === candidates[0].revision)
      if (new Set(top.map(s => JSON.stringify(s))).size > 1) { report.reason = 'ambiguous-cas-revision'; return report }
      report.snapshot = candidates[0]; report.source = 'cas'
      if (o.materialize !== false) {
        report.materialized = materializeSnapshot(sessionId, branchId, report.snapshot)
        report.snapshot = loadSnapshot(sessionId, branchId)
        if (!report.snapshot) { report.reason = 'materialize-failed'; return report }
      }
      report.ok = true; return report
    }
  }

  // ③ 历史看板文本：**只能**作为未核实材料，绝不用于初始化覆盖
  const cps = scanCatalog({ producer: ['cot-checkpoint', 'cot-board'], sessionId })
  report.unverifiedBoards = cps.records.slice(0, 5).map((r) => ({ handle: r.handle, ts: r.ts, bytes: r.bytes, producer: r.producer }))
  report.reason = 'no-structured-snapshot'
  return report
}

/**
 * 把一份（通常来自 CAS 的）快照**物化**到本地指针文件。
 * 只读恢复本身不改任何东西；但 birthStart 是同步的，必须在它之前把文件放到磁盘上。
 * 保护：本地已有**更新或同版**的快照 ⇒ 不覆盖（绝不回退状态）。
 */
export function materializeSnapshot(sessionId, branchId, snapshot) {
  const v = validateSnapshot(snapshot, { sessionId, branchId })
  if (!v.ok) return { ok: false, reason: v.reason }
  const f = snapshotPath(sessionId, branchId)
  if (!f) return { ok: false, reason: 'no-dir' }
  if (!acquireLock(f)) return { ok: false, reason: 'lock-busy' }
  try {
    const cur = loadSnapshot(sessionId, branchId, { file: f })
    if (!cur && fs.existsSync(f)) return { ok: false, reason: 'invalid-existing-snapshot' }
    if (cur && cur.revision >= v.snapshot.revision) return { ok: false, reason: 'newer-local-present' }
    atomicWrite(f, v.snapshot)
    return { ok: true, path: f }
  } catch (e) { return { ok: false, reason: String(e.message || e) } }
  finally { releaseLock(f) }
}

/** 从任意 JSON 文本尝试解析出结构化快照（离线审计用；不做兼容性放宽）。 */
export function parseSnapshotJson(text, opts = {}) {
  try {
    const v = validateSnapshot(JSON.parse(String(text || '')), opts)
    return v.ok ? v.snapshot : null
  } catch { return null }
}

/** 诊断：快照存储目录现状（离线审计 / trace 用）。 */
export function snapshotStoreInfo() {
  try {
    const d = snapshotsDir()
    if (!d) return { dir: null, files: 0, bytes: 0 }
    const files = fs.readdirSync(d).filter((x) => x.endsWith('.json'))
    let bytes = 0
    for (const x of files) { try { bytes += fs.statSync(path.join(d, x)).size } catch {} }
    return { dir: d, files: files.length, bytes }
  } catch { return { dir: null, files: 0, bytes: 0 } }
}

export { SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION }
