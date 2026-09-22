// dsh-cot-form-b / rules.js —— 纯规则压缩器（零模型、零网络、同步、无 await）
//
// ═══════════════════════════════════════════════════════════════════════════
// ⛔ 本文件的法（2026-09-17 重写）。违反任一条即为事故。
//
// 纯规则（正则 / 代码）只允许做两件事，外加一条护栏：
//   ① 字面逐字去重 —— 仅当一行 trim 后**逐字节 100% 相同**时才删副本。
//      安全性：同样的信息在别处完完整整地存在，删除副本在数学上零损失。
//   ② 连续同构空环折叠 —— 仅当连续 ≥3 行做**完全同构**（骨架相同）的平级
//      点名排查，且变动的数字**可推导**（完全相同，或逐位 +1 连续）时，
//      才折成一行区间断言，并保留首行、末行原文与计数。
//      安全性：折掉的是没有状态转移的空转循环，不是有结论的推导。
//   ③ 实体保活（护栏，不是变换）—— 任何受保护 token（句柄 / 路径 / 数字 /
//      反引号 / 引号原话 / 标识符 / 中文短语）一旦会丢，**整次削减作废，原样返回**。
//
// ⛔ 默认策略：**Keep by default（不认识的句子一律保留）。**
//   绝不允许出现「不匹配某条正则 ⇒ 默认可删」这种兜底。
//
// ⛔ 纯规则不许当「价值裁判」。以下两条已被**真机实测证明有害**并连根拔除：
//   · 逆向支配剪枝（Backward Dominance）：把 ACTION 口头禅（Let me write.）
//     当成「结论」，删掉它之前的全部 DELIBERATION。
//   · 话语角色状态机（ACTION / PREMISE / OBSTACLE）+ 话题去重：全是英文正则，
//     且 DELIBERATION 是 return 兜底 ⇒ 三条正则不认识的一律送上断头台。
//   ⇒ 想要 50% 以上的深度提纯，必须走【CAS 归档 + LLM 四态提纯】。
//
// ⛔ 事故记录（为什么会有这次重写）：
//   2026-09-16 生产启用纯规则提纯，trace 报 savingPct 50.5%（6 样本 30730 字符）。
//   独立实测后：
//     · 49.8% 的缩减来自逆向支配剪枝；真正的去重 + 折叠只贡献 **0.7%**
//     · 最差样本 1017 → 145 字符：5 个核心技术事实（3330→722 / 4ms /
//       zero API calls / 3350 bytes / 67 lines）全被删除，而全篇信息量最低的
//       两句口癖被完整保留；关键 token 召回 0/3
//     · 6 样本合计关键 token 召回 83.2%，压后文本 22.7% 是填充语
//   ⇒ 结论：**削减率不是保真度指标。只报 savingPct 等于自欺。**
// ═══════════════════════════════════════════════════════════════════════════

