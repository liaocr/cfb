/**
 * GOLD-STANDARD v1（2026-10-05）—— 「金标水平」的可测量等价定义。
 *
 * 一句话：**一条稿是金标 ⟺ 下列 12 个读数全部落在阈内；任何一个不在阈内就不是金标。**
 * 本模块只测量，不裁决入库（入库仍走 saveGold / gold add）；两边共用同一批生产实现
 * （goldCeiling / handDraftGate / slotsOf / auditMode1Gold / anchorsOf）⇒ 不存在「标准说的」与「工具判的」两套口径。
 *
 * 三组轴：
 *   M 力学（纯文本 + 盘上证据，$0 可测，不花钱）
 *   E 结局（只能由真机轨迹给；缺读数 = 未测，不算通过）
 *   R 溯源与复现（防止 n=1 运气被当标尺：t98/t99 同一格同一稿，一次修好@6、一次 0 edit/8 轮）
 *
 * 每轴返回：value（原生单位的读数）、pass、gap（离阈多近/多远，0=刚好达阈）、margin（余量，越大越狠）、how（怎么自己复算）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { goldCeiling } from './three-mode.mjs'
import { hasClosedRead, slotsOf, anchorsOf, handDraftGate, FIX_INTENT_RE } from './hand-draft.mjs'
import { auditMode1Gold } from './mode1-quality.mjs'
import { episodeOutcome } from './ruler.mjs'
import { programPartsText } from '../../src/compile-v4.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
export const GOLD_STANDARD_VERSION = 'cfb.gold-standard/1'
export const THRESHOLDS = { ratioMax: 0.60, lineMax: 1.0, rtfMax: 6, minSamples: 2 }

export const AXES = [
  { id: 'M1', name: '压缩力度', unit: 'draft/raw', how: 'node tools/gold-score.mjs --id <id>（或 gold-check.mjs）' },
  { id: 'M2', name: '不劣于产线', unit: 'draft/lineChars', how: '先 node tools/gold-vs-line.mjs --pending <p.json> 出线长，再算' },
  { id: 'M3', name: '闭合判读', unit: '0/1', how: 'hasClosedRead(draft)（生产 compileV4Direct 硬要求的那条）' },
  { id: 'M4', name: '可执行验收', unit: '0/0.5/1', how: '首个「验收/读数」锚点后 400 字窗内含逐字命令片段 + 两个互斥分支' },
  { id: 'M5', name: '接地精度', unit: '1 - 证据外片段/全部锚点', how: 'anchorsOf + 反引号片段逐字比对 raw∪ctx' },
  { id: 'M6', name: '装置话术', unit: '0/1', how: 'auditMode1Gold(稿, stored).status === clean' },
  { id: 'M7', name: '决策不变 G2', unit: '0/1', how: 'handDraftGate(raw, draft, ctx).ok' },
  { id: 'M8', name: '落点唯一', unit: '改法句数', how: 'FIX_INTENT_RE 命中行 + 引导词行 = 1，且稿里不许留「或/任选」' },
  { id: 'E1', name: '真机效率（复算）', unit: '轮', how: 'results.jsonl 同格 hand 行 fixedAtRound ≤ 6（自报不作数）' },
  { id: 'E2', name: '不输 raw', unit: 'win/tie/loss', how: 'outcome.vsRaw' },
  { id: 'R1', name: '溯源闭合（五件+逐字回放）', unit: '0/1', how: 'hand-samples 行 + raw/draft 逐字 + 草稿落盘 + 结局行 + receipt/plan' },
  { id: 'R2', name: '可复现样本数', unit: 'n', how: '同家族同轮在 traj 目录里独立样本数 ≥ 2' }
]

const clamp01 = (x) => Math.max(0, Math.min(1, x))

/** results.jsonl 里「暂停行」带 awaiting.{id,pending,draftFile,round} —— 这是注册条目 ↔ 真机凭据的唯一连接键；
 *  「结局行」= 同 home 同 task 同 sample 且 fixedAtRound 为数字的 hand 行。靠这两者回放，绝不靠猜目录。
 *  v1 实测教训：用 task#s0 之类的弱键索引会把 rtf=4 的格子错配成 rtf=7 的行 ⇒ 尺子自己就是脏的。 */
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
/**
 * 把注册条目钉回真机台账。两个文件，口径不同，缺一不可：
 *   · hand-samples.jsonl（cfb.hand-sample/2）= 每条稿的落盘证据：raw / draft / stored / gate / production / revision / 文件路径
 *   · results.jsonl                        = 结局：同 home+task+sample 的 hand 行里 fixedAtRound ≥ 采样轮 的最早一行
 * 一个 id 可能在多趟里都有（重跑过），取「有结局 + 生产闸过」分最高的那趟。
 */
