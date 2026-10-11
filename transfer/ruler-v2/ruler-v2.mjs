// 尺子 v2（2026-10-11，$0 候选，固定规则，不读结局标签）
// 只读 raw / ctx / draft。适用：raw >= 3100 字符（生产区间）。
// R1 动作依据保留：raw 末 300 字符中的代码式标识符（不在 ctx 中），在 draft 中以原样子串出现的比例 >= TAU（固定 0.8，不下调）。无 R1 事实 ⇒ 不过。
// G2 凭空主张：draft 反引号里的路径/标识符，必须是 raw∪ctx 的子串；有一个不在即不过。
// G3 压缩率：len(draft)/len(raw) <= 0.5。
// 注意：R1 / G2 / G3 是可复算的代理，不是真机成功的证明（见 README.md）。
export const TAU = 0.8
export const RATIO_MAX = 0.5
export const TAIL = 300
export const MIN_RAW = 3100

export function norm(t) {
  return t.normalize('NFKC').toLowerCase()
}
export function tokens(t) {
  return norm(t).split(/[^a-z0-9]+/).filter(Boolean)
}
// 代码式标识符：含 / . _ 或驼峰，或反引号包裹；长度 >= 4；取自 raw 末 TAIL 字符，且不在 ctx 中。
// （修订 1，2026-10-11，在任何结局验证之前：首版误取英文散文词，见 README.md）
const IDENT = /[A-Za-z_][\w]*[._/-][\w./-]*|[a-z]+[A-Z]\w*|\b[A-Za-z]\w*_\w+\b/g
export function tailIdentifiers({ raw, ctx = '' }) {
  const tail = raw.slice(-TAIL)
  const out = new Set()
  for (const m of tail.matchAll(IDENT)) { const w = m[0].replace(/[.,;:)]+$/, ''); if (w.length >= 4) out.add(w) }
  for (const m of tail.matchAll(/`([^`\n]{2,120})`/g)) out.add(m[1].trim())
  return [...out].filter((w) => !ctx.includes(w))
}
export function backticked(draft) {
  return [...draft.matchAll(/`([^`\n]{2,120})`/g)].map((m) => m[1]).filter((x) => x.includes('/') || x.includes('.') || x.includes('_') || /[a-z][A-Z]/.test(x))
}
export function ruler(row, { tau = TAU } = {}) {
  const raw = row.raw || '', ctx = row.ctx || '', draft = row.draft || ''
  if (raw.length < MIN_RAW) return { applies: false }
  const A = tailIdentifiers({ raw, ctx })
  const hit = A.filter((w) => draft.includes(w)).length
  const recall = A.length ? hit / A.length : 0
  const src = norm(raw + ctx)
  const invented = backticked(draft).filter((x) => !src.includes(norm(x)))
  const ratio = draft.length / raw.length
  const R1 = A.length >= 1 && recall >= tau
  const G2 = invented.length === 0
  const G3 = ratio <= RATIO_MAX
  return { applies: true, pass: R1 && G2 && G3, R1, G2, G3, aN: A.length, recall: +recall.toFixed(3), invented: invented.length, ratio: +ratio.toFixed(3) }
}
