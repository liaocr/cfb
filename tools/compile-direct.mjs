#!/usr/bin/env node
// tools/compile-direct.mjs —— 不经时序回放、不受收网窗口限制，直接用生产编译器（makeBirthCompiler）压缩录音里的推理。
// 用途：给 tools/effect-eval.mjs 准备变体文本（效果评测不关心时延；上游变慢时回放会整片 distill-timeout）。
//   DEEPSEEK_API_KEY=... node tools/compile-direct.mjs --base-url https://a6api.com/v1 --model deepseek-v4.1-flash \
//     --recordings live-all/recordings.json --modes v3,v4 --out direct.json [--only id1,id2] [--cfg '{"compressV4BudgetChars":600}']
// 输出 { rows: [{ id, mode, why:'condensed'|'error', text, rawChars, outChars, ms, promptVersion, kinds }] }（effect-eval --report 可直接读）
import fs from 'node:fs'
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
    else throw new Error('未知参数 ' + a)
  }
  if (!o.recordings || !o.out) throw new Error('需要 --recordings 与 --out')
  return o
}

async function main(argv) {
  const o = parseArgs(argv)
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
      const cfg = I.normalizeConfig({ ...o.cfg, compressPrompt: mode === 'v3' ? 'v3' : 'v4', compressV4Incremental: false, model: o.model, baseUrl: o.baseUrl,
        credentialsPath: cred, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs: o.timeoutMs })
      const t0 = Date.now()
      try {
        const g = await I.makeBirthCompiler(cfg)(raw)
        rows.push({ id: rec.id, mode, why: 'condensed', rawChars: raw.length, outChars: g.text.length, ms: Date.now() - t0,
          promptVersion: g.meta && g.meta.promptVersion, kinds: g.meta && g.meta.v4 && g.meta.v4.kinds, text: g.text })
      } catch (e) { rows.push({ id: rec.id, mode, why: 'error', error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 }) }
    })))
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
  fs.writeFileSync(o.out, JSON.stringify({ rows }, null, 1))
  for (const r of rows) console.log(`${r.id} ${r.mode} ${r.why} ${r.rawChars ?? ''}→${r.outChars ?? ''} ${r.ms}ms ${r.kinds ? JSON.stringify(r.kinds) : ''} ${r.error || ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