// ── 保护性 token ───────────────────────────────────────────────────────────
// 这些是不可再生信息：丢了就再也推不出来。既用于折叠护栏，也用于最终门禁。
const RE_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`,;)]+/gi
const RE_WINPATH = /[A-Za-z]:[\\/][^\s"'`,;)]{2,}/g
const RE_POSIXPATH = /\b[\w.-]*(?:\/[\w.-]+){1,}\b/g
const RE_BACKTICK = /`[^`\n]{2,80}`/g
const RE_QUOTED = /"[^"\n]{4,80}"/g
const RE_NUMBER = /(?<![\w.])\d[\d,]*(?:\.\d+)?(?:%|\s?(?:ms|s|chars|bytes|KB|MB|GB|tokens|lines|items|行|字|个|次))?(?![\w])/g
const RE_IDENT = /\b([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-zA-Z_][A-Za-z0-9]*_[A-Za-z0-9_]+|[a-z]+-[a-z][a-z-]{3,}|[A-Za-z][A-Za-z0-9]*\.[a-z]{2,})\b/g
const RE_CJK = /[\u4e00-\u9fa5]{3,}/g
const PROTECTED = [RE_SCHEME, RE_WINPATH, RE_POSIXPATH, RE_BACKTICK, RE_QUOTED, RE_NUMBER, RE_IDENT, RE_CJK]

/** 抽出一段文本里全部受保护 token。 */
export function protectedTokens(text) {
  const s = String(text || '')
  const set = new Set()
  for (const re of PROTECTED) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      const t = m[0].trim()
      if (t) set.add(t)
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return set
}

/** 这一行是否含受保护 token（折叠护栏用）。 */
export function hasProtected(text) {
  return protectedTokens(text).size > 0
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** token 是否真的还在——数字按词边界比，避免 "4" 命中 "1040"。 */
function containsToken(hay, tok) {
  if (/^\d/.test(tok)) return new RegExp('(?<![\\w])' + escRe(tok) + '(?![\\w])').test(hay)
  return hay.includes(tok)
}

/**
 * 保真度核算。
 * @param allowedRanges 允许丢失的数字区间（开区间 [首,尾]）——只有被证明
 *        「骨架相同 + 数字可推导」的折叠区间才允许进这里。
 */
export function fidelity(src, out, allowedRanges = []) {
  const want = protectedTokens(src)
  const lost = []
  for (const t of want) {
    if (containsToken(out, t)) continue
    if (/^\d+$/.test(t)) {
      const v = Number(t)
      if (allowedRanges.some((r) => v > r[0] && v < r[1])) continue
    }
    lost.push(t)
  }
  const total = want.size
  const kept = total - lost.length
  return {
    lost,
    stats: {
      protectedTokens: total,
      lostTokens: lost.length,
      tokenRecall: total ? +(kept * 100 / total).toFixed(1) : 100,
      lostSample: lost.slice(0, 6),
    },
  }
}

// ── ① 字面逐字去重 ─────────────────────────────────────────────────────────
// 判据刻意收紧：trim 后逐字节相同且长度 ≥ 12，才认为是复读。同一行只留首次出现处。
const DUP_MIN_LEN = 12
function dropExactDuplicateLines(text) {
  const seen = new Set()
  const out = []
  let dropped = 0
  for (const line of String(text || '').split('\n')) {
    const k = line.trim()
    if (k.length >= DUP_MIN_LEN) {
      if (seen.has(k)) { dropped += 1; continue }
      seen.add(k)
    }
    out.push(line)
  }
  return { text: out.join('\n'), dropped }
}

// ── ② 连续同构空环折叠 ─────────────────────────────────────────────────────
// ⛔ 三重硬条件，缺一不折：
//   (1) 骨架相同（数字换成 # 后逐字相同）—— 即「完全同构」；
//   (2) 每行数字序列可推导（完全相同，或逐位 +1 连续）；
//   (3) 折出的断言必须带上首行、末行原文与计数。
const RE_OKLINE = /^\s*(?:[-*]\s*)?(?:✓|✔|✅|OK\b|ok\b|fine\b|PASS\b|pass\b|通过|正常|无异常|成功)\s*[:：.、)）]?\s*(.*)$/
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let k = 0
  while (k < n && a[k] === b[k]) k += 1
  return k
}
function commonSuffixLen(a, b, floor) {
  const n = Math.min(a.length, b.length) - floor
  let k = 0
  while (k < n && a[a.length - 1 - k] === b[b.length - 1 - k]) k += 1
  return k
}
const isWordChar = (ch) => ch !== undefined && /[0-9A-Za-z_\u4e00-\u9fa5]/.test(ch)
/**
 * 连续同构空环折叠。**只有公共前后缀会被折掉，变体一个字都不许丢。**
 * 切点一律**对齐到词边界**，绝不允许把词切一半 —— 否则变体列表会退化成像
 * 「bet / gamm」这种要读者在脑内补字符的暗号（实测撞到过：alpha/beta/gamma
 * 都以 a 结尾，字符级公共后缀把 alpha 的尾巴吃掉了）。
 *   · 变体是「逐位 +1 连续」的整数 ⇒ 用区间断言代替列表；
 *   · 其余情况 ⇒ 把首行之外的变体**逐个原样**列进断言。
 * 折完若不比原文短，调用方判 noGain ⇒ 等于不折。
 */
function foldOkRuns(text) {
  const lines = String(text || '').split('\n')
  const out = []
  const ranges = []
  let folded = 0
  let i = 0
  while (i < lines.length) {
    if (!RE_OKLINE.test(lines[i])) { out.push(lines[i]); i += 1; continue }
    let j = i
    while (j < lines.length && RE_OKLINE.test(lines[j])) j += 1
    const run = j - i
    if (run < 3) { for (let k = i; k < j; k += 1) out.push(lines[k]); i = j; continue }

    const group = lines.slice(i, j)
    const first = group[0]
    let p = first.length
    for (const l of group) p = Math.min(p, commonPrefixLen(first, l))
    while (p > 0 && p < first.length && isWordChar(first[p - 1]) && isWordChar(first[p])) p -= 1

    let s = Math.max(0, Math.min(...group.map((l) => l.length)) - p)
    for (const l of group) s = Math.min(s, commonSuffixLen(first, l, p))
    while (s > 0) {
      const cut = first.length - s
      if (cut > 0 && cut < first.length && isWordChar(first[cut - 1]) && isWordChar(first[cut])) s -= 1
      else break
    }

    const variants = group.map((l) => l.slice(p, l.length - s))
    const distinct = new Set(variants).size > 1
    const numeric = variants.every((v) => /^\d+$/.test(v.trim()))
    const contiguous = numeric && variants.every((v, k) => k === 0 || Number(v.trim()) === Number(variants[k - 1].trim()) + 1)
    let marker = null
    if (contiguous) {
      const a = Number(variants[0].trim())
      const b = Number(variants[variants.length - 1].trim())
      ranges.push([a, b])
      marker = '…（同构「已验证通过」共 ' + run + ' 行，序列 ' + a + '–' + b + '）…'
    } else if (distinct) {
      marker = '…（同构「已验证通过」共 ' + run + ' 行，变体：' + variants.slice(1).map((v) => v.trim()).join(' / ') + '）…'
    }
    if (marker) {
      out.push(first)
      out.push(marker)
      folded += run - 1
      i = j
      continue
    }
    for (let k = i; k < j; k += 1) out.push(lines[k])
    i = j
  }
  return { text: out.join('\n'), folded, ranges }
}
// ── 对外入口 ───────────────────────────────────────────────────────────────
// ⚠ 同步：调用方不得把它放进 await 链。
// ⚠ out === 原文 必须被调用方当成「没压动」处理，不要白白替换。
// ⚠ opts.df 已废弃（随角色状态机一并移除），传进来会被忽略。
export function compressByRules(text, opts = {}) {
  const src = String(text || '')
  if (!src.trim()) return { out: src, stats: { skipped: 'empty' } }

  const dropDupLines = opts.dropDuplicateLines !== false
  const foldRuns = opts.foldRuns !== false
  const stage = {}
  let cur = src

  if (dropDupLines) {
    const r = dropExactDuplicateLines(cur)
    cur = r.text
    stage.dupLinesDropped = r.dropped
  }

  // 门禁 1：字面去重在数学上零损失 ⇒ 此处必须 100% 保真，否则整次作废。
  const g1 = fidelity(src, cur)
  if (g1.lost.length > 0) return refuse(src, stage, 'fidelity-gate-dedup', g1)

  let ranges = []
  if (foldRuns) {
    const r = foldOkRuns(cur)
    cur = r.text
    stage.okRunsFolded = r.folded
    ranges = r.ranges
  }

  // 门禁 2：只允许丢掉已被证明可推导的折叠区间内数字。
  const g2 = fidelity(src, cur, ranges)
  if (g2.lost.length > 0) return refuse(src, stage, 'fidelity-gate-fold', g2)

  const saved = src.length - cur.length
  if (saved <= 0) {
    // ⛔ 这里必须把生效计数清零：out 就是原文，此时再报「去重 3 行 / 折叠 2 行」
    //    会让读 trace 的人以为削减真的生效了（2026-09-17 实测撞到过）。
    const cand = {}
    if (stage.dupLinesDropped) cand.candidateDupLines = stage.dupLinesDropped
    if (stage.okRunsFolded) cand.candidateOkRuns = stage.okRunsFolded
    return { out: src, stats: { rawChars: src.length, outChars: src.length, savedChars: 0, savingPct: 0, noGain: true, ...cand, ...g2.stats } }
  }
  return { out: cur, stats: { rawChars: src.length, outChars: cur.length, savedChars: saved, savingPct: +(saved * 100 / src.length).toFixed(2), ...stage, ...g2.stats } }
}

/** 门禁拒发：原样返回，并把拒发原因与丢失样本留给事后尸检。 */
/**
 * 门禁拒发：原样返回。
 * ⚠ 报出来的 `lostTokens` / `tokenRecall` 描述的是**最终交付的那份文本**（=原文，
 *   必然 100% 保真）；被否决的那份候选的损失记在 `candidateLostTokens` 里。
 *   反过来写会让读 trace 的人以为「交付出去的文本丢了 token」（2026-09-17 撞到过）。
 */
function refuse(src, stage, why, f) {
  return {
    out: src,
    stats: {
      rawChars: src.length, outChars: src.length, savedChars: 0, savingPct: 0,
      noGain: true, refused: why,
      ...stage,
      lostTokens: 0, tokenRecall: 100,
      candidateLostTokens: f.lost.length, candidateLostSample: f.lost.slice(0, 6),
    },
  }
}
