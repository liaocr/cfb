#!/usr/bin/env node
// tools/compile-direct.mjs —— 不经时序回放、不受收网窗口限制，直接用生产编译器（makeBirthCompiler）压缩录音里的推理。
// 用途：给 tools/effect-eval.mjs 准备变体文本（效果评测不关心时延；上游变慢时回放会整片 distill-timeout）。
//   DEEPSEEK_API_KEY=... node tools/compile-direct.mjs --base-url https://a6api.com/v1 --model deepseek-v4.1-flash \
//     --recordings live-all/recordings.json --modes v3,v4 --out direct.json [--only id1,id2] [--cfg '{"compressV4BudgetChars":600}']
//   node tools/compile-direct.mjs --recompile direct.json --recordings live-all/recordings.json --out direct2.json
//     零调用：用当前编译器 / 渲染规则，重编译 direct.json 里捕获的副模型原始输出（v4 行的 side 字段）
// 副模型 = 主模型关思考，每次调用都花钱 ⇒ 改了 compile-v4 / 渲染后一律先 --recompile，不要重新压
// 输出 { rows: [{ id, mode, why:'condensed'|'error', text, rawChars, outChars, ms, promptVersion, kinds }] }（effect-eval --report 可直接读）
import fs from 'node:fs'
import { TASKS } from './v4-live.mjs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv) {
  const o = { modes: ['v3', 'v4'], only: null, cfg: {}, timeoutMs: 90000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else if (a === '--recordings') o.recordings = v()
    else if (a === '--modes') o.modes = v().split(',')
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--cfg') o.cfg = JSON.parse(v())
    else if (a === '--timeout') o.timeoutMs = Number(v())
    else if (a === '--out') o.out = v()
    else if (a === '--recompile') o.recompile = v()
    else if (a === '--no-tasks') o.noTasks = true
    else throw new Error('未知参数 ' + a)
  }
  if (!o.recordings || !o.out) throw new Error('需要 --recordings 与 --out')
  return o
}

/** 零调用重编译：rows[].side（副模型原始输出）+ 录音原文 ⇒ 当前 compileV4 */
export async function recompile(direct, recs, cfg = {}) {
  const I = await import('../index.js')
  const c = I.normalizeConfig({ ...cfg, compressPrompt: 'v4' })
  return direct.rows.map((r) => {
    if (r.mode !== 'v4' || typeof r.side !== 'string') return r
    const rec = recs.find((x) => x.id === r.id)
    if (!rec) return r
    const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
    // v4d 行：散文直写，重编译 = 重跑程序门（锚点逐字校验），零调用
    const isV4d = String(r.promptVersion || '').startsWith('compress-v4d')
    const ctx = (TASKS.find((t) => t.id === r.id) || {}).user || ''
    // ops 行同样带 ctx（v12.7：生产由 plugin 自动构造 compressCtx，ops 路的落点绑定也用它）
    const out = isV4d
      ? I.compileV4Direct(r.side, raw, { ...c, compressCtx: ctx })
      : I.compileV4(r.side, raw, { ...c, compressCtx: ctx }, I.v4Budget(c))
    // v12.7：生产闸门（birth.js birthAccept：空白 / 发明标识符 / token 不降 / 净省不足）离线同判 ⇒ 评测稿在真机会不会被原文放行，这里就能看到
    const accept = out.ok ? acceptOf(I, raw, out.text, { ...c, compressCtx: ctx }) : undefined
    return out.ok ? { ...r, why: 'condensed', text: out.text, outChars: out.text.length, kinds: out.stats.kinds, gate: out.stats, accept, recompiled: true }
      : { ...r, why: 'error', error: out.reason, text: undefined, recompiled: true }
  })
}
const acceptOf = (I, raw, text, cfg) => { const a = I.birthAccept(raw, text, cfg); return a.ok ? 'ok' : a.why + (a.info && a.info.invented ? ':' + a.info.invented.slice(0, 3).join('|') : '') }

async function main(argv) {
  const o = parseArgs(argv)
  if (o.recompile) {
    const rows = await recompile(JSON.parse(fs.readFileSync(o.recompile, 'utf8')), JSON.parse(fs.readFileSync(o.recordings, 'utf8')), o.cfg)
    fs.writeFileSync(o.out, JSON.stringify({ rows }, null, 1))
    for (const r of rows) console.log(`${r.id} ${r.mode} ${r.why} ${r.outChars ?? ''} ${r.kinds ? JSON.stringify(r.kinds) : ''} ${r.accept ? 'accept=' + r.accept : ''} ${r.gate && r.gate.boundBy ? 'bound=' + r.gate.boundBy.join(',') : ''} ${r.error || ''}`)
    return
  }
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('需要 DEEPSEEK_API_KEY')
  const I = await import('../index.js')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-'))
  const cred = path.join(d, 'c.yaml')
  fs.writeFileSync(cred, 'K: "' + key + '"\n', { mode: 0o600 })
  const recs = JSON.parse(fs.readFileSync(o.recordings, 'utf8')).filter((r) => (!o.only || o.only.includes(r.id)))
  const rows = []
  try {
    await Promise.all(recs.flatMap((rec) => o.modes.map(async (mode) => {
      const raw = rec.events.filter((e) => e.k === 'r').map((e) => e.s).join('')
      const cfg = I.normalizeConfig({ ...o.cfg, compressPrompt: mode === 'v3' ? 'v3' : 'v4', compressV4Incremental: false,
        // 直写模式给副模型任务 / 观察上下文（oracle 同口径：任务原文 + 思维链；--no-tasks 关）
        compressCtx: o.noTasks ? '' : (TASKS.find((t) => t.id === rec.id) || {}).user || '', model: o.model, baseUrl: o.baseUrl,
        credentialsPath: cred, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs: o.timeoutMs, captureSideOutput: true })
      const t0 = Date.now()
      try {
        const g = await I.makeBirthCompiler(cfg)(raw)
        rows.push({ id: rec.id, mode, why: 'condensed', rawChars: raw.length, outChars: g.text.length, ms: Date.now() - t0,
          promptVersion: g.meta && g.meta.promptVersion, kinds: g.meta && g.meta.v4 && g.meta.v4.kinds, gate: g.meta && g.meta.v4, accept: acceptOf(I, raw, g.text, cfg), text: g.text, side: g.meta && g.meta.sideOutput })
      } catch (e) { rows.push({ id: rec.id, mode, why: 'error', error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0, side: e && e.meta && e.meta.sideOutput }) }
    })))
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
  fs.writeFileSync(o.out, JSON.stringify({ rows }, null, 1))
  for (const r of rows) console.log(`${r.id} ${r.mode} ${r.why} ${r.rawChars ?? ''}→${r.outChars ?? ''} ${r.ms}ms ${r.kinds ? JSON.stringify(r.kinds) : ''} ${r.accept ? 'accept=' + r.accept : ''} ${r.gate && r.gate.boundBy ? 'bound=' + r.gate.boundBy.join(',') : ''} ${r.error || ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
