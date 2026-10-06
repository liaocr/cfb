// 上游判别探针：同一 prompt、同一参数连打 N 次，量「temperature 0 到底有多不确定」+ 温度是否真被遵守。
// 用法：node .cfb-runtime/probe/determinism.mjs [n]     （$0.001 量级；只发小请求，不碰金标与生产状态）
import { readFileSync, writeFileSync } from 'node:fs'
import { draftDistance } from '../../tools/helpers/hand-draft.mjs'
const env = Object.fromEntries(readFileSync('/home/user/.secrets/keys.env', 'utf8').split('\n').map((l) => { const m = l.match(/^export\s+([A-Z_]+)=(.*)$/); return m ? [m[1], m[2].replace(/^"|"$/g, '')] : [] }).filter((x) => x.length === 2))
const base = (env.DEEPSEEK_BASE_URL || '').replace(/\/$/, ''), key = env.DEEPSEEK_API_KEY, model = env.DEEPSEEK_MODEL
const N = Number(process.argv[2] || 10)

// A) 纯复读：temp 0 唯一应该 100% 稳定的任务，用来判「温度有没有被吞」
const ECHO = '逐字复述下面这行，不要解释、不要加任何字符：\nverify:offline 33/33，金标 7 项 / 3 家族，dd 1.000'
// B) 压缩式作答：贴近我们生产路径，量实际会影响判分的差异幅度
const COMPRESS = '你是压缩器。把下面这段思维链压成不超过 120 字的稿子，只输出稿子本身：\n「我先是看了 src/transport.js，发现 assembleSseFrames 把 [DONE] 当成 finish_reason=stop，于是截断流被判成功。我考虑过改 legacy，但 legacy 没被 import，是诱饵。我决定只改一处：去掉兜底，settle 用 finish != null。测试 4 个用例我逐条推演过仍成立。」'

const RAW = COMPRESS.split('\n').slice(1).join('\n')   // 探针 B 的"原文"：当作 raw，用来算真·标尺分差
const call = async (content, temperature) => {
  const t0 = Date.now()
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature, max_tokens: 300, thinking: { type: 'disabled' } }) })
  const j = await r.json().catch(() => ({}))
  return { ms: Date.now() - t0, text: String(j.choices?.[0]?.message?.content ?? '').trim(), finish: j.choices?.[0]?.finish_reason, tok: j.usage?.completion_tokens ?? null, status: r.status, err: j.error || j.msg || null }
}
const many = async (content, temperature, n) => {
  const out = []
  for (let i = 0; i < n; i += 4) out.push(...await Promise.all(Array.from({ length: Math.min(4, n - i) }, () => call(content, temperature))))
  return out
}
const lev = (a, b) => { const m = a.length, n = b.length; let p = [...Array(n + 1).keys()]; for (let i = 1; i <= m; i++) { let prev = p[0]; p[0] = i; for (let j = 1; j <= n; j++) { const t = p[j]; p[j] = Math.min(p[j] + 1, p[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t } } return p[n] }
const sim = (xs) => { const u = [...new Set(xs)]; const pairs = []; for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) pairs.push(1 - lev(u[i], u[j]) / Math.max(u[i].length, u[j].length, 1)); return { variants: u.length, uniq: u.length === 1 ? 1 : +(Math.min(...pairs)).toFixed(3) + '–' + +(Math.max(...pairs)).toFixed(3) } }
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] } }

const ddMatrix = (name, texts) => {
  const ref = texts[0]
  const per = texts.map((t) => draftDistance(t, ref, { raw: RAW, ctx: '' }))
  const scores = per.map((d) => d.score)
  const verdicts = {}
  for (const d of per) verdicts[d.verdict] = (verdicts[d.verdict] || 0) + 1
  const keys = new Set(per.map((d) => d.key.join(',')))
  const srt = [...scores].sort((a, b) => a - b)
  console.log(`\n【标尺影响 · ${name}】以第 1 个变体为参照（dd 公式与模式 2 完全同一条，零 API）`)
  console.log('  分数:', srt.map((x) => x.toFixed(3)).join(' '), '⇒ 极差', (srt[srt.length - 1] - srt[0]).toFixed(3), '｜中位', srt[srt.length >> 1].toFixed(3))
  console.log('  判词分布:', Object.entries(verdicts).map(([k, v]) => k + '×' + v).join(' '), '｜层级键唯一数:', keys.size, keys.size === 1 ? '（⇒ 配对比较不会因措辞翻结论）' : '（⇒ 措辞会翻配对结论，必须重复取保守值）')
  console.log('  各键:', [...keys].join(' ; '))
  return { scores: srt, spread: +(srt[srt.length - 1] - srt[0]).toFixed(3), keys: [...keys], verdicts }
}
const report = (name, rs) => {
  const texts = rs.map((r) => r.text), lens = texts.map((t) => t.length)
  const ok = rs.filter((r) => r.status === 200 && !r.err)
  console.log(`\n【${name}】有效 ${ok.length}/${rs.length} 次`)
  console.log('  完全相同的次数分布:', Object.entries(texts.reduce((a, t) => (a[t.slice(0, 26) + '（…' + t.length + '字）'] = (a[t.slice(0, 26) + '（…' + t.length + '字）'] || 0) + 1, a), {})).map(([k, v]) => `×${v} ${JSON.stringify(k)}`).join('  '))
  console.log('  唯一变体数:', sim(texts).variants, '/', texts.length, '｜变体间相似度区间:', sim(texts).uniq, '（1.000 = 完全一样）')
  console.log('  字数:', JSON.stringify(stats(lens)), '｜补全 tok:', JSON.stringify(stats(rs.map((r) => r.tok))), '｜耗时 ms:', JSON.stringify(stats(rs.map((r) => r.ms))), '｜finish:', [...new Set(rs.map((r) => r.finish))].join('/') || '—')
  const empty = texts.filter((t) => !t).length; if (empty) console.log('  ⚠ 空正文:', empty, '次')
}

report('A 纯复读 @ temp 0', await many(ECHO, 0, N))
const rb = await many(COMPRESS, 0, N); report('B 压缩作答 @ temp 0', rb)
const ddB = ddMatrix('B temp 0 的 ' + N + ' 次互相', rb.map((r) => r.text))
const rc = await many(COMPRESS, 2, 4); report('C 压缩作答 @ temp 2（对照）', rc)
const ddC = ddMatrix('C temp 2 的 4 次', rc.map((r) => r.text))
const ra = await many(ECHO, 0, 1)
writeFileSync(new URL('./determinism.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), model, base, echo: (await many(ECHO, 0, N)).map(r=>r.text), b: rb.map(r=>r.text), c: rc.map(r=>r.text), ddB, ddC }, null, 2))
console.log('\n原文样本落盘：.cfb-runtime/probe/determinism.json')