export function locateCell(id, root = ROOT) {
  if (!id) return null
  // 台账里记的路径可能是「相对仓库根」的旧树路径（traj/...），也可能已经随趟迁移 ⇒ 逐级找得到就用，找不到才回退到 basename
  const rel = (p, H, subs = []) => {
    if (!p) return null
    if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null
    const cand = [path.join(root, p), ...(H ? [path.join(H, p.replace(/^.*\/(?=drafts\/|pending\/)/, '')), ...subs.map((sd) => path.join(H, sd, path.basename(p))), path.join(H, path.basename(p))] : [])]
    return cand.find((f) => fs.existsSync(f)) || (fs.existsSync(path.join(root, p)) ? path.join(root, p) : null)
  }
  const cands = []
  for (const H of trajHomes(root)) {
    const led = readJsonl(path.join(H, 'hand-samples.jsonl')).filter((r) => r.id === id).pop()
    if (!led) continue
    const res = readJsonl(path.join(H, 'results.jsonl'))
    const done = res.filter((r) => r.variant === 'hand' && r.task === led.task && (r.sample ?? 0) === (led.sample ?? 0)
      && Number.isInteger(r.fixedAtRound) && r.fixedAtRound >= (led.round ?? 1)).sort((a, b) => a.fixedAtRound - b.fixedAtRound)[0] || null
    const pause = res.find((r) => r?.awaiting?.id === id) || null
    // 真机把已消费的 pending 挪进 pending/done/ —— 两处都要看
    cands.push({
      home: H, ledger: led, row: done, pause, round: led.round ?? null, task: led.task, sample: led.sample ?? 0,
      draftFile: rel(led.draftFile, H, ['drafts', 'drafts.preplaced']),
      pendingFile: rel(led.pendingFile, H, ['pending/done', 'pending']) || rel(pause?.awaiting?.pending, H, ['pending/done', 'pending']),
      rtf: done ? done.fixedAtRound : null, rounds: done ? done.rounds ?? null : null,
      edits: done ? (done.edits || []).map((e) => e.path) : [], verifiedAfterFix: done?.verifiedAfterFix ?? null,
      receipt: path.join(H, 'receipt.json'), plan: path.join(H, 'plan.json'),
      score: (done ? 2 : 0) + (led.production?.ok ? 1 : 0) + (led.gate?.ok ? 1 : 0) + (led.draftFile && fs.existsSync(rel(led.draftFile, H)) ? 1 : 0)
    })
  }
  return cands.sort((a, b) => b.score - a.score)[0] || null
}
export const readJsonIf = (f) => { try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null } catch { return null } }
export const readIf = (f) => { try { return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null } catch { return null } }

