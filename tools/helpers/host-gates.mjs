// tools/helpers/host-gates.mjs —— v14.13（DSH 合并 P2）：宿主层事件门禁（Dynamic Event Gates）的 bugfix 场景一般化。
//   来源：DSH router-bootstrap-v1.mjs v4.3「动态近场门禁」—— GATE 1 冒烟（刚 write 完、还没验证 ⇒ 先验证）、GATE 2 批量合并（连续碎片 edit ⇒ 合并写入）。
//   DSH 的记录（SESSION-NOTES 附录 D，dea48c68）：GATE1×2、GATE2×3 全部触发且模型照做 —— 用户态近场的祈使句 flash 会服从；
//   cfb 的记录（t8/t9）：同样的意思放进助手态思维链槽位（稿）它不理。本模块把「通道」当变量：门禁文本以 user 角色、紧贴最新工具结果注入。
//   三条规则都只看宿主能算的事实（调用序列 / 编辑 / 验证命令 / 最终宣称），不看思维链，不含任何题目知识：
//     act    行动门禁：读过源文件 + 同一诊断/验证命令 ≥2 次 + 至今 0 次修改 + 最近两轮仍在只读 ⇒ 「做一次可逆修改并验证，别再找证据」（t8/t9 缺的那一句）
//     batch  合并门禁：连续两轮各有修改、中间没验证 ⇒ 「推导完整后一次合并写入，再验证」（= DSH GATE 2）
//     verify 验证门禁：最终回复宣称修好、但最后一次修改之后没跑过验证命令 ⇒ 不收最终回复，先验证（= DSH GATE 1 的收尾形态；直指 claimJustified）
//   幂等：同一触发轮只注入一次；act 两轮内不重复；verify 整条轨迹最多一次（第二次宣称就收，免得无限催）。
export const GATE_HEAD = '[宿主门禁] 这不是用户输入，不要把它当作新的请求，也不要为它单独回复；它只是宿主对当前轨迹状态的提示。'
export const GATE_TEXTS = {
  act: GATE_HEAD + '\n检测到：你已经读过源文件、至少两次运行了同一条诊断或验证命令，但到现在还没有做任何修改。在这个仓库里修改是可逆的，验证只需一条命令——现在就把你最可能的修复改进去，然后重新运行验证命令来确认或推翻它，不要继续寻找更多证据。如果你认为还缺一条非拿到不可的证据，写明它是什么、哪条命令能拿到，并在这一轮里发出那条命令。',
  batch: GATE_HEAD + '\n检测到：连续两轮都在做零散修改、中间没有验证。请先在思考里把剩余的修改一次推导完整，下一次工具调用一次合并写入，然后运行验证命令。',
  verify: GATE_HEAD + '\n检测到：你宣称问题已经修好，但最后一次修改之后没有运行过验证命令。先运行验证命令，再给出结论。',
}
export const GATE_KINDS = Object.keys(GATE_TEXTS)

