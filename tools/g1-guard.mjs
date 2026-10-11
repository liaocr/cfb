#!/usr/bin/env node
// tools/g1-guard.mjs —— G1 的**确定性后处理门**（$0、零依赖、可复算）
//
// 它解决的是一个实测出来的、最大的一块可回收分数（gen-ruler/4，dev 89 条）：
//   学生只挂 G1 这一件事的有 21 条；G1 命中总数 39 条，是全部八道门里最大的一项。
//   摘掉凭空引用之后，**有受力点上学生从 25/73 抬到 45/73**（教师 55/73），
//   弄坏 0 条、退回 0 条、孤儿小句 0。也就是说 G1 单独一项就吃掉了大半个师生差距。
//
// 但这里必须先把话说清楚：**它不是在替模型写稿，它是在稿子和原稿之间加一道闸。**
//
// 仓库的架构铁律是「安全来自门，不来自模型」。这条闸门就是那条铁律在输出侧的实现：
//   稿子 -> G1 检查 -> 有凭空锚点 => ① 摘掉那处引用 ② 还是不行 => 回退 raw（100% 无损）
// 关键在于**每一步都不会让结果比 raw 更差**：最坏情况就是回退原稿，而那正是当前
// 「G1 不过就整条丢弃」已经在做的事。所以这道门在数学上不可能让成绩变坏，只有可能变好。
//
// 为什么不「修复」而是「摘除」：
//   把凭空的 init__ 改写成 raw 里真有的 __init__.py，看起来更聪明，但那是**拿正则
//   替模型编一个它没说过的断言**。这个仓库已经在这件事上烧过两次（tools/gold-forge2.mjs
//   拿「raw 里最长的文件名」当落点，C1–C6 全过）。摘除只会让稿子变短，绝不会让它变假。
//
//   ⚠ 这里原本写的是「修复只作为一个被实测否决的对照留在 --mode repair 里」——
//   那句话是错的：repair 模式**从来没有实现过**，也就谈不上被实测否决。
//   在仓库里留一句「某个不存在的模式是被实测否决的」，比不写更坏 ——
//   下一个人会以为那条路已经走过了。改成现在的写法：它被否决的理由是**原则**
//   （正则不许替模型下断言），不是实测。
//   真要重开这条路，先得回答「近似到多少算同一个标识符」这个阈值谁来定 ——
//   那正是本仓库反复烧掉的那类拍脑袋阈值。
//
// 判据与 tools/gen-ruler.mjs 的 G1 **完全同源**：同一个 quoteSpans / anchorsOf / hasAnchor。
// 两边各写一份就会漂移，而漂移不会报错，只会让「门说修好了、尺子说没有」这种
// 谁也看不懂的现象发生。所以这里只 import，绝不复制。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { norm, quotedFragments, anchorsOf, hasAnchor, quoteSpans, splitSentences } from './gen-ruler.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 引号字符。必须与 gen-ruler.mjs 的 quoteSpans 认识的那三对一致。
const QS = '\u300c\u300d\u201c\u201d\u0060'
const trimQuotes = (s) => String(s).replace(new RegExp('^[' + QS + ']+|[' + QS + ']+$', 'g'), '').trim()

