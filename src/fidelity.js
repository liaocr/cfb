// dsh-cot-form-b / fidelity.js —— 受保护 token 与保真度核算（纯函数，零网络、同步）
//
// 用途：birthFinish 用 fidelity() 统计压缩稿对原文「逐字标识符」的召回率（只记录，进 trace）；
//       tools/analyze-efficiency.mjs 离线复算同一指标。
//
// ⚠ 召回率是**必要条件**度量：它测不出「结论被升级 / 推理链断裂」，不是质量证明
//   （见 docs/AUDIT-V11.5.md §六）。削减率更不是保真度指标。
//
// 历史：本文件曾是纯规则压缩器 compressByRules（字面去重 + 同构空环折叠）。
//   v11.8 随 'rules' / 'distill' 模式退役一并移除（写回路径协议上永久非法，见 src/config.js 的 DEFAULTS.mode）；
//   需要时可从 v11.7（e818cff）取回。受保护 token 的判据与门禁语义保持不变。

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
