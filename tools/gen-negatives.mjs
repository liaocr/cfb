#!/usr/bin/env node
// tools/gen-negatives.mjs —— 机械负例生成器（$0、零 API、零训练）
//
// 为什么是「机械派生」而不是「让教师写坏稿」：
//   正样本要花钱生成（教师模型），负样本不用。把一份**已经过硬门**的好稿，沿一条
//   明确的劣化轴做一次**最小机械改动**，坏在哪儿是构造时就知道的 —— 标签是确定的，
//   不是标注出来的。而且因为只改一处，长度、语域、题材、术语全部**配对**，
//   模型没法靠「谁更长」「谁是中文」这种捷径混分。
//
// 六条轴，对着「抄不动背不动拟合不动」那句要求逐条落：
//   N1 copy         照抄稿：把 raw 原样当稿交上去             -> 期望 G6 (+G7)
//   N2 drop-anchor  丢承重：删掉承重锚点                       -> 期望 G3
//   N3 invent       凭空：在引用里塞一个 raw∪ctx 没有的锚点    -> 期望 G1
//   N4 invert       反因果：把 raw 的因果对调并加反转标记      -> 期望 G5
//   N5 over-compress 过压：只剩一句结论，动手接口全没了        -> 期望 G2/G3/G4
//   N6 wrong-locus  错落点：把落点换成 raw 里「最长的另一个路径」-> 期望 G2
//
// N6 不是编出来的假想敌：仓库里 tools/gold-forge2.mjs 第 48 行**真的**是
//   .sort((a,b) => b.length - a.length)[0]
// 也就是按长度选落点，于是真金标里出现了「落点：/home/u/.dsh/storages/cot-form-b/trace.log」
// 这种把症状路径当改点的稿子，而 C1–C6 全过。N6 就是把那个 bug 固化成一个训练负例。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge, anchorsOf, failureText, locusOf, hasAnchor, norm, quotedFragments, causePairs, loadAnchors } from './gen-ruler.mjs'

import { locusActionable } from './gen-ruler.mjs'
const rulerApi = { locusActionable }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TICK = '\u0060'
const PATH_RX = /[\w/][\w./\\-]*\.(?:mjs|js|mts|ts|tsx|json|jsonl|log|md|py|sh)/g
const SYMPTOM_TOKEN_RX = /^(?:EACCES|ENOENT|EPERM|EEXIST|ETIMEDOUT|ECONNRESET|FAIL|FAILED|Error|error|timeout|denied)$/

// 承重锚点的定义只有一份，在 gen-ruler.loadAnchors 里。这里不再抄第二份 ——
// 抄一份出来就会像之前那样悄悄分叉：尺子按「路径要可动手」筛，负例按「在 raw 里就行」筛，
// 于是负例打在的受力点和尺子量的受力点根本不是同一个集合。
export { loadAnchors } from './gen-ruler.mjs'

/**
 * raw 里「最长的另一个路径」—— 复刻 gold-forge2 第 48 行的真实缺陷。
 *
 * 但只挑「raw 自己没打算动」的那个：如果换上去的替代路径本身也是 raw 提议要改的
 * （例如 verify.mjs，raw 里确实说 "verify.mjs sets DSH_HOME"），那换过去就**不是**错落点，
 * 负例就是无效的，尺子放它过门反而是对的。9 条里 5 条漏放属于这一类 ——
 * 不是尺子漏，是负例没造好。造不好的负例直接不造，比造一条假负例诚实。
 */
function longestOtherPath(raw, avoid) {
  const ps = [...new Set((norm(raw).match(PATH_RX) || []))]
  const { locusActionable } = rulerApi
  const cand = ps.filter((p) => p !== avoid && p.split('/').pop() !== avoid.split('/').pop())
  const bad = cand.filter((p) => !locusActionable(raw, p).ok)
  return bad.sort((a, b) => b.length - a.length)[0] || null
}

