// tools/helpers/mine-change.mjs —— 候选改动对挖掘 + 方向标注（微模型判读头的训练数据出口，$0）
// 依据（本会话）：regex 直接落定会搞反方向（v3h:250-450→250-1800）；把「挑哪个候选」交给学习器，
// 标注来自金标改法句的方向对（parseGoldDirections），特征全部来自原文/上下文，不含金标信息。
import { anchorsOf } from './hand-draft.mjs'

export function mineChangeCandidates(hay) {
  const out = []
  for (const m of hay.matchAll(/old_text\s*(?:是|为|[:：])?\s*`([^`\n]{1,220})`[^`]{0,200}?new_text\s*(?:是|为|[:：])?\s*`([^`\n]{1,220})`/g))
    out.push({ kind: 'literal', old: m[1].trim(), nw: m[2].trim(), at: m.index })
  const assigns = []
  for (const m of hay.matchAll(/\{?\s*\b([A-Za-z_$][\w$]{2,})\s*[:=]\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_$.-]{1,24})\s*\}?/g)) {
    const span = m[0].trim(); const value = m[2].replace(/[.。]+$/, '')
    if (/[\u4e00-\u9fff]/.test(span)) continue
    if (!(/^\d/.test(value) || /^['"]/.test(value) || /^(?:true|false|null|undefined)$/.test(value) || /[_$.]/.test(value) || /[A-Z]/.test(value))) continue
    assigns.push({ key: m[1], value, span, at: m.index, braced: /\{/.test(m[0]) && /\}/.test(m[0]) })
  }
  const byKey = {}
  for (const a of assigns) (byKey[a.key] ||= []).push(a)
  for (const [key, list] of Object.entries(byKey)) {
    const uniq = []; for (const a of list) if (!uniq.some(u => u.value === a.value)) uniq.push(a)
    if (uniq.length < 2) continue
    for (const a of uniq) for (const b of uniq) if (a !== b) out.push({ kind: 'kv', old: a.span, nw: b.span, at: b.at, key, oldAt: a.at, keyEq: 1 })
  }
  const toks = (s) => new Set([...anchorsOf(s)].map(x => x.toLowerCase()))
  const jac = (a, b) => { const A = toks(a), B = toks(b); let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.max(1, new Set([...A, ...B]).size) }
  const lines = [...new Set(hay.split('\n').map(s => s.trim()).filter(s => s.length >= 20 && s.length <= 160 && !/[\u4e00-\u9fff]/.test(s) && /[=(]|return /.test(s)))]
  for (const a of lines) for (const b of lines) {
    if (a === b) continue
    const jj = jac(a, b)
    if (jj >= 0.6) out.push({ kind: 'near', old: a, nw: b, at: hay.indexOf(b), jac: +jj.toFixed(3) })
  }
  const seen = new Set(); const ded = []
  for (const c of out) { const k = c.kind + '|' + c.old + '|' + c.nw; if (seen.has(k)) continue; seen.add(k); ded.push(c) }
  return ded
}

/** 金标改法句 → 方向对 [{from,to}]（供标注；不参与产品推理）。 */
export function parseGoldDirections(decidedTexts = [], triples = []) {
  const text = [...decidedTexts, ...triples.map(t => `old_text 是 \`${t.oldText}\` 改成 new_text 是 \`${t.newText}\``)].join('\n')
  const dirs = []
  for (const m of text.matchAll(/old_text\s*(?:是|为)?\s*`([^`\n]{1,220})`[\s\S]{0,140}?new_text\s*(?:是|为)?\s*`([^`\n]{1,220})`/g)) dirs.push({ from: m[1].trim(), to: m[2].trim() })
  for (const m of text.matchAll(/(?:把|将)\s*`([^`\n]{1,220})`[^`\n]{0,30}?(?:改为|改成|换成)\s*`([^`\n]{1,220})`/g)) dirs.push({ from: m[1].trim(), to: m[2].trim() })
  for (const m of text.matchAll(/`([^`\n]{1,220})`\s*(?:改为|改成|换成|收成)\s*`([^`\n]{1,220})`/g)) dirs.push({ from: m[1].trim(), to: m[2].trim() })
  const bad = (s) => !s || s === 'new_text' || s === '为' || s.length < 2
  const seen = new Set()
  return dirs.filter(d => !bad(d.from) && !bad(d.to) && !(seen.has(d.from + '|' + d.to)) && (seen.add(d.from + '|' + d.to), true))
}

/** 候选对的特征（全部来自原文/上下文；不含金标）。返回 {names, values}。 */
export function candidateFeatures(hay, c) {
  const posNew = Math.max(0, hay.indexOf(c.nw))
  const rel = hay.length ? posNew / hay.length : 0
  const win = hay.slice(Math.max(0, posNew - 140), posNew + Math.min(140, c.nw.length + 140))
  const before = hay.slice(Math.max(0, posNew - 260), posNew)
  const aOld = anchorsOf(c.old), aNew = anchorsOf(c.nw)
  const numOld = Number((String(c.old).match(/-?\d+(?:\.\d+)?/) || [])[0])
  const numNew = Number((String(c.nw).match(/-?\d+(?:\.\d+)?/) || [])[0])
  const hasNum = Number.isFinite(numOld) && Number.isFinite(numNew)
  const oldPos = Math.max(0, hay.indexOf(c.old))
  const values = [
    c.kind === 'literal' ? 1 : 0,
    c.kind === 'kv' ? 1 : 0,
    c.kind === 'near' ? 1 : 0,
    (c.jac ?? 0),
    /[{}]/.test(c.old) && /[{}]/.test(c.nw) ? 1 : 0,
    c.keyEq ? 1 : 0,
    rel,
    rel > 0.6 ? 1 : 0,
    hasNum ? 1 : 0,
    hasNum && numNew > numOld ? 1 : 0,
    hasNum && numNew < numOld ? 1 : 0,
    Math.min(1, aNew.length / 8),
    Math.min(1, aOld.length / 8),
    /(?:改回|revert|恢复|should be|应该|回到|don'?t synthesize|不要合成|去掉|remove)/i.test(win) ? 1 : 0,
    /(?:改成|改为|换成|收成|set .{0,40} to|change .{0,40} to|let'?s pick|I'?ll use)/i.test(before) ? 1 : 0,
    Math.min(1, Math.abs(c.nw.length - c.old.length) / 120),
    (aNew.length > aOld.length ? 1 : 0),
    oldPos < posNew ? 1 : 0,
    /(?:增加|放大|增大|调大|加大|widen|large|larger|more)/i.test(win) ? 1 : 0,
    /(?:减小|缩小|调小|减小|smaller|less|reduce)/i.test(win) ? 1 : 0,
  ]
  const names = ['literal','kv','near','jac','braced','keyEq','posRel','posLate','hasNum','numUp','numDown','newAnchors','oldAnchors','winRevert','ctxChange','lenDelta','newAnchorMore','oldFirst','winLarger','winSmaller']
  return { names, values }
}
export const CHANGE_FEATURE_NAMES = ['literal','kv','near','jac','braced','keyEq','posRel','posLate','hasNum','numUp','numDown','newAnchors','oldAnchors','winRevert','ctxChange','lenDelta','newAnchorMore','oldFirst','winLarger','winSmaller']
