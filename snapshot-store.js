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
import { mergeByEvidence, renderCheckpoint, SCHEMA_VERSION, COMPILER_VERSION, RENDERER_VERSION } from './state-memory.js'

/** 快照文件格式版本。与 state-memory 的 SCHEMA_VERSION 是两件事，各自演进。 */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** 覆盖集合上限：超过就只保留最大的 N 个（防无界增长）。仅影响极长会话。 */
export const COVERED_SEQ_MAX = 4000

const LOCK_WAIT_MS = 2500
const LOCK_STALE_MS = 20000

// ── 路径 ────────────────────────────────────────────────────────────────────
let _dir = null

/** 快照目录：~/.dsh/storages/cot-form-b/snapshots（与 cover.json 同一 storages 根）。 */
export function snapshotsDir() {
  if (_dir) return _dir
  try {
    const d = path.join(os.homedir(), '.dsh', 'storages', 'cot-form-b', 'snapshots')
    fs.mkdirSync(d, { recursive: true })
    _dir = d
  } catch { _dir = null }
  return _dir
}

/** 分支键：宿主当前没有分支概念 ⇒ 恒为 'main'；一旦宿主提供 branchId，不同分支互不串味。 */
export function normalizeBranchId(session) {
  if (session && typeof session === 'object') {
    for (const k of ['branchId', 'branch', 'parentId', 'forkFrom']) {
      const v = session[k]
      if (v != null && String(v).trim()) return String(v).trim().slice(0, 120)
    }
  }
  if (typeof session === 'string' && session.trim()) return session.trim().slice(0, 120)
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

// ── 同步小睡（Node 主线程允许 Atomics.wait）────────────────────────────────
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch { /* 退化为忙等 */ const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

function lockPathFor(file) { return file + '.lock' }

/**
 * 取文件锁（best-effort）。
 * 为什么要锁：迟到的旧任务与新一轮编译可能同时提交；"先读-再归并-再写"的窗口若被并发插入，
 * 后写者会**覆盖**先写者的归并结果 ⇒ 丢状态。加锁后同一进程内串行、跨进程也基本串行。
 * 拿不到锁**不阻塞主流程**：仍然执行归并写（宁可极小概率丢一次归并，也不许卡住主链路）。
 */
function acquireLock(file) {
  const lp = lockPathFor(file)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx')
      try { fs.writeSync(fd, String(process.pid) + '@' + Date.now()) } catch {}
      fs.closeSync(fd)
      return true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false
      // 陈旧锁（进程崩了没清）⇒ 抢占
      try {
        const st = fs.statSync(lp)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lp); continue }
      } catch {}
      if (Date.now() > deadline) return false
      sleepSync(25)
    }
  }
}

function releaseLock(file) {
  try { fs.unlinkSync(lockPathFor(file)) } catch {}
}

// ── 构造 / 校验 ─────────────────────────────────────────────────────────────