/** 在引用区间内做一个替换；没有引用区间就自己造一个，保证 G1 有检材。 */
function poisonQuote(draft, from, to) {
  const spans = quotedFragments(draft)
  const src = spans.find((f) => from && f.includes(from))
  if (src) return draft.replace(src, src.split(from).join(to))
  const any = spans.sort((a, b) => b.length - a.length)[0]
  if (any) return draft.replace(any, any + ' ' + TICK + to + TICK)
  return draft + '\n\n（原文逐字）：「' + to + '」'
}

/**
 * 从一份稿子机械派生出全部负例。
 * @returns {Array<{axis, draft, expect: string[], mutation: string, originId?: string}>}
 */
export function makeNegatives(input) {
  const raw = String((input && input.raw) || '')
  const ctx = String((input && input.ctx) || '')
  const draft = String((input && input.draft) || '')
  const out = []
  const load = loadAnchors(raw, ctx)
  const loc = locusOf(draft)

  // N1 照抄稿
  out.push({ axis: 'N1-copy', draft: raw, expect: ['G6 not-copy', 'G7 compressed'], mutation: 'draft := raw（逐字照抄）' })

  // N2 丢承重
  const victim = load.filter((a) => hasAnchor(draft, a)).sort((a, b) => b.length - a.length)[0]
  if (victim) {
    const b = victim.split('/').pop()
    const stripped = draft.split(victim).join('[略]').split(b).join('[略]')
    out.push({ axis: 'N2-drop-anchor', draft: stripped, expect: ['G3 anchors-kept'], mutation: '删除承重锚点 ' + victim })
  }

  // N3 凭空
  // 基座优先取带扩展名的（换出来的假锚点才像真的），且保证 fake !== b ——
  // 原版对没有扩展名的锚点（hedgeStartedAt）replace 不生效，fake 等于原值，
  // 于是 N3 变成「换成它自己」的空操作，看起来像尺子的洞。
  const basis = load.filter((a) => /\.\w+$/.test(a))[0] || load[0] || (norm(raw).match(PATH_RX) || [])[0]
  if (basis) {
    const b = basis.split('/').pop()
    const fake = /\.\w+$/.test(b) ? b.replace(/(\.\w+)$/, '_v2$1') : b + '_v2'
    if (fake !== b) {
      out.push({ axis: 'N3-invent', draft: poisonQuote(draft, b, fake), expect: ['G1 quote-grounded'], mutation: '把 ' + b + ' 换成不存在的 ' + fake })
    }
  }

  // N4 反因果 —— 必须拿 raw 里**真实存在**的因果对来对调，否则造的就不是负例（原版用裸正则
  // 抓，抓到 "EACCES. / the" 这种非锚点，24 条负例全部无效，看起来像尺子的洞，其实是负例的洞）。
  // 造得出来才造：对调之后必须能被同一套抽取器**重新读出来**，否则这条负例是无效的
  // （它看起来像尺子的洞，其实是负例自己的洞）。N6 用的是同一条自律。
  const pairs = causePairs(raw).slice().sort((a, b) => b.length - a.length)
  for (const pr of pairs) {
    const p = pr.split('>')
    const inv = '\n\n并非因为 ' + p[1] + '，而是因为 ' + p[0] + '。'
    const cand = draft + inv
    if (!causePairs(cand).includes(p[1] + '>' + p[0])) continue
    out.push({ axis: 'N4-invert', draft: cand, expect: ['G5 no-cause-inversion'], mutation: '因果对调 ' + p[0] + ' / ' + p[1] })
    break
  }

  // N5 过压
  const q = quotedFragments(draft).sort((a, b) => b.length - a.length)[0]
  if (q) {
    out.push({ axis: 'N5-over-compress', draft: q, expect: ['G3 anchors-kept', 'G2 locus-grounded', 'G4 actionable'], mutation: '只留最长的引用句，其余全删' })
  }

  // N6 错落点
  if (loc.declared) {
    const alt = longestOtherPath(raw, loc.path)
    if (alt) out.push({ axis: 'N6-wrong-locus', draft: draft.split(loc.path).join(alt), expect: ['G2 locus-grounded'], mutation: '落点 ' + loc.path + ' -> ' + alt + '（raw 里最长的另一个路径）' })
  }

  return out.map((n) => ({ ...n, originId: input && input.id }))
}

