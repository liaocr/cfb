// dsh-cot-form-b / rules.js —— 类型契约
//
// ⛔ 本文件描述的是 2026-09-17 之后的新法：纯规则**只允许**做
//   ① 字面逐字去重  ② 连续同构空环折叠，外加 ③ 实体保活护栏。
//   默认策略 **Keep by default**：不认识的句子一律保留。
//
// ⛔ 已被真机实测证明有害并连根拔除：
//   · 逆向支配剪枝（把 ACTION 口头禅当结论，删掉它之前的全部斟酌）
//   · 话语角色状态机 + 话题去重（DELIBERATION 是 return 兜底 ⇒ 不认识的可删）
//   · 会话级 df 表（df 参数已废弃，传入会被忽略）
//
// ⚠ 认知等级（写在这里防止被误引）：
//   · 旧版报的 50.5% 削减里，49.8% 来自逆向支配剪枝，真正的去重+折叠只有 0.7%。
//   · 新版在 6 个真实归档 CoT（30730 字符）上实测 **2.45%**，受保护 token 召回 100%。
//   · 削减率不是保真度指标。任何裁剪的验收判据都是 `tokenRecall`，不是 `savingPct`。

export interface RuleCompressOptions {
  /** 游程折叠：连续 ≥3 行同构「已验证 OK」折成区间断言。默认 true */
  foldRuns?: boolean
  /** 逐字重复行只留第一次出现处。默认 true */
  dropDuplicateLines?: boolean
  /** @deprecated 随角色状态机一并移除，传入会被忽略。 */
  df?: Map<string, number>
}

export interface RuleCompressStats {
  rawChars: number
  outChars: number
  savedChars: number
  savingPct: number
  /** true = 规则没赚到（或会增肥）⇒ `out` 就是原文，两个计数此时为 0 */
  noGain?: boolean
  skipped?: string
  /** 实际生效的删行数（noGain 时为 0） */
  dupLinesDropped?: number
  /** 实际生效的折叠行数（noGain 时为 0） */
  okRunsFolded?: number
  /** noGain 时才会出现：本来能删/能折多少（候选量，未生效） */
  candidateDupLines?: number
  candidateOkRuns?: number
  /** 保真度门禁拒发的原因（'fidelity-gate-dedup' | 'fidelity-gate-fold'） */
  refused?: string
  /** 原文里受保护 token 总数 */
  protectedTokens?: number
  /** 丢掉的受保护 token 数。**必须为 0**，否则整次削减作废 */
  lostTokens?: number
  /** 受保护 token 召回率（%）。**门禁要求必须 = 100** */
  tokenRecall?: number
  /** 丢失样本（最多 6 个），用于事后尸检 */
  lostSample?: string[]
}

/**
 * 纯规则压缩。**同步**、零网络、零 await。
 *
 * ⛔ 两道硬门禁：
 *   ① 永不增肥：`out.length >= 输入长度` ⇒ 原样返回并置 `noGain`。
 *   ② 实体保活：任何受保护 token 会丢 ⇒ 原样返回并置 `refused`。
 */
export declare function compressByRules(
  text: string,
  opts?: RuleCompressOptions,
): { out: string; stats: RuleCompressStats }

/** 抽出一段文本里全部受保护 token（句柄/路径/数字/引号原话/标识符/中文短语）。 */
export declare function protectedTokens(text: string): Set<string>

/** 这一行是否含受保护 token。 */
export declare function hasProtected(text: string): boolean

/**
 * 保真度核算。
 * @param allowedRanges 允许丢失的数字开区间 [首,尾]——只给**已证明可推导**的折叠区间。
 */
export declare function fidelity(
  src: string,
  out: string,
  allowedRanges?: Array<[number, number]>,
): { lost: string[]; stats: RuleCompressStats }