/** 空快照（cold start 的起点：没有任何覆盖、没有任何 entries）。 */
export function emptySnapshot(sessionId, branchId) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    rendererVersion: RENDERER_VERSION,
    sessionId: sessionId == null ? null : String(sessionId),
    branchId: branchId == null ? 'main' : String(branchId),
    revision: 0,
    parentRevision: null,
    sourceCutSeq: null,
    coverage: { coveredSeqs: [], upTo: null, entries: 0, at: null, sourceCutSeq: null },
    applied: null,
    entries: [],
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
    const cov = obj.coverage && typeof obj.coverage === 'object' ? obj.coverage : {}
    const seqs = Array.isArray(cov.coveredSeqs) ? cov.coveredSeqs : []
    const clean = []
    for (const v of seqs) { const n = Number(v); if (Number.isFinite(n) && n >= 0) clean.push(n) }
    clean.sort((a, b) => a - b)
    return {
      ok: true,
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        compilerVersion: COMPILER_VERSION,
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
          at: cov.at == null ? null : Number(cov.at),
          sourceCutSeq: cov.sourceCutSeq == null ? null : Number(cov.sourceCutSeq),
        },
        applied: (obj.applied && typeof obj.applied === 'object')
          ? { at: obj.applied.at == null ? null : Number(obj.applied.at), revision: obj.applied.revision == null ? null : Number(obj.applied.revision), mode: obj.applied.mode == null ? null : String(obj.applied.mode), seq: obj.applied.seq == null ? null : Number(obj.applied.seq) }
          : null,
        entries: obj.entries.slice(),
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
export function commitSnapshot(o = {}) {
  const sessionId = o.sessionId == null ? null : String(o.sessionId)
  if (sessionId == null) return { ok: false, snapshot: null, reason: 'no-session' }
  const branchId = o.branchId == null ? 'main' : String(o.branchId)
  const f = snapshotPath(sessionId, branchId)
  if (!f) return { ok: false, snapshot: null, reason: 'no-dir' }

  const locked = acquireLock(f)
  try {
    // ① 权威基线 = 磁盘现值（**每次重新读**，不用内存缓存 ⇒ 跨进程也安全）
    const prev = loadSnapshot(sessionId, branchId, { file: f }) || emptySnapshot(sessionId, branchId)

    // ② 归并 entries：证据驱动，时间顺序只决定处理顺序
    const incoming = Array.isArray(o.entries) ? o.entries : []
    let mergedEntries = prev.entries
    let added = 0
    try {
      const clone = (x) => JSON.parse(JSON.stringify(x))
      const all = prev.entries.map(clone).concat(incoming.map(clone))
      const m = mergeByEvidence(all)
      if (Array.isArray(m)) {
        mergedEntries = m
        added = Math.max(0, mergedEntries.length - prev.entries.length)
      }
    } catch {
      // 归并失败 ⇒ 退化为"直接采用本轮"，绝不因为归并器出问题而丢状态
      mergedEntries = incoming.slice()
      added = mergedEntries.length
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
    }

    // ④ 先写完整快照，再原子替换（tmp 与目标同目录 ⇒ rename 同文件系统，原子）
    const tmp = f + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8')
    fs.renameSync(tmp, f)

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
  try {
    const prev = loadSnapshot(sessionId, branchId, { file: f })
    if (!prev) return false
    const next = Object.assign({}, prev, {
      applied: {
        at: info.at == null ? Date.now() : Number(info.at),
        revision: prev.revision,
        mode: info.mode == null ? null : String(info.mode),
        seq: info.seq == null ? null : Number(info.seq),
      },
    })
    const tmp = f + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
    fs.renameSync(tmp, f)
    return true
  } catch { return false } finally {
    if (locked) releaseLock(f)
  }
}

// ── 消费侧 ──────────────────────────────────────────────────────────────────

/** 覆盖集合 → Set（消费侧精确成员判定用）。 */
export function coveredSeqSet(snapshot) {
  const s = new Set()
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
    if (!snapshot) return ''
    const max = opts.maxChars == null ? 12000 : Number(opts.maxChars)
    let t = ''
    try { t = String(renderCheckpoint(snapshot.entries) || '') } catch { t = '' }
    if (!t.trim()) {
      // 渲染器失败也必须给出**某些**可用状态：退化为条目原文拼接
      try {
        t = (snapshot.entries || []).map((e) => '· ' + String((e && (e.text || e.value || e.statement)) || '')).filter(Boolean).join('\n')
      } catch { t = '' }
    }
    if (t.length > max) t = t.slice(0, max) + '\n〔快照过长已截断：完整内容见 snapshot revision ' + snapshot.revision + '〕'
    return t
  } catch { return '' }
}

/** 统计（进 trace）。 */
export function snapshotStats(snapshot) {
  try {
    if (!snapshot) return null
    return {
      revision: snapshot.revision,
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
  try { return path.join(os.homedir(), '.dsh', 'storages', 'dsh-context-memory', 'catalog.jsonl') } catch { return null }
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
    const want = Math.max(1, Number(rec.lines) || 1)
    const lines = []
    let start = 1
    for (let guard = 0; guard < 200; guard++) {
      const out = await store.readRangeByHandle(rec.handle, sessionId, start, Math.min(400, want - lines.length + 1))
      const got = (out && Array.isArray(out.lines)) ? out.lines : []
      if (!got.length) break
      for (const l of got) lines.push(l)
      if (out && out.atEof) break
      if (lines.length >= want) break
      const next = out && out.nextLine != null ? Number(out.nextLine) : null
      if (!next || next <= start) break
      start = next
    }
    return lines.length ? lines.join('\n') : null
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
    for (const rec of scan.records) {
      const text = await readCasText(o.store, rec, sessionId)
      if (!text) continue
      let obj = null
      try { obj = JSON.parse(text) } catch { continue }
      const v = validateSnapshot(obj, { sessionId, branchId })
      if (v.ok) {
        report.ok = true
        report.snapshot = v.snapshot
        report.source = 'cas'
        // 物化到本地，供同步的 birthStart 读取（已有更新版本则不覆盖）
        if (o.materialize !== false) report.materialized = materializeSnapshot(sessionId, branchId, v.snapshot)
        return report
      }
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
  try {
    const f = snapshotPath(sessionId, branchId)
    if (!f) return { ok: false, reason: 'no-dir' }
    const cur = loadSnapshot(sessionId, branchId, { file: f })
    if (cur && Number(cur.revision) >= Number(snapshot.revision)) return { ok: false, reason: 'newer-local-present' }
    const tmp = f + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8')
    fs.renameSync(tmp, f)
    return { ok: true, path: f }
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) } }
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
