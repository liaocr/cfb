/**
 * 金标转正战役编排器（GOLD-STANDARD §6.1 的"重跑到线"落地成一条命令，且绝不盲烧钱）。
 *   node tools/gold-campaign.mjs                                  # 默认：3 家族 × decoy，最多 3 次投放-续跑
 *   node tools/gold-campaign.mjs --families eacces-config --perturb none --attempts 2 --max-rounds 6
 * 它做四件事，顺序固定：
 *   ① 通道预检（近零成本）：连探 N 次，「思考字数 >0」的比例 ≥ --healthy（默认 2/3）才允许起轨迹；
 *      —— 这一条是被 t102/t103 教出来的：那两趟都是在 upstream-no-reasoning 上把轮数跑完才停，钱花了、样本没攒下。
 *   ② 起 traj-run（hand 臂）→ 有格子暂停就投放「已知最好的那一版稿」（`tools/gold-place-drafts.mjs`：同 id 逐字 / 否则同家族同样本里章上 gap 最小）→ 用同一条命令续跑；
 *   ③ 收尾：gold-vs-line（M2 读数）→ gold-attest（盖章）→ gold-score --dedup（达线与否），并打印前后对比；
 *   ④ 无论成败都把测到的停机原因原样打出来（错误行不许被静默吞掉）。
 * 花钱上限由 --attempts × --max-rounds × 家族数 决定，脚本会先报估算再动手（--dry 只看计划不花钱）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ((process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1) || d) }
const DRY = process.argv.includes('--dry')
const FAMILIES = String(arg('--families', 'eacces-config,wrong-model,sse-truncated')).split(',').filter(Boolean)
const PERTURB = String(arg('--perturb', 'decoy'))
const ATTEMPTS = Number(arg('--attempts', '3'))
const MAXROUNDS = Number(arg('--max-rounds', '8'))
const PROBES = Number(arg('--probes', '3'))
const HEALTHY = Number(arg('--healthy', String(Math.ceil(PROBES * 2 / 3))))
const ENV = { ...process.env }
if (!ENV.DEEPSEEK_API_KEY) { try { for (const l of fs.readFileSync('/home/user/.secrets/keys.env', 'utf8').split('\n')) { const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/)   // 这份 keys.env 是 `export KEY="v"` 形式 ⇒ 两种写法都要吃
      if (m) ENV[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2') } } catch { /* 交给下游报错 */ } }
if (!ENV.DEEPSEEK_API_KEY) throw new Error('no-deepseek-key（既不在环境里也读不到 /home/user/.secrets/keys.env ⇒ 不硬跑）')
const run = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, env: ENV, encoding: 'utf8', timeout: opts.timeout || 1500000 })
const out0 = arg('--out', null)
const nextOut = () => { if (out0) return out0; for (let i = 104; i < 400; i++) { const d = `.cfb-runtime/traj/t${i}`; if (!fs.existsSync(path.join(ROOT, d, 'results.jsonl'))) return d } return '.cfb-runtime/traj/tmax' }
const OUT = nextOut()
const chanArgs = ENV.DEEPSEEK_BASE_URL || ENV.DEEPSEEK_MODEL ? ['--base-url', ENV.DEEPSEEK_BASE_URL || '', '--model', ENV.DEEPSEEK_MODEL || ''] : []   // 空串会覆盖掉 traj-run 自己的 env 回退 ⇒ 没值就不传
const trajArgs = (extra = []) => ['tools/traj-run.mjs', '--variants', 'hand', '--samples', '1', '--max-rounds', String(MAXROUNDS), '--only', FAMILIES.join(','), '--out', OUT, ...chanArgs, ...extra]
const perturbs = PERTURB === 'none' ? [[]] : PERTURB.split(',').map((p) => ['--perturb', p])