/** 量一条稿（item 可缺 draft/stored/outcome；candidateDraft 用于「花真机钱之前」预判） */
export function measureGold(item, { draft = null, lineRow = null, home = null, samples = null, provenance = null, root = ROOT } = {}) {
  const d = String(draft ?? item?.draft ?? '').trim()
  const raw = String(item?.raw ?? ''), ctx = String(item?.ctx ?? '')
  const id0 = item?.id || ''
  const prov = provenance || (id0 ? locateCell(id0, root) : null)
  const pend = readJsonIf(prov?.pendingFile)
  const prow = prov?.row || null
  const led = prov?.ledger || null
  const sentDraft = (typeof led?.draft === 'string' ? led.draft : null) ?? (prov?.draftFile ? readIf(prov.draftFile) : null) ?? (typeof pend?.draft === 'string' ? pend.draft : null)
  const trajRaw = (typeof led?.raw === 'string' && led.raw.length ? led.raw : null) || (pend && typeof pend.raw === 'string' ? pend.raw : '')
  const callText = JSON.stringify(led?.callsThisRound || []) + '\n' + JSON.stringify((prow?.edits || prov?.edits || []).map((e) => (typeof e === 'string' ? e : e.path)))
  let prog = ''
  try { prog = [programPartsText(ctx, { programParts: 'full' }), programPartsText(ctx, { programParts: 'compact' })].filter(Boolean).join('\n') } catch { prog = '' }
  // 证据基 = 起草人当时看得见的那份文本：pending.prompt（含 raw/ctx/当轮历史）+ 该格 transcript + 台账 raw + 生产程序段。
  //   只拿注册表 raw 判会冤枉好稿（本轮实测：6 条在册稿的引用出自 prompt，不在截断过的 raw 里）；
  //   拿全仓文本判会放跑编造 ⇒ 到此为止，prompt 之外当时看不见。
  const ev = [raw, ctx, trajRaw, pend?.prompt || '', JSON.stringify(prow?.transcript || []), JSON.stringify(prov?.pause?.transcript || []), callText, prog].filter((x) => x && x !== '[]').join('\n')
  const A = {}
  const put = (id, value, pass, { gap = 0, margin = 0, note = '' } = {}) => { A[id] = { value, pass: pass === null ? null : !!pass, gap, margin, note } }

  // M1 压缩力度
  // 分母只认「真机台账里那份 raw」——注册表的 raw 是副本，可能截断也可能被 padding 撑长，两个方向都会把压缩率做假。
  const baseRaw = (raw && trajRaw) ? (raw.length <= trajRaw.length ? raw : trajRaw) : (raw || trajRaw)
  const ratio = d.length / Math.max(1, baseRaw.length)
  put('M1', +ratio.toFixed(4), ratio <= THRESHOLDS.ratioMax, { gap: +Math.max(0, (ratio - THRESHOLDS.ratioMax) / THRESHOLDS.ratioMax).toFixed(4), margin: +clamp01((THRESHOLDS.ratioMax - ratio) / THRESHOLDS.ratioMax).toFixed(4), note: trajRaw && trajRaw.length !== raw.length ? `分母取较短那份（${baseRaw.length} 字；注册表副本 ${raw.length}／台账 ${trajRaw.length}）⇒ 副本被撑长时不许算超额压缩` : '' })

  // M2 不劣于产线：缺线长读数记「未测」——不许默认放行，但也不把"没测"说成"不合格"
  if (lineRow?.lineChars == null) put('M2', null, null, { gap: 1, note: '缺产线对照读数 ⇒ 先跑 gold-vs-line.mjs（未测 ≠ 通过，注册闸 C6 仍按不过处理）' })
  else {
    const r = d.length / lineRow.lineChars
    put('M2', +r.toFixed(4), r <= THRESHOLDS.lineMax, { gap: +Math.max(0, r - 1).toFixed(4), margin: +clamp01(1 - r).toFixed(4) })
  }

  // M3 闭合判读
  put('M3', hasClosedRead(d) ? 1 : 0, hasClosedRead(d), { gap: hasClosedRead(d) ? 0 : 1, margin: hasClosedRead(d) ? 1 : 0 })

  // M4 可执行验收（窗 = 首个锚点后 400 字；命令片段必须逐字在证据里）
  const at = d.search(/验收|读数|即收工|看到/)
  const win = at < 0 ? '' : d.slice(at, at + 400)
  const cmds = [...win.matchAll(/`([^`\n]{3,60})`/g)].map((m) => m[1])
  const grounded = cmds.filter((c) => ev.includes(c))
  const branches = (win.match(/⇒|则算|即算完/g) || []).length
  const v4 = grounded.length ? (branches >= 2 ? 1 : 0.5) : 0
  put('M4', v4, v4 === 1, { gap: 1 - v4, margin: v4, note: grounded.length ? `${grounded.length} 个逐字命令片段 · ${branches} 个分支` : '窗内没有逐字存在的命令' })

  // M5 接地（口径 = 生产的 invented-identifier 那一套，不多不少）：
  //   · 无据标识符：稿里出现的每个符号名/路径，必须能在「真机证据基」里找到 —— 证据基 = raw ∪ ctx ∪ 台账 calls ∪ 编辑过的路径；
  //   · 伪引：「…」里的逐字引用必须原样出现在证据基里（引用是"我抄给你看"，编一句就是假证据）；
  //   · 免检：纯数字、`old_text/new_text` 之类协议词、以及**指令性新代码**（改成 `const RETRY = 2` 里的新值）——
  //     新代码本来就不在原文里，但它引用的符号名仍须有出处，所以按 token 级判、不按整段逐字判。
  const cited = [...d.matchAll(/「([^」]{6,})」/g)].map((m) => m[1])
  // 截断引用（… 收尾或中间省略）按生产口径合法：剥掉省略号后必须逐字命中，多段还要保序命中
  const citedOk = (q0) => {
    const q = String(q0).replace(/^[…\s.]+|[…\s.]+$/g, '')
    if (!q) return true
    if (ev.includes(q)) return true
    const segs = q.split(/…+|\.{3,}/).map((x) => x.trim()).filter((x) => x.length >= 12)
    if (!segs.length) return false
    let at = 0
    for (const sg of segs) { const i = ev.indexOf(sg, at); if (i < 0) return false; at = i + sg.length }
    return true
  }
  const evIdents = anchorsOf(ev)
  const localAnchors = [...anchorsOf(d)].filter((a) => !/^[-+]?\d+(?:\.\d+)?$/.test(a) && !evIdents.has(a))
  const badCited = cited.filter((q) => !citedOk(q))
  const denom = localAnchors.length + cited.length
  const prec = denom === 0 ? 1 : +(1 - (localAnchors.length + badCited.length) / denom).toFixed(4)
  put('M5', prec, prec === 1, { gap: +(1 - prec).toFixed(4), margin: prec, note: denom === 0 ? '稿里没有需核实的符号/引用 ⇒ 无可核项' : [...new Set(localAnchors.concat(badCited.map((q) => '伪引:' + q.slice(0, 20))))].slice(0, 4).join(', ') })

  // M6 装置话术（稿与生产实存都算——stored 里的话术同样是这条标尺的一部分）
  const qa = auditMode1Gold({ ...item, draft: d }, { reviewer: 'mode1-writer+apparatus-lint/1' })
  const onDraft = (qa.issues || []).filter((x) => x.field === 'draft').length, onStored = (qa.issues || []).filter((x) => x.field !== 'draft').length
  put('M6', qa.status === 'clean' ? 1 : 0, qa.status === 'clean', { gap: qa.status === 'clean' ? 0 : 1, margin: qa.status === 'clean' ? 1 : 0, note: [...new Set((qa.issues || []).map((x) => x.category))].slice(0, 3).join('+') + `（稿${onDraft}/存${onStored}）` })

  // M7 决策不变 G2（生产闸：写进 stored 后主模型读到的决定不许变）
  let g2 = { ok: false, why: 'no-raw' }
  if (raw) { try { const g = handDraftGate(raw, d, ctx); g2 = { ok: !!g.ok, why: (g.violations || []).map((x) => x.kind).slice(0, 2).join(',') || 'gate-ok' } } catch (e) { g2 = { ok: false, why: 'gate-threw:' + e.message.slice(0, 40) } } }
  put('M7', g2.ok ? 1 : 0, raw ? g2.ok : null, { gap: g2.ok ? 0 : 1, margin: g2.ok ? 1 : 0, note: g2.why })

  // M8 落点唯一（多于一条 ⇒ 那是菜单不是标尺，主模型还得自己挑）
  const sl = slotsOf(d)
  // 「…」里的逐字引用不计（引用原文不是提出改法）；反之，**裸引**原文思考流（Let me/Hmm/Actually…）是要判的缺陷：
  //   它把主模型的推理复述当结论交给副模型，既撑长稿又没给出唯一动作。
  const outside = d.split('\n').map((l) => l.replace(/「[^」]*」/g, ''))
  const fixLines = outside.filter((l, i) => FIX_INTENT_RE.test(l) || /^(?:[-*]\s*)?(?:这条线只有一处|落点|改法|改一处)/.test(l.trim())).length
  const narration = outside.filter((l) => /(^|\s)(?:Let me|Let's|Hmm,|Actually,|I should|I realize|I need to)\b/.test(l)).length
  const menu = (d.match(/或\s*\S{2,}(?:也|又)?可以|二选一|任选|择一|以下任一|(?:也可以|或者)/g) || []).length
  const m8ok = fixLines === 1 && menu === 0 && narration === 0
  put('M8', fixLines, m8ok, { gap: m8ok ? 0 : Math.max(0, Math.abs(fixLines - 1)) + menu + narration, margin: clamp01(1 / Math.max(1, fixLines + menu + narration)), note: `改法句 ${fixLines} 条${menu ? ` · 留了 ${menu} 个「或」（那是菜单不是标尺）` : ''}${narration ? ` · ${narration} 行裸引原文思考流` : ''} · 排除 ${(sl.excluded || []).length} · 验收 ${(sl.accept || []).length}` })

  // E1/E2 只能来自真机；且凭 results.jsonl 的那一行重算，注册表自报的数字不作数
  const o = item?.outcome || null
  const truthRtf = prow ? (typeof prow.fixedAtRound === 'number' ? prow.fixedAtRound : prow.rounds ?? null) : null
  const truthSolved = prow ? episodeOutcome(prow).solved : null   // 「修好」用生产口径，不自立定义
  const drift = []
  if (prov) {
    const sent = sentDraft === null ? null : sentDraft.trim()
    if (sent !== null && sent !== String(item?.draft ?? '').trim()) drift.push(`draft≠台账所发(${String(item?.draft ?? '').trim().length}/${sent.length} 字) ⇒ 这轮的 4–6 轮分数是旧稿挣的`)
    if (trajRaw && raw && !trajRaw.includes(raw) && !raw.includes(trajRaw)) drift.push(`raw 是两份文本(注册 ${raw.length}/台账 ${trajRaw.length} 互不包含)`)
    if (trajRaw && raw && trajRaw.length !== raw.length) drift.push(`raw 长度与台账不符(注册 ${raw.length}/台账 ${trajRaw.length}) ⇒ M1 已按台账算`)
    if (o && typeof o.roundsToFix === 'number' && truthRtf !== null && o.roundsToFix !== truthRtf) drift.push(`outcome 自报 ${o.roundsToFix} 轮 / 真机 ${truthRtf} 轮`)
  }
  if (!prow && o) drift.push('无真机结局行可回放 ⇒ rtf 只是自报')
  if (led && led.production && led.production.ok === false) drift.push('台账记着生产闸不通过：' + (led.production.why || '?'))
  const rtf = o?.roundsToFix ?? null
  const e1val = truthRtf ?? rtf
  const e1meas = prow || o
  const e1ok = e1meas ? (e1val ?? 99) <= THRESHOLDS.rtfMax && (prow ? truthSolved !== false : true) : null
  put('E1', e1val, drift.length ? false : e1ok, { gap: e1ok ? 0 : 1, margin: e1ok ? clamp01((THRESHOLDS.rtfMax - (e1val ?? 99)) / THRESHOLDS.rtfMax) : 0, note: drift.length ? `漂移：${drift.join(' · ')} ⇒ 分数不属于这份稿` : (prow ? `真机行 ${truthRtf ?? '—'} 轮 · 修好即验 ${truthSolved === null ? '?' : truthSolved ? '✓' : '✗'}（注册表自报 ${rtf ?? '—'} 已弃用）` : '无真机结局 ⇒ 未测（不算通过）') })
  const vs = o?.vsRaw ?? null
  const e2 = (o || prow) ? (vs === 'win' || (vs === 'tie' && (e1val ?? 99) <= (o?.rawRoundsToFix ?? 99))) : null   // 平局要比真机轮数，不比自报
  put('E2', vs ?? '—', e2, { gap: e2 ? 0 : 1, margin: vs === 'win' ? 1 : vs === 'tie' ? 0.5 : 0, note: o ? '' : '无真机结局 ⇒ 未测（不算通过）' })

  // R1 溯源闭合（五件，每件都能自己复算）：台账行 · 逐字对齐 · 草稿落盘 · 结局行 · 生产闸留痕
  const ledgerDraft = typeof led?.draft === 'string' ? led.draft.trim() : null
  const rawAligned = !!raw && !!trajRaw && (trajRaw === raw || trajRaw.includes(raw) || raw.includes(trajRaw))
  const draftAligned = ledgerDraft !== null && ledgerDraft === String(item?.draft ?? '').trim()
  const draftOnDisk = (() => { if (prov?.draftFile && fs.existsSync(prov.draftFile)) return true
    for (const H of trajHomes(root)) for (const sub of ['drafts', 'drafts.preplaced']) { const f = path.join(H, sub, `${id0}.md`); if (fs.existsSync(f)) return true }
    return false })()
  const five = {
    '台账行': !!led,
    '逐字对齐': !!led && rawAligned && (ledgerDraft === null || draftAligned),
    '草稿落盘': draftOnDisk,
    '结局行': !!prow,
    '闸留痕': !!led && led.gate?.ok !== false && fs.existsSync(prov.receipt)
  }
  const got = Object.values(five).filter(Boolean).length
  const miss = Object.entries(five).filter(([, v]) => !v).map(([k]) => k)
  put('R1', got / 5, prov ? miss.length === 0 && drift.length === 0 : false, { gap: miss.length ? +(miss.length / 5).toFixed(3) : (drift.length ? 0.2 : 0), margin: clamp01(got / 5 - (drift.length ? 0.2 : 0)), note: !prov ? `真机台账（hand-samples.jsonl）里没有 id=${id0 || '(空)'} 这一行 ⇒ 无法回放` : (miss.length ? '缺 ' + miss.join('/') : (drift.length ? '五件齐但有漂移：' + drift.join(' · ') : `钉在 ${path.basename(prov.home)}：真机 ${truthRtf ?? '—'} 轮 · 编辑 ${prov.edits.length} 处 · 生产闸 ${led.production?.ok ? 'ok' : '不 ok（' + (led.production?.why || '?') + '）'}`)) })

  // R2 可复现样本数（同家族同轮的独立样本 / 独立趟）
  const n = samples ?? countSamples(home, item?.family, item?.task ?? null, item?.sample ?? null, root)
  put('R2', n, n >= THRESHOLDS.minSamples, { gap: +Math.max(0, (THRESHOLDS.minSamples - n) / THRESHOLDS.minSamples).toFixed(3), margin: clamp01(n / THRESHOLDS.minSamples), note: n < THRESHOLDS.minSamples ? 'n=1 ⇒ provisional，不得当尺子用' : '' })

  const axes = {}
  let pass = true, measuredAll = true, gapSum = 0, unmeasured = []
  for (const a of AXES) {
    axes[a.id] = { ...a, ...A[a.id] }
    if (A[a.id].pass === null) { unmeasured.push(a.id); pass = false; continue }
    if (!A[a.id].pass) { pass = false; measuredAll = false }
    gapSum += A[a.id].gap || 0
  }
  const measured = AXES.filter((a) => axes[a.id].pass !== null)
  const margin = +(measured.reduce((s, a) => s + (axes[a.id].margin || 0), 0) / Math.max(1, measured.length)).toFixed(4)
  return {
    schema: GOLD_STANDARD_VERSION, version: GOLD_STANDARD_VERSION, id: item?.id ?? null, draftChars: d.length, rawChars: raw.length, trajRawChars: trajRaw.length, baseRawChars: Math.max(raw.length, trajRaw.length),
    pass, gap: +gapSum.toFixed(4), margin, unmeasured, drift, provenance: prov ? path.basename(prov.home) : null, status: !measuredAll ? 'not-gold' : (pass && !drift.length ? 'gold' : 'provisional-gold'), measuredAll,
    axes, at: new Date().toISOString()
  }
}

/** 可复现性读数：同一家族（同 task 同样本）在**所有** traj 目录里有几条独立 hand 集（不同 plan = 不同趟）。 */
export function trajHomes(root = ROOT) {
  const dirs = [path.join(root, 'traj'), path.join(root, '.cfb-runtime/traj')]
  const out = []
  for (const D of dirs) { if (!fs.existsSync(D)) continue
    for (const f of fs.readdirSync(D)) { const p = path.join(D, f); if (fs.existsSync(path.join(p, 'results.jsonl'))) out.push(p) } }
  return out
}
export function countSamples(home, family, task = null, sample = null, root = ROOT) {
  if (!family) return 0
  const seen = new Set()
  for (const H of trajHomes(root)) {
    for (const l of fs.readFileSync(path.join(H, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      let r; try { r = JSON.parse(l) } catch { continue }
      if (r.variant !== 'hand' || r.status === 'awaiting-draft') continue
      const fam = String(r.task || '').split(':')[0]
      if (fam !== family) continue
      if (task && r.task !== task) continue
      seen.add(`${path.basename(H)}|${r.task}|${r.sample ?? 0}`)
    }
  }
  return seen.size
}

/** 供 CLI 用：读 gold-vs-line 的线长索引 */
export function strokeLineIndex(p = path.join(ROOT, '.cfb-offline', 'ruler', 'gold-vs-line.json')) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).lines || {} } catch { return {} }
}
export { goldCeiling }
