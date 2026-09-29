// tools/compile-mr.mjs —— 多轮压稿（理论 S10）：给 effect-mr 的链压第 2 轮的稿 D2。
//   与生产同口径：ctx = buildCompressCtx([U1, A1{content, reasoning=D1}, U2 观察])——里面自动带【台账】（第 1 轮已定 / 已排除 / 已走过的路）；
//   提示词 = compress-v4d7（台账在手 ⇒ 多轮四段规则 + 第 2 轮样例）；门 = compileV4Direct。
//   用法：DEEPSEEK_API_KEY=… node tools/compile-mr.mjs --chains mr/chains.json --d1 direct-d9a.json --base-url … --model … --out mr/auto-d2.json [--only id] [--ctx-only]
//   --ctx-only：不调用副模型，只打印每条链的 ctx（看台账长什么样）。输出 { rows: [{ id, text, why, ms, gate, accept, ctx }] }（effect-mr --d2 auto=… 可直接读）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASK } from './effect-eval.mjs'

function parseArgs(argv) {
  const o = { timeoutMs: 150000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i]
    if (a === '--chains') o.chains = v()
    else if (a === '--d1') o.d1 = v()
    else if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else if (a === '--out') o.out = v()
    else if (a === '--only') o.only = v().split(',')
    else if (a === '--ctx-only') o.ctxOnly = true
    else if (a === '--timeout') o.timeoutMs = Number(v())
    else throw new Error('未知参数 ' + a)
  }
  if (!o.chains) throw new Error('需要 --chains')
  return o
}
const readRows = (p) => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : j.rows }

export function mrMessages(chain, d1) {
  return [
    { role: 'system', content: '你是在代码仓库里干活的编码 Agent。' },
    { role: 'user', content: chain.u1 },
    { role: 'assistant', content: chain.a1.content, reasoning_content: d1 },
    { role: 'user', content: chain.u2 + ASK },
  ]
}

async function main(argv) {
  const o = parseArgs(argv)
  const I = await import('../index.js')
  const { chains } = JSON.parse(fs.readFileSync(o.chains, 'utf8'))
  const d1rows = o.d1 ? readRows(o.d1) : null
  const rows = []
  let cred = null, d = null
  if (!o.ctxOnly) {
    const key = process.env.DEEPSEEK_API_KEY; if (!key) throw new Error('需要 DEEPSEEK_API_KEY')
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')); cred = path.join(d, 'c.yaml'); fs.writeFileSync(cred, 'K: "' + key + '"\n', { mode: 0o600 })
  }
  try {
    await Promise.all(chains.filter((c) => !o.only || o.only.includes(c.id)).map(async (c) => {
      const d1 = d1rows ? (d1rows.find((r) => r.id === c.id && (!r.why || /^condensed/.test(r.why))) || {}).text : c.a1.raw
      if (!d1) { rows.push({ id: c.id, why: 'error', error: '缺 D1' }); return }
      // 生产里 birth 发生在本轮流结束时，本轮的工具调用已知（S10.3′：验收命令只能取自这里，不许发明）——评测把 A2 的调用列进 ctx
      const calls = [...String(c.a2.content || '').matchAll(/\[tool_call\s+([\w-]+)\]\s*(\{[\s\S]*?\})(?=\s*(?:\[tool_call|\n|$))/g)].map((m) => { try { const j = JSON.parse(m[2]); return m[1] + ' ' + (j.command || (j.path ? j.path + (j.old_text ? '（old_text `' + j.old_text + '` → new_text `' + j.new_text + '`）' : '') : JSON.stringify(j))) } catch { return m[1] + ' ' + m[2] } })
      const ctx = I.buildCompressCtx(mrMessages(c, d1)) + (calls.length ? '\n\n【本轮已发出的调用】（这轮回答里已经发出的工具调用；验收命令只能从这里选）\n' + calls.map((x) => '- ' + x).join('\n') : '')
      if (o.ctxOnly) { rows.push({ id: c.id, ctx }); return }
      const cfg = I.normalizeConfig({ compressPrompt: 'v4', compressV4Incremental: false, compressCtx: ctx, model: o.model, baseUrl: o.baseUrl,
        credentialsPath: cred, credentialRef: 'K', followHostProvider: false, followHostModel: false, trace: false, timeoutMs: o.timeoutMs, captureSideOutput: true })
      const t0 = Date.now()
      try {
        const g = await I.makeBirthCompiler(cfg)(c.a2.raw)
        const inv = I.inventedIdentifiers(c.a2.raw, g.text, { extra: ctx })
        rows.push({ id: c.id, mode: 'v4', why: 'condensed', rawChars: c.a2.raw.length, outChars: g.text.length, ms: Date.now() - t0, promptVersion: g.meta && g.meta.promptVersion, gate: g.meta && g.meta.v4, accept: inv.length ? 'invented-identifier:' + inv.join('|') : 'ok', text: g.text, side: g.meta && g.meta.sideOutput, ctx })
      } catch (e) { rows.push({ id: c.id, mode: 'v4', why: 'error', error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0, side: e && e.meta && e.meta.sideOutput, ctx }) }
    }))
  } finally { if (d) fs.rmSync(d, { recursive: true, force: true }) }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify({ rows }, null, 1))
  for (const r of rows) console.log(o.ctxOnly ? `\n== ${r.id} ctx ${r.ctx.length} 字\n${r.ctx}` : `${r.id} ${r.why} ${r.rawChars ?? ''}→${r.outChars ?? ''} ${r.ms ?? ''}ms ${r.promptVersion || ''} accept=${r.accept || ''} ${r.gate && r.gate.boundBy ? 'bound=' + r.gate.boundBy.join(',') : ''} ${r.error || ''}`)
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