console.log(`金标战役 · 家族 ${FAMILIES.join('/')} · 扰动 ${PERTURB} · 每次 ≤${MAXROUNDS} 轮 · 投放 ${ATTEMPTS} 次 · 输出 ${OUT}`)
const eps = FAMILIES.length * perturbs.length
console.log(`估算：最多 ${eps} 条 episode × ≤${MAXROUNDS} 次主调用 ≈ ${'$'}${{ 1: 0.07, 2: 0.14, 3: 0.21, 4: 0.28, 5: 0.35, 6: 0.42 }[eps] || (eps * 0.07).toFixed(2)}（按 t101 实测 $1.40/20 条折算）`)
if (DRY) { for (const pv of perturbs) console.log('  会跑：node ' + trajArgs(pv).join(' ')); console.log('（--dry ⇒ 未发任何请求）'); process.exit(0) }

// ① 预检：通道不返思维链就别起轨迹
let ok = 0, probeLog = []
for (let i = 0; i < PROBES; i++) {
  const r = run(['tools/traj-run.mjs', '--preflight-only', '--only', FAMILIES[0], '--out', OUT + '.probe', ...chanArgs], { timeout: 180000 })
  const text = (r.stdout || '') + (r.stderr || '')
  const m = text.match(/思考 (\d+) 字/)
  const good = r.status === 0 && m && Number(m[1]) > 0
  if (good) ok++; probeLog.push(`  探测 ${i + 1}：${good ? '✓' : '✗'} ${m ? '思考 ' + m[1] + ' 字' : '无思考读数'}${/preflight-failed/.test(text) ? '（' + text.match(/preflight-failed:\w+/)[0] + '）' : ''}`)
}
console.log(`通道预检 ${ok}/${PROBES} 合格（门槛 ${HEALTHY}）\n${probeLog.join('\n')}`)
if (ok < HEALTHY) { console.log('⇒ 不起轨迹：这个通道现在只发正文不发思维链，压无可压（t102/t103 各 2–3 行错误记录就是这么来的）。等通道恢复再跑，同一条命令即可。'); process.exit(3) }

// ② 起 → 投放 → 续跑
for (let a = 1; a <= ATTEMPTS; a++) {
  for (const pv of perturbs) { const r = run(trajArgs(pv)); const t = (r.stdout || '') + (r.stderr || '') ; if (a === 1 && r.status !== 0) console.log(`  run(${pv.join(' ') || 'base'}) 退出 ${r.status}：${t.split('\n').filter((l) => /ERR|失败|error/.test(l)).slice(0, 2).join(' / ').slice(0, 200)}`) }
  const pd = path.join(ROOT, OUT, 'pending')
  const pend = fs.existsSync(pd) ? fs.readdirSync(pd).filter((f) => f.endsWith('.json')) : []
  console.log(`第 ${a} 次：暂停待稿 ${pend.length} 格${pend.length ? '（' + pend.slice(0, 4).join(' ').replace(/\.json/g, '') + '）' : ''}`)
  if (!pend.length) { console.log('⇒ 没有待投的格子（要么全跑完、要么都被拒），收尾。'); break }
  const pl = run(['tools/gold-place-drafts.mjs', OUT])
  console.log((pl.stdout || '').split('\n').filter((l) => l.trim()).map((l) => '  ' + l.trim()).join('\n') || '  （投放脚本无输出）')
}

// ③ 收尾
const step = (label, args) => { const r = run(args); const t = ((r.stdout || '') + (r.stderr || '')).trim().split('\n'); console.log(`\n── ${label}\n` + t.slice(-9).map((l) => '  ' + l).join('\n')); return r }
step('M2 产线对照读数', ['tools/gold-vs-line.mjs'])
step('盖章', ['tools/gold-attest.mjs'])
step('尺子读数', ['tools/gold-score.mjs', '--dedup'])
for (const f of [path.join(ROOT, OUT, 'receipt.json'), path.join(ROOT, OUT, 'summary.md')]) if (fs.existsSync(f)) console.log(`\n── ${path.basename(f)}\n` + fs.readFileSync(f, 'utf8').trim().split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'))
const res = path.join(ROOT, OUT, 'results.jsonl')
if (fs.existsSync(res)) {
  const rows = fs.readFileSync(res, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const errs = rows.filter((r) => r.error || /upstream-no-reasoning/.test(JSON.stringify(r))).length
  console.log(`\n${OUT} 落了 ${rows.length} 行（其中停机/错误 ${errs} 行）· 新 hand 样本 ${rows.filter((r) => r.variant === 'hand' && !r.awaiting).length} 条`)
}
