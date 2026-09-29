// dsh-cot-form-b / fidelity.js —— 受保护 token 与保真度核算（纯函数，零网络、同步）
//
// 用途：birthFinish 用 fidelity() 统计压缩稿对原文「逐字标识符」的召回率（只记录，进 trace）；
//       tools/analyze-efficiency.mjs 离线复算同一指标。
//       v12.1：inventedIdentifiers() —— 压缩稿里出现、原文里没有的标识符（路径 / URL / 反引号代码 / camelCase /
//       snake_case / file.ext）。birthFinish 据此拒绝替换（birthIdentifierGate，缺省开）。
//       来历：v4 理论的不变量 I2「标识符必须有出处」（docs/theory 第五卷），从参考实现 value.js 吸收进生产路径。
//
// ⚠ 召回率是**必要条件**度量：它测不出「结论被升级 / 推理链断裂」，不是质量证明
//   （见 docs/analysis/AUDIT-V11.5.md §六）。削减率更不是保真度指标。
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

// ── v12.1 发明标识符检测（I2：标识符必须有出处）─────────────────────────────
// 只取「高精度」类别：路径（带扩展名或 ≥2 段）、URL、反引号代码、camelCase、snake_case、file.ext。
// 刻意不取：数字（摘要可合法计数/换算）、中文词、kebab-case（易与普通英文复合词撞车）。
// 宁可漏报（漏报 = 与 v12.0 行为相同），不可误报（误报 = 白扔一次压缩，但仍安全：原文放行）。
const RE_GATE_PATH = /(?:\b[A-Za-z]:[\\/]|(?<![\w.])\.{0,2}\/)?[\w.-]+(?:[\\/][\w.-]+)+/g
const RE_GATE_IDENT = /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-zA-Z_][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z][A-Za-z0-9_-]*\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|py|go|rs|java|c|h|cpp|sh|ps1|log|txt|lock|css|html))\b/g
function gateTokens(text) {
  const s = String(text || '')
  const out = new Set()
  const add = (t) => { t = t.replace(/^[`'"(]+|[`'"),.:;]+$/g, ''); if (t.length >= 3) out.add(t) }
  let m
  RE_SCHEME.lastIndex = 0
  while ((m = RE_SCHEME.exec(s)) !== null) add(m[0])
  // v12.7：反引号按顺序配对（split），不再用「≤80 字的 `…`」正则——长片段（R2″ 落点行、直写稿里 80–220 字的逐字行）会让正则
  //   把上一个片段的闭合反引号和下一个片段的开头配成一对，把中间的散文当成「代码」报发明（compile-direct accept 抓到）。
  const parts = s.split('`')
  for (let i = 1; i < parts.length; i += 2) { const seg = parts[i]; if (seg.length >= 2 && seg.length <= 300 && !seg.includes('\n')) add(seg) }
  RE_GATE_PATH.lastIndex = 0
  while ((m = RE_GATE_PATH.exec(s)) !== null) {
    const t = m[0]
    // 排除纯数字比例 / 计算式（如 4.4/4.0、100/50）
    if (/^[\d.]+[\\/][\d.]+$/.test(t)) continue
    // 路径需像路径：带扩展名，或至少 2 个分隔符，或以 / ./ ../ 盘符开头（排除 A/B、v2/v3、和/或 这类写法）
    const seps = (t.match(/[\\/]/g) || []).length
    if (seps >= 2 || /\.[A-Za-z0-9]{1,6}$/.test(t) || /^(?:[A-Za-z]:[\\/]|\.{0,2}\/)/.test(t)) add(t)
  }
  RE_GATE_IDENT.lastIndex = 0
  while ((m = RE_GATE_IDENT.exec(s)) !== null) add(m[0])
  return out
}

/**
 * 压缩稿里出现、原文里找不到的标识符。原文比对用「逐字包含」：摘要只截取路径尾段（如 conf.yaml）不算发明。
 * @returns string[]（最多 8 个样本；空数组 = 没有发明）
 */
// 引号 / 空白差异不算发明（v12.4 真机误伤：原文日志 "rawChars":8123，摘要写成 `rawChars:8123`）
const squash = (s) => String(s).replace(/["'`\s]+/g, '')
// v12.7：渲染模板 / 程序门自己的工具接口词（R5 可用句「可以直接当 edit_file 的 old_text」）不是对世界的断言，不算发明。
//   此前只对着原文查 ⇒ 原文没提过 edit_file 的每一份带可用句的稿都被当编造放行（hook-wiring §6 抓到）。
const GATE_ALLOW = new Set(['edit_file', 'old_text', 'new_text', 'read_file', 'NODE_OPTIONS', 'PATH', 'HOME', 'USER', 'SHELL'])
/**
 * v12.8（理论 S8-R8b）：反引号片段前面是「new_text 是 / 改成 / 换成 / 替换为 …」⇒ 这段是要**写入**的新文本，不是对原文的引用。
 * 它天然不是原文子串（否则就不叫改动），按整段查一定报发明；正确的出处判定是**标识符级**：段内的标识符 / 路径必须全部来自原文或观察。
 * oracle I（effect-19）：wrong-model 的 new_text `observe(options, n) { const m = (n && n.model) || … }` 让主模型 3/3 直接 edit——这类稿不能再被整份放行。
 */
export const NEW_TEXT_LEAD_RE = /(?:new_text\s*(?:是|为|=|：|:)|补上|补一句|补|加上|加入|加|改成|改为|换成|替换为|替换成|设为|设成|写成|变成|改写为|改写成|替换成为|改回)\s*$/
/** 文本里按 new_text 引导词标出的反引号段（去重） */
export function newTextSpans(text) {
  const parts = String(text || '').split('`')
  const out = []
  for (let i = 1; i < parts.length; i += 2) {
    const seg = parts[i]
    if (seg.length >= 2 && seg.length <= 300 && !seg.includes('\n') && NEW_TEXT_LEAD_RE.test(parts[i - 1].slice(-12))) out.push(seg)
  }
  return out
}
/**
 * @param src   原文（思维链）
 * @param out   压缩稿
 * @param opts.extra  额外的合法出处：本回合的任务与工具观察（cfg.compressCtx）。逐字锚点 / 落点本来就该来自观察（S8-R5/R7），
 *               观察里有、原文没复述的行不是发明。
 */
export function inventedIdentifiers(src, out, opts = {}) {
  const hay = String(src || '') + (opts && opts.extra ? '\n' + String(opts.extra) : '')
  let sq = null
  // R8b：new_text 段整段豁免（它本来就不在原文里），改查段内标识符——把段内 token 加进待查集合
  const newSpans = new Set()
  for (const sp of newTextSpans(out)) {
    newSpans.add(sp)
    const clean = sp.replace(/^[`'"(]+|[`'"),.:;]+$/g, '')
    if (clean) newSpans.add(clean)
  }
  const inner = new Set()
  for (const sp of newSpans) for (const t of gateTokens(sp)) if (t !== sp) inner.add(t)
  const res = []
  for (const t of [...gateTokens(out)].filter((t) => !newSpans.has(t)).concat([...inner])) {
    if (GATE_ALLOW.has(t)) continue
    if (hay.includes(t)) continue
    const st = squash(t)
    if (st.length >= 3 && (sq ??= squash(hay)).includes(st)) continue
    // 反斜杠 / 正斜杠互换视为同一路径（Windows 原文、POSIX 摘要）
    if (hay.includes(t.replace(/\\/g, '/')) || hay.includes(t.replace(/\//g, '\\'))) continue
    res.push(t)
    if (res.length >= 8) break
  }
  return res
}
