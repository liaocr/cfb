#!/usr/bin/env node
// tools/hand-preflight.mjs —— 零 API 预检手写稿：把 .cfb-runtime/traj/<plan>/drafts/<id>.md 用 hand 臂
// 同一条闸链先过一遍（G2 决策不变 → 越界 lint → compileV4Direct → birthAccept → stored lint → 标尺自比 dd）。
// 为什么要它：真机单元每轮都要烧主调用，稿子没过闸只是白跑；改稿迭代必须在 $0 这一侧做完。
// 用法：node tools/hand-preflight.mjs t15 [--only id]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as I from '../index.js'
import { handDraftGate, draftDistance, anchorsOf } from './helpers/hand-draft.mjs'
import { programPartsText } from '../src/compile-v4.js'
import { auditMode1Output } from './helpers/mode1-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const plan = argv[0] && !argv[0].startsWith('--') ? argv[0] : 't15'
const only = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null })()
const HOME = path.join(ROOT, '.cfb-runtime', 'traj', plan)
const pendDir = path.join(HOME, 'pending')
const doneDir = path.join(pendDir, 'done')
if (!fs.existsSync(pendDir) && !fs.existsSync(doneDir)) { console.log('无 pending 目录：' + path.relative(ROOT, pendDir)); process.exit(0) }
/** 单元清单：活跃 pending/ 优先，收稿后归档进 pending/done/ 的也要能复验
 *  （v14.21.3：之前只扫 pending/ ⇒ 真机收过稿的单元再也过不了这道复检，改稿重投时只能盲跑）*/
const listUnits = () => {
  const seen = new Map()
  for (const dir of [pendDir, doneDir]) {
    if (!fs.existsSync(dir)) continue
    for (const x of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) if (!seen.has(x.replace(/\.json$/, ''))) seen.set(x.replace(/\.json$/, ''), path.join(dir, x))
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}
let bad = 0
for (const [id, pjson] of listUnits()) {
  if (only && only !== id) continue
  const p = JSON.parse(fs.readFileSync(pjson, 'utf8'))
  const draftFile = path.join(HOME, 'drafts', id + '.md')
  if (!fs.existsSync(draftFile)) { console.log(`${id}: 还没稿（真跑到这一轮会暂停等写）`); continue }
  const draft = fs.readFileSync(draftFile, 'utf8').trim()
  const ev = String(p.raw) + '\n' + String(p.ctx)
  const out = []
  const g2 = handDraftGate(p.raw, draft, p.ctx)
  if (!g2.ok) out.push('G2: ' + g2.violations.map((v) => v.kind + '〈' + String(v.detail).slice(0, 110) + '〉').join(' '))
  const lint = auditMode1Output(draft, ev)
  if (lint.status !== 'clean') out.push('DRAFT-LINT: ' + lint.issues.map((v) => v.category + '〈' + v.excerpt + '〉').join(' '))
  const handCompact = p.minChars === 3100 && p.raw.length < 3100
  const handPolicy = p.minChars === 3100 ? { id: 'hand', config: handCompact ? { continuationPath: 'bounded', programParts: 'compact' } : { programParts: 'no-hints' } } : null
  const cfg0 = I.offlineBirthConfig({ model: 'hand', baseUrl: 'http://127.0.0.1:1', credentialsPath: null, policy: handPolicy, normalizeConfig: I.normalizeConfig })
  const cfg = handCompact ? { ...cfg0, birthMinSavedChars: Math.min(cfg0.birthMinSavedChars || 50, Math.max(20, Math.floor(p.raw.length * 0.05))), ...(p.raw.length < 2600 ? { birthTokenGate: false } : {}) } : cfg0
  const b = await I.birthOffline({ raw: p.raw, ctx: p.ctx, calls: p.calls || [], cfg, gate: true, compile: async (rawText, c) => {
    const v = I.compileV4Direct(draft, rawText, c)
    if (!v.ok) { const e = new Error('v4-direct:' + v.reason); e.meta = { v4: v.stats }; throw e }
    return { text: v.text || draft, meta: { promptVersion: I.compressPromptVersion(c) + '+hand', v4: v.stats } }
  } })
  if (!b.ok) out.push('PRODUCTION-GATE: ' + b.why + ' ' + String(b.reason || JSON.stringify(b.info || null)).slice(0, 220))
  else {
    const storedLint = auditMode1Output(b.text, ev)
    if (storedLint.status !== 'clean') out.push('STORED-LINT: ' + storedLint.issues.map((v) => v.category + '〈' + v.excerpt + '〉').join(' '))
  }
  // 第五道：标尺自洽。金标稿对自己必须 dd=1.000 —— 否则这条天花板谁都够不着（锚点不在原文/上下文里，典型是把 ctx / raw 这类工具词写进稿子）
  const self = draftDistance(draft, draft, { raw: p.raw, ctx: p.ctx, calls: p.calls || [] })
  if (self.score !== 1) {
    const callsText = (p.calls || []).map((c) => `${c.name || ''} ${typeof c.args === 'string' ? c.args : JSON.stringify(c.args || '')}`).join('\n')
    const accBt = [...String(draft).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n')
    const hay = anchorsOf(String(p.raw) + '\n' + String(p.ctx) + '\n' + callsText + '\n' + accBt + '\n' + programPartsText(p.ctx, { programParts: 'full' }) + '\n' + programPartsText(p.ctx, { programParts: 'compact' }))
    const loose = [...anchorsOf(draft)].filter((a) => !hay.has(a))
    out.push(`自比-dd: ${self.score}（key=${self.key.join(',')}）⇒ 这些锚点原文/上下文里没有：${loose.join(' ')} —— 换成原文里的证据再花主调用`)
  }
  const saved = b.ok ? (b.info?.netSaved ?? b.stats?.netSaved ?? null) : null
  console.log(`${id}: raw ${p.raw.length} 字 → 稿 ${draft.length} 字${b.ok ? ' → stored ' + b.text.length + ' 字' + (saved != null ? '（净省 ' + saved + '）' : '') : ''}`)
  if (out.length) { bad++; console.log('  ✗ ' + out.join('\n  ✗ ')) } else console.log('  ✓ 预检全绿（G2 ∧ lint ∧ compileV4Direct ∧ birthAccept ∧ stored lint ∧ 自比 dd）')
}
process.exit(bad ? 2 : 0)