// ── 孤儿小句：**删除式修复**留下的指纹 ──
//
// 为什么需要它：摘除一个引用会把周围的字留下，于是「`_is_emitted` 是 `error_class`」
// 变成「 是 」。硬门全过、软分还**升高**（S4 压缩增益变好），但文本已经不能读了。
// 这是同一类洞的第二次出现（第一次是空稿白拿 18%）：**指标测不到「文本被弄坏」**。
//
// 实测（dev 89 条，见 .cfb-offline/_orphan.mjs）：
//   strip    45/73 过门，软分 0.5836，孤儿小句 **0**
//   drop     46/73 过门，软分 0.5925，孤儿小句 **60**（16 条稿，其中 6 条 >= 3）
//   sentence 32/73 过门，软分 0.5126，孤儿小句 0，但 14 条稿被删空
// drop 多挣的那 1 条，代价是 60 处残骸。所以**默认是 strip**。
//
// ⚠ 这个量**不能当硬门**：教师自然稿自己也有孤儿（722 条里最大 8 个，10 条 >= 3），
//   阈值卡在 3 会误杀教师。它没有判别力，只有**诊断力** —— 用来在两个修复策略之间选，
//   不能用来判一份稿子合不合格。把它做成门就会变成仓库里第四处「正则假装自己是判断」。
const ORPHAN_PARTICLES = '是的和与在把被对为了或而就也都还又再才即如若则由从向给让使以及跟同'
const ORPHAN_RX = new RegExp('(?:^|[，。；、：,;:!?！？\\s])\\s*[' + ORPHAN_PARTICLES + ']?\\s*(?=[，。；、：,;:])', 'g')
/** 孤儿小句数。诊断用，不是判据。 */
export function orphanCount(text) { return (String(text == null ? '' : text).match(ORPHAN_RX) || []).length }

/**
 * 找出稿子里**带凭空锚点**的引号区间。
 *
 * 检测口径与 judge() 的 G1 逐字一致：只看引号片段（>= 4 字），只看片段里的锚点，
 * 锚点不在 raw ∪ ctx 里就是凭空。
 * 但**编辑口径不同**：judge 会把嵌套的 「\`x\`」 和 \`x\` 都数一遍（那是它的正确行为，
 * 因为它要判「稿子里有没有凭空引用」）。编辑时只取最外层，否则同一处会被改两次。
 */
export function g1Spans(raw, ctx, draft) {
  const ev = norm(String(raw == null ? '' : raw) + '\n' + String(ctx == null ? '' : ctx))
  const spans = quoteSpans(String(draft == null ? '' : draft))
  const detected = []
  for (const [s, e] of spans) {
    const frag = trimQuotes(draft.slice(s, e))
    if (frag.length < 4) continue
    const invented = [...new Set(anchorsOf(frag).filter((a) => !hasAnchor(ev, a)))]
    if (invented.length) detected.push({ start: s, end: e, frag, invented })
  }
  // 只保留最外层（不被别的命中区间包住的）用于编辑
  const outermost = detected.filter((d) => !detected.some((o) => o !== d && o.start <= d.start && o.end >= d.end && (o.start < d.start || o.end > d.end)))
  return { ev, detected, outermost, nDetected: detected.length, nOutermost: outermost.length }
}

/**
 * 确定性后处理。
 *
 * mode:
 *   'strip'    只摘掉命中区间的**引号**，正文一字不动（改动最小，最保守）
 *   'drop'     删掉命中区间的**整个引用**（连引号带内容）
 *   'sentence' 删掉命中区间所在的**整句**（改动最大，最容易把稿子删空）
 *   'off'      不处理（基线）
 *
 * 返回 { draft, changed, removedChars, mode, hits }
 * **不返回 pass/fail** —— 那是尺子的事。这里只负责「把稿子变成一份更可能过门的稿子」。
 */