/**
 * 造负例 -> 拿尺子打 -> 报告**尺子的洞**。
 * 一条负例没被拒，说明尺子缺一道门；这是唯一能让「不劣于原稿」这个回归集只增不减的机制。
 * 金的那个飞轮：当前稿子去测 -> 科学归因 -> 改成新稿。这里把「稿子」换成了「尺子」。
 */
export function auditRuler(rows) {
  const report = { schema: 'cfb.gen-negative-audit/1', at: new Date().toISOString(), nPos: rows.length, nNeg: 0, nRejected: 0, nExpectedGate: 0, byAxis: {}, holes: [], positivesRejected: [] }
  for (const row of rows) {
    const pos = judge({ raw: row.raw, ctx: row.ctx, draft: row.draft })
    if (!pos.pass) { report.positivesRejected.push({ id: row.id, failed: pos.failed }); continue }
    for (const neg of makeNegatives(row)) {
      report.nNeg++
      const r = judge({ raw: row.raw, ctx: row.ctx, draft: neg.draft })
      const hit = neg.expect.filter((e) => r.failed.includes(e))
      const a = (report.byAxis[neg.axis] = report.byAxis[neg.axis] || { n: 0, rejected: 0, expectedGate: 0, missed: 0, otherGate: 0 })
      a.n++
      // 「洞」只有一个定义：这条负例**整条过了尺子**。被别的门拦下不是洞 ——
      // 过压稿同时也是近照抄稿，G6 先拦下来，那是拦住了，不是漏了。
      if (r.failed.length === 0) { a.missed++; report.holes.push({ id: row.id, axis: neg.axis, mutation: neg.mutation, why: '整条负例过了尺子', judge: r.detail }) }
      else {
        report.nRejected++
        a.rejected++
        if (hit.length) { a.expectedGate++; report.nExpectedGate++ } else a.otherGate++
      }
    }
  }
  return report
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const inFile = arg('--in', path.join(ROOT, '.cfb-offline', 'ruler', 'pairs-hand.jsonl'))
  const rows = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  const rep = auditRuler(rows)
  const outFile = arg('--out', path.join(ROOT, '.cfb-offline', 'ruler', 'negative-audit.json'))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(rep, null, 2) + '\n')
  console.log('负例审计：好稿 ' + rep.nPos + ' 条（其中 ' + (rep.nPos - rep.positivesRejected.length) + ' 条过门）· 派生负例 ' + rep.nNeg + ' 条')
  for (const [k, v] of Object.entries(rep.byAxis)) console.log('  ' + k.padEnd(18) + ' n=' + String(v.n).padEnd(4) + ' 被拒=' + String(v.rejected).padEnd(4) + ' 预期门命中=' + String(v.expectedGate).padEnd(4) + ' 别的门=' + String(v.otherGate).padEnd(4) + ' 漏放=' + v.missed)
  console.log('合计：被拒 ' + rep.nRejected + '/' + rep.nNeg + '，其中命中预期门 ' + rep.nExpectedGate + '；尺子的洞（整条过门）=' + rep.holes.filter((h) => h.why === '整条负例过了尺子').length)
  for (const h of rep.holes.slice(0, 8)) console.log('   [' + h.axis + '] ' + h.mutation + ' :: ' + h.why + ' ' + JSON.stringify(h.got || '').slice(0, 90))
  console.log('报告：' + path.relative(ROOT, outFile))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