const normCmd = (s) => String(s || '').replace(/\s+/g, ' ').trim()
// 命令同一性（比 traj-run 的 repeats 口径松一点）：去掉开头的 `cd … &&`、末尾的重定向，再比；t8/t9 里同一条 analyze-trace 被 `cd /tmp &&` 包了一层就不算重复了
const cmdKey = (s) => normCmd(s).replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').replace(/\s*(?:2>&1|2>\/dev\/null|>\/dev\/null|\|\s*head(?:\s+-n?\s*\d+)?|\|\s*tail(?:\s+-n?\s*\d+)?)\s*$/g, '').trim()
const TRIVIAL_RE = /^(?:ls|pwd|cd|echo|true|tree|git status)\b/
const SRC_READ_RE = /(?:^|[\s'"])(?:\.\/)?(?:src|lib)\/[\w./-]+/

/** 从轨迹器的逐轮记录算门禁状态（零 API）：rows = [{ round, calls: [{ name, args(object) }] }]，edits = rec.edits，verifyRe = task.verifyRe。 */
export function gateState(rows, { edits = [], verifyRe = null } = {}) {
  const cmdCount = new Map(); let readSrc = false, verifySeenRound = null, inspectSinceVerify = 0
  const perRound = rows.map((t) => {
    let editCalls = 0, verifyCalls = 0, readCalls = 0
    for (const c of t.calls || []) {
      const a = c.args && typeof c.args === 'object' ? c.args : {}
      if (c.name === 'edit_file' || (c.name === 'str_replace_editor' && ['str_replace', 'insert', 'create'].includes(a.command))) editCalls++
      else if (c.name === 'read_file' || (c.name === 'str_replace_editor' && a.command === 'view')) { readCalls++; if (SRC_READ_RE.test(String(a.path || ''))) readSrc = true }
      else if (c.name === 'bash') {
        const k = normCmd(a.command); readCalls++
        if (!TRIVIAL_RE.test(k)) { const ck = cmdKey(k); cmdCount.set(ck, (cmdCount.get(ck) || 0) + 1) }
        if (SRC_READ_RE.test(k) && /(?:^|[;&|]\s*)(?:cat|sed -n|head|tail|grep|rg|nl|less|more)\b/.test(k)) readSrc = true
        if (verifyRe && verifyRe.test(k)) { verifyCalls++; if (verifySeenRound == null) verifySeenRound = t.round }
      }
    }
    // 验证命令第一次跑过之后的「只看不改」调用数（t8：第 3 轮数据齐了，第 4–8 轮 17 个调用全在找源码）
    if (verifySeenRound != null && t.round >= verifySeenRound) inspectSinceVerify += (t.calls || []).length - editCalls
    return { round: t.round, editCalls, verifyCalls, readCalls }
  })
  const okEdits = edits.filter((e) => e.ok)
  const lastOkEditRound = okEdits.length ? Math.max(...okEdits.map((e) => e.round)) : null
  const verifiedAfterLastEdit = lastOkEditRound != null && perRound.some((p) => p.round >= lastOkEditRound && p.verifyCalls > 0 && (p.round > lastOkEditRound || rowsVerifyAfterEdit(rows, lastOkEditRound, verifyRe)))
  return { perRound, readSrc, repeatedCmd: Math.max(0, ...cmdCount.values()), verifySeenRound, inspectSinceVerify, okEdits: okEdits.length, lastOkEditRound, verifiedAfterLastEdit }
}
// 同一轮里「先 edit 后验证」也算验证过（与 traj-run 的 verifiedAfterFix 口径一致：按调用顺序）
function rowsVerifyAfterEdit(rows, round, verifyRe) {
  const t = rows.find((x) => x.round === round); if (!t || !verifyRe) return false
  let seenEdit = false
  for (const c of t.calls || []) { const a = c.args && typeof c.args === 'object' ? c.args : {}; if (c.name === 'edit_file' || (c.name === 'str_replace_editor' && ['str_replace', 'insert', 'create'].includes(a.command))) seenEdit = true; else if (seenEdit && c.name === 'bash' && verifyRe.test(normCmd(a.command))) return true }
  return false
}

/** 本轮工具结果之后该不该注入门禁：返回 'act' | 'batch' | null。gated = 已注入过的 [{ round, kind }]。 */
export function gateAfterTools(rows, { edits = [], verifyRe = null, gated = [], round, maxRounds = Infinity } = {}) {
  if (!rows.length || round >= maxRounds) return null   // 最后一轮之后没有下一轮读它
  const st = gateState(rows, { edits, verifyRe })
  const cur = st.perRound[st.perRound.length - 1], prev = st.perRound[st.perRound.length - 2]
  // batch：连续两轮各有修改、两轮里都没验证
  if (prev && cur.editCalls > 0 && prev.editCalls > 0 && cur.verifyCalls === 0 && prev.verifyCalls === 0 && !gated.some((g) => g.kind === 'batch' && g.round === round)) return 'batch'
  // act：0 次成功修改 + 读过源文件 + 最近两轮都只读 + 两轮内没催过，且满足其一：
  //   (i) 验证命令已跑过、之后又只看不改 ≥4 个调用、第 ≥4 轮（t8/t9 的真实签名：数据第 3 轮就齐了，后面全在找证明，一条命令都不重复）
  //   (ii) 同一条命令（去 cd / 重定向后）≥2 次、第 ≥3 轮（原地打转）
  //   v14.13.1：第一版只有 (ii)，对 t6–t9 与 traj1–3 全部 29 条轨迹零 API 回放一次都没触发 —— 规则写的是我想象的失败，不是记录里的失败。
  const inspectHeavy = st.verifySeenRound != null && round >= 4 && st.inspectSinceVerify >= 4
  const spinning = st.repeatedCmd >= 2 && round >= 3
  if (st.okEdits === 0 && st.readSrc && (inspectHeavy || spinning) && cur.editCalls === 0 && prev && prev.editCalls === 0 && !gated.some((g) => g.kind === 'act' && round - g.round < 2)) return 'act'
  return null
}
/** 模型给出最终回复（无调用）时：宣称修好却没在最后一次修改后验证 ⇒ 'verify'，否则 null。整条轨迹只催一次。 */
export function gateOnFinal(rows, { edits = [], verifyRe = null, gated = [], claim = null, round, maxRounds = Infinity } = {}) {
  if (claim !== 'fixed' || round >= maxRounds || gated.some((g) => g.kind === 'verify')) return null
  const st = gateState(rows, { edits, verifyRe })
  if (st.okEdits > 0 && !st.verifiedAfterLastEdit) return 'verify'
  return null
}
