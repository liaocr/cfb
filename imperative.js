/**
 * 祈使/禁止句式探测器（纯函数，零依赖）。
 *
 * ⛔ 本模块**只判不改**，绝不修改输入的一个字符。这是设计约束，不是偷懒。
 *
 * 为什么不做正则改写（红队方案第 2 步的原样实现已被证伪，反例钉在
 * imperative.selftest.mjs 的「红队正则反例」一节）：
 *
 *   红队规则                                   输入                输出
 *   ---------------------------------------  ------------------  --------------------------------
 *   /不再做/g              → '已完成'          "不再做任何修复动作" "已完成任何修复动作"      ← 语义反转
 *   /不要(.{0,20})/g       → '[historical…] $1 已废弃'  "不要删除会话文件" "[historical_falsified] 删除会话文件 已废弃" ← 发明事实
 *   /禁止(.{0,20})/g       → '曾评估 $1 不可行'  "禁止在未读 trace 前下结论" "曾评估 在未读 trace 前下结论 不可行"   ← 把规则降格成一次评估
 *
 * 三类损害都是硬红线：
 *   ① 发明事实（把"未做的事"写成"已完成"）⇒ 违反「认知等级必须标」；
 *   ② 反转语义 ⇒ 违反「不丢：搬走可以、剃短可以、删除不行」；
 *   ③ 摧毁「否决」本身的强制力 —— 那道力正是 2026-09-17 拔电止血的防线
 *      （cordis.patch.yml:139：纯规则反向支配剪枝把 49.8% 的缩减建立在定向删除事实上）。
 *
 * ⇒ 分工：**语义改写交给蒸馏提示词（LLM 干语义），代码只做裁判。**
 *    判出祈使就 fail-closed（D3′ 保持原文 / 或重试一次），绝不伪造、绝不静默改写。
 *
 * @module dsh-cot-form-b/imperative
 */

/** 高精度祈使标记。宁可漏报（漏报=多留一条祈使，可观测），不可误报（误报=白扔一次压缩）。 */
export const IMPERATIVE_RULES = Object.freeze([
  { id: 'prohibit', src: '禁止|严禁|不许|不得|切勿|停止|勿重试|请勿', note: '禁止/否决类祈使' },
  { id: 'require',  src: '必须|务必|应当|应该|一定要',                note: '强制类祈使' },
  { id: 'negimp',   src: '不要|别再|不再做|不必再',                    note: '否定祈使' },
  { id: 'nextstep', src: '下一步|接下来|待办|接着做|随后就',            note: '行动指令' },
  { id: 'second',   src: '你|您',                                      note: '第二人称直呼' },
])

function compile(src) { return new RegExp(src, 'g') }

/**
 * 找出全部祈使命中。**不修改任何字符。**
 * @returns { count, ids, hits: [{ id, token, index }] }
 */
export function findImperatives(text) {
  const s = typeof text === 'string' ? text : ''
  const hits = []
  const ids = new Set()
  if (!s) return { count: 0, ids: [], hits }
  for (const rule of IMPERATIVE_RULES) {
    const re = compile(rule.src)
    let m
    while ((m = re.exec(s)) !== null) {
      hits.push({ id: rule.id, token: m[0], index: m.index })
      ids.add(rule.id)
      if (m.index === re.lastIndex) re.lastIndex++   // 零宽兜底，防死循环
      if (hits.length >= 500) break
    }
  }
  hits.sort((a, b) => a.index - b.index)
  return { count: hits.length, ids: [...ids].sort(), hits }
}

/** 一句话判定，供 trace/gate 使用。 */
export function verdictOf(text) {
  const r = findImperatives(text)
  return { verdict: r.count === 0 ? 'clean' : 'imperative', count: r.count, ids: r.ids }
}

/**
 * ⛔ 明确不提供 sanitize()/rewrite()。若将来确需改写，必须满足：
 *   ① 改写结果与原文可逐条对账（可审计）；
 *   ② 任何不确定的命中一律放弃改写（fail-closed）；
 *   ③ 有单测证明"未做的事"绝不会被写成"已完成"。
 */
export const REWRITE_WITHHELD = 'see module docs: regex rewriting is refuted; semantics belong to the distill prompt'
