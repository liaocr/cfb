#!/usr/bin/env node
// 零模型/零网络历史回放。只分析旧资产，绝不执行其中的 shell，也不使用 judge/Likert。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseEvidenceProposal, evidenceDigest, compileV4Direct, compileV4Evidence } from '../index.js'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const rate = (n, total) => ({ n, total, percent: total ? Number((100 * n / total).toFixed(2)) : null })

/** 只判数据明确记录的三项义务；不是实时回执，不给运行权限。判据不读取参考答案/评委。 */
export function assessHistoricalObservation(task, obs, specs) {
  const text = specs.find((s) => s.id === task)?.obs?.[obs]?.followup
  if (typeof text !== 'string') return { status: 'unknown', reason: 'no-recorded-observation' }
  const landed = /ok（[^\n]*已写入，1 处替换）/.test(text)
  if (!landed) return { status: 'unknown', reason: 'no-landed-evidence' }
  // 日志/窗口没有运行 ID 或追加边界，无论看起来绿还是红都不能归因于本次改动。
  if (['wrong-model', 'perf-regression', 'sse-truncated'].includes(task)) return { status: 'unknown', reason: 'no-run-provenance' }
  if (task === 'flaky-timeout') {
    if (/command not found|不限核|回退/.test(text)) return { status: 'unknown', reason: 'condition-mismatch' }
    return /FAIL test\/hedge/.test(text) ? { status: 'fail', reason: 'symptom-persists' } : { status: 'unknown', reason: 'incomplete-loop-proof' }
  }
  if (task === 'eacces-config') {
    if (/EACCES|FAIL test\/birth/.test(text)) return { status: 'fail', reason: 'symptom-persists' }
    if (/0 失败/.test(text) && /PASS test\/birth/.test(text)) return { status: 'pass', reason: 'historical-symptom-test-passed' }
  }
  return { status: 'unknown', reason: 'no-independent-predicate' }
}
export function replayEvidence({ root = ROOT } = {}) {
  const mr = path.join(root, 'transfer/mr'), specs = readJson(path.join(root, 'tools/effect-mr-specs.json'))
  const files = fs.readdirSync(mr).filter((f) => /^auto-d2.*\.json$/.test(f)).sort()
  const drafts = [], results = [], equality = []
  for (const f of files) {
    const rows = readJson(path.join(mr, f)).rows || []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], proposal = parseEvidenceProposal(row.text || '', { ctx: row.ctx || '' })
      const s = proposal.steps[0]
      drafts.push({ key: `${f}:${i + 1}`, task: row.id, parsed: proposal.parsed,
        complete: !!(s && s.preconditions.length && s.action.path && s.expectedObservation && s.checkCommand),
        authorized: false, executed: false, status: 'unknown', reason: 'no-host-contract-or-live-receipt' })
      const side = row.side || row.text
      if (side) {
        const cfg = { compressCtx: row.ctx || '' }, before = compileV4Direct(side, side, cfg), after = compileV4Evidence(side, side, cfg)
        equality.push(before.ok === after.ok && before.text === after.text && before.reason === after.reason && evidenceDigest(before.stats) === evidenceDigest(after.stats))
      }
    }
  }
  // 绝不按 task/variant/sample 去重：不同观察可以复用这几个字段。
  const source = path.join(mr, 'run4/results.jsonl'), lines = fs.readFileSync(source, 'utf8').trim().split('\n')
  for (let i = 0; i < lines.length; i++) {
    const r = JSON.parse(lines[i]), p = parseEvidenceProposal(r.response || '')
    results.push({ key: `run4/results.jsonl:${i + 1}`, task: r.task, obs: r.obs, variant: r.variant, sample: r.sample,
      parsed: p.parsed, authorized: false, executed: false, liveStatus: 'unknown', historical: assessHistoricalObservation(r.task, r.obs, specs) })
  }
  const count = (rows, k) => rows.filter((r) => r[k]).length
  const hist = Object.fromEntries(['pass', 'fail', 'unknown'].map((s) => [s, results.filter((r) => r.historical.status === s).length]))
  const sources = [...files.map((f) => ['transfer/mr/' + f, readJson(path.join(mr, f))]), ['transfer/mr/run4/results.jsonl', lines], ['tools/effect-mr-specs.json', specs]]
  return {
    schema: 'cfb.evidence-replay/1', modelCalls: 0, networkCalls: 0, cost: 0, judgeUsed: false,
    inputs: sources.map(([file, content]) => ({ file, digest: evidenceDigest(content) })),
    drafts: { rows: drafts.length, parsed: rate(count(drafts, 'parsed'), drafts.length), fourFields: rate(count(drafts, 'complete'), drafts.length),
      executable: rate(0, drafts.length), livePass: rate(0, drafts.length), unknown: drafts.length },
    run4: { rows: results.length, parsed: rate(count(results, 'parsed'), results.length), executable: rate(0, results.length), livePass: rate(0, results.length),
      historical: { ...hist, passAmongDecidable: rate(hist.pass, hist.pass + hist.fail) } },
    legacyByteEquality: rate(equality.filter(Boolean).length, equality.length),
    entries: { drafts, results },
    limitations: ['可执行率 0 是没有宿主授权，并非执行器不能执行。', '历史 pass 不是实时通过率或模型涨分。', '未运行历史命令；无新环境回执的实时通过率为 0，unknown 单列。', '解析率只反映公开旧协议的覆盖，不能评价语义正确性。'],
  }
}
export function evidenceReplayMarkdown(r) {
  const fmt = (x) => `${x.n}/${x.total}（${x.percent ?? '—'}%）`
  return `# 证据程序离线回放（零调用）\n\n判据先于实现预注册于 [架构文档](../EVIDENCE-PROGRAM.md)。命令：\`node tools/replay-evidence.mjs\`。\n\n| 资产 | 行数 | 可解析 | 四字段齐全 | 宿主授权可执行 | 实时通过 |\n|---|---:|---|---|---|---|\n| auto-d2*.json | ${r.drafts.rows} | ${fmt(r.drafts.parsed)} | ${fmt(r.drafts.fourFields)} | ${fmt(r.drafts.executable)} | ${fmt(r.drafts.livePass)} |\n| run4/results.jsonl | ${r.run4.rows} | ${fmt(r.run4.parsed)} | 不适用（模型下一动作，不是轮制品） | ${fmt(r.run4.executable)} | ${fmt(r.run4.livePass)} |\n\n旧编译结果逐字相等：${fmt(r.legacyByteEquality)}。\n\n## 历史观察（独立机检，非实时回执）\n\nrun4 的 canned 观察逐行核对：pass **${r.run4.historical.pass}**、fail **${r.run4.historical.fail}**、unknown **${r.run4.historical.unknown}**；可判分母里的通过 ${fmt(r.run4.historical.passAmongDecidable)}。日志无 run provenance、限核回退不算证据；不读取评委或参考答案，也不把历史成功推广为真实效果。保持所有 ${r.run4.rows} 行，绝不按 task/variant/sample 丢掉不同观察。\n\n${r.limitations.map((s) => '- ' + s).join('\n')}\n\n模型调用 **0**，网络调用 **0**，费用 **0**。本地执行器/完整控制链的通过数字见自测，不与历史回放混算。\n\n## 输入指纹\n\n${r.inputs.map((x) => `- \`${x.file}\`：\`${x.digest}\``).join('\n')}\n`
}
function main(argv) {
  let out, markdown
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i]
    else if (argv[i] === '--markdown') markdown = argv[++i]
    else throw new Error('未知参数 ' + argv[i] + '；本工具没有在线运行选项')
  }
  const report = replayEvidence()
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n') }
  if (markdown) { fs.mkdirSync(path.dirname(markdown), { recursive: true }); fs.writeFileSync(markdown, evidenceReplayMarkdown(report)) }
  const { entries, inputs, ...summary } = report
  console.log(JSON.stringify(summary, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 1 } }