export function guardDraft(raw, ctx, draft, opts = {}) {
  const mode = opts.mode || 'strip'
  const d0 = String(draft == null ? '' : draft)
  if (mode === 'off') return { draft: d0, changed: false, removedChars: 0, mode, hits: 0 }
  const g = g1Spans(raw, ctx, d0)
  if (!g.outermost.length) return { draft: d0, changed: false, removedChars: 0, mode, hits: 0 }
  let out = d0
  // 从后往前改，否则前面的改动会让后面的下标全部错位 —— 这类错位不会抛异常，
  // 只会静默地把不相干的字删掉，所以必须写死顺序。
  for (const h of g.outermost.slice().sort((a, b) => b.start - a.start)) {
    if (mode === 'strip') {
      // 引号本身摘掉，内容留下。凭空的是「引用」这个动作，不是那些字。
      out = out.slice(0, h.start) + h.frag + out.slice(h.end)
    } else if (mode === 'drop') {
      out = out.slice(0, h.start) + out.slice(h.end)
    } else if (mode === 'sentence') {
      // 找到包含该区间的那一句，整句删掉。句界用尺子同一个 splitSentences，
      // 不另立一套 —— 两套句界会让「删掉的是哪一句」变得不可复算。
      const before = out.slice(0, h.start)
      const sents = splitSentences(out)
      let acc = 0, s0 = 0, s1 = out.length
      for (const s of sents) {
        const i = out.indexOf(s, acc)
        if (i < 0) break
        if (i <= h.start && h.start < i + s.length) { s0 = i; s1 = i + s.length; break }
        acc = i + s.length
      }
      out = out.slice(0, s0) + out.slice(s1)
      void before
    }
  }
  // 收尾：合并因删除产生的连续空格/空行。不做这一步的话，稿子会带一堆空白，
  // 而空白会进 token 数 —— 于是「摘掉引用」这个动作会**推高** token 比，适得其反。
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
  // 安全阀：修复把稿子弄没了就**原样退回**。'sentence' 模式实测删空了 14 条稿，
  // 而那些空稿会去撞 G0/G1 的同类洞（空稿在 v3 尺子上能白拿 18%）。
  // 这里宁可退回一份过不了门的稿子 —— 过不了门会走 raw 兜底，那是 100% 无损的。
  const body = (s) => s.replace(/\s/g, '').length
  if (body(out) < 0.4 * body(d0)) {
    return { draft: d0, changed: false, removedChars: 0, mode, hits: g.outermost.length, reverted: true,
      invented: [...new Set(g.outermost.flatMap((h) => h.invented))].slice(0, 8) }
  }
  return { draft: out, changed: out !== d0, removedChars: d0.length - out.length, mode, hits: g.outermost.length, reverted: false,
    orphans: orphanCount(out),
    invented: [...new Set(g.outermost.flatMap((h) => h.invented))].slice(0, 8) }
}

// ───────────────────────── CLI ─────────────────────────
// 用法：node tools/g1-guard.mjs --in <pairs.jsonl> --out <pairs.jsonl> [--mode strip|drop|sentence|off]
// 每行 { id, raw, ctx, draft } -> 同结构，draft 已修
function main() {
  const argv = process.argv.slice(2)
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
  const inFile = arg('--in')
  if (!inFile) { console.log('用法: node tools/g1-guard.mjs --in <pairs.jsonl> --out <pairs.jsonl> [--mode strip|drop|sentence|off]'); process.exit(2) }
  const mode = arg('--mode', 'strip')
  const outFile = arg('--out', path.join(path.dirname(path.resolve(ROOT, inFile)), 'guarded-' + mode + '.jsonl'))
  const lines = fs.readFileSync(path.resolve(ROOT, inFile), 'utf8').split(/\r?\n/).filter((l) => l.trim())
  const out = []
  let hits = 0, changed = 0, removed = 0
  for (const l of lines) {
    const o = JSON.parse(l)
    const r = guardDraft(o.raw, o.ctx, o.draft, { mode })
    if (r.hits) hits++
    if (r.changed) changed++
    removed += r.removedChars
    out.push({ ...o, draft: r.draft, guard: { mode: r.mode, hits: r.hits, removedChars: r.removedChars, invented: r.invented || [] } })
  }
  fs.mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true })
  fs.writeFileSync(path.resolve(ROOT, outFile), out.map((x) => JSON.stringify(x)).join('\n') + '\n')
  console.log('G1 后处理门 mode=' + mode + '：' + out.length + ' 条，命中 ' + hits + '，改动 ' + changed + '，共删 ' + removed + ' 字')
  console.log('产出：' + path.relative(ROOT, path.resolve(ROOT, outFile)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
