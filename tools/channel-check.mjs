#!/usr/bin/env node
// tools/channel-check.mjs —— 换中转 / 换渠道后先跑这个（2 次 ≤60 token 的调用），判定这条通道能不能承载 CFB：
//   ① 主模型是否真的在思考（thinking:{type:'enabled'} 下 reasoning_content 非空）
//   ② 上一轮 assistant 的 reasoning_content 是否被拼进上下文（带 tools，1 字 vs 1000 字 ⇒ prompt_tokens 应差 ≥ 0.3×字数）
//   ③ system_fingerprint 是什么（effect-eval --require-fp 只认 TRUSTED_FP）
//   2026-09-29 教训：某渠道只认 OpenAI 风格 reasoning_effort、指纹为空、且把 reasoning_content 整个丢掉（372 = 372）——
//   在那种通道上 raw / 压缩稿 / 空白对模型完全一样，评测出的差异全是噪声；生产上 CFB 压不压也没效果。
//   用法：DEEPSEEK_API_KEY=… node tools/channel-check.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL
import { makeChat, TRUSTED_FP } from './effect-eval.mjs'

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--base-url') o.baseUrl = v()
    else if (a === '--model') o.model = v()
    else throw new Error('未知参数 ' + a)
  }
  if (!o.baseUrl || !o.model) throw new Error('需要 --base-url 与 --model')
  return o
}

const TOOLS = [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
const messagesWith = (rc) => [
  { role: 'user', content: '请读 a.js 看看 port 是多少。' },
  { role: 'assistant', content: '我先读文件。', reasoning_content: rc, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'const port = 8123' },
  { role: 'user', content: '根据结果，port 是多少？只答数字。' },
]

export async function channelCheck({ baseUrl, model, apiKey, rounds = 3 }) {
  const chat = makeChat({ baseUrl, apiKey })
  const filler = '我们需要看 port 的值。'.repeat(90)   // ≈ 1000 字
  const probes = []
  for (let i = 0; i < rounds; i++) {
    for (const [k, rc] of [['short', 'x'], ['long', filler]]) {
      const r = await chat({ model, messages: messagesWith(rc), tools: TOOLS, thinking: { type: 'enabled' }, max_tokens: 400, stream: false })
      probes.push({ k, fp: r.fp || null, prompt: Number(r.usage && r.usage.prompt_tokens), reasoning: (r.message.reasoning_content || '').length,
        claude: !!(r.usage && Object.keys(r.usage).some((x) => x.startsWith('claude'))) })
    }
  }
  // 按指纹分组：同一后端里 long − short 的 prompt_tokens 差 ⇒ 是否拼接
  const byFp = {}
  for (const p of probes) { const g = byFp[String(p.fp)] ??= { fp: p.fp, n: 0, short: [], long: [], thinks: 0, claude: 0 }; g.n++; g[p.k].push(p.prompt); if (p.reasoning > 0) g.thinks++; if (p.claude) g.claude++ }
  const groups = Object.values(byFp).map((g) => {
    const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
    const delta = mean(g.long) - mean(g.short)
    return { ...g, delta, concatenates: Number.isFinite(delta) ? delta >= 0.3 * filler.length : null, trusted: TRUSTED_FP.has(g.fp) }
  })
  const good = groups.filter((g) => g.concatenates && g.thinks === g.n && !g.claude)
  const share = probes.filter((p) => good.some((g) => g.fp === p.fp)).length / probes.length
  return { probes, groups, verdict: { ok: good.length > 0, goodFps: good.map((g) => g.fp), share, mixed: groups.length > 1 } }
}

if (import.meta.url === new URL('file://' + process.argv[1]).href || process.argv[1].endsWith('channel-check.mjs')) {
  const o = parseArgs(process.argv.slice(2))
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('需要 DEEPSEEK_API_KEY')
  channelCheck({ ...o, apiKey, rounds: Number(process.env.CHANNEL_CHECK_ROUNDS || 3) }).then(({ probes, groups, verdict }) => {
    for (const p of probes) console.log(`${p.k.padEnd(6)} fp=${p.fp} prompt_tokens=${p.prompt} reasoning=${p.reasoning}字${p.claude ? ' claude-shape' : ''}`)
    for (const g of groups) console.log(`后端 ${g.fp}: 命中 ${g.n}/${probes.length}，思考 ${g.thinks}/${g.n}，Δprompt(1000字−1字)=${Number.isFinite(g.delta) ? g.delta.toFixed(0) : '（只见到一种长度，判不了）'} ⇒ 拼接=${g.concatenates == null ? '?' : g.concatenates ? '是' : '否'}${g.trusted ? '（TRUSTED_FP）' : ''}`)
    if (!verdict.ok) console.log('结论：不可用 —— 没有一个后端同时满足「在思考 + 拼接上一轮 reasoning_content + 非 claude 形状」；压缩稿对模型不可见，评测差异全是噪声')
    else if (verdict.mixed) console.log(`结论：混合池，可用后端 ${verdict.goodFps.join(',')} 占 ${(verdict.share * 100).toFixed(0)}%；effect-eval 必须 --require-fp（其余后端会被作废重发，费用按命中率放大 ≈ ×${(1 / Math.max(verdict.share, 0.05)).toFixed(1)}）`)
    else console.log(`结论：单一后端 ${verdict.goodFps[0]}，可用；${TRUSTED_FP.has(verdict.goodFps[0]) ? 'effect-eval 可直接 --require-fp' : '指纹不在 TRUSTED_FP，Δprompt 合理可加入后再 --require-fp'}`)
    process.exit(verdict.ok ? 0 : 2)
  }).catch((e) => { console.error(e && e.stack || e); process.exit(1) })
}
