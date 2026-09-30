// 显式原生宿主入口；不接管 plugin、不读任务标签/答案/错误正文、不增加权限。
import { assertEvidenceContract, evidenceDigest, immutableJson } from './evidence-program.js'
import { isEvidenceHost } from './evidence-runtime.js'
const POLICY_SCHEMA = 'cfb.approved-repair-policy/1'
export function freezeApprovedRepairPolicy(def, contract) {
  const c = assertEvidenceContract(contract)
  if (!def || !['fixed', 'posterior'].includes(def.routing) || def.diagnosticMode !== undefined && !['always', 'before-retry'].includes(def.diagnosticMode)) throw new Error('repair-policy')
  const routes = def.routes || {}, minPosterior = def.minPosterior ?? 0.99, maxAttempts = def.maxAttempts ?? 2
  const ids = [def.firstActionId, def.fallbackActionId, ...Object.values(routes)]
  if (ids.some((id) => !c.actions.some((a) => a.id === id && a.type === 'replace')) || Object.keys(routes).some((h) => !/^[\w.-]{1,80}$/.test(h)) ||
    !Number.isFinite(minPosterior) || minPosterior < 0.8 || minPosterior > 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new Error('repair-policy-permission-budget')
  const body = immutableJson({ schema: POLICY_SCHEMA, contractDigest: c.digest, routing: def.routing, firstActionId: def.firstActionId,
    fallbackActionId: def.fallbackActionId, routes, minPosterior, maxAttempts, ...(def.diagnosticMode === 'before-retry' ? { diagnosticMode: def.diagnosticMode } : {}) })
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
function assertPolicy(policy, contract) {
  const { digest, ...def } = policy || {}
  if (def.schema !== POLICY_SCHEMA || evidenceDigest(def) !== digest || freezeApprovedRepairPolicy(def, contract).digest !== digest) throw new Error('repair-policy-drift')
  return policy
}
/** 无外部 result/posterior 注入口：只消费品牌原生宿主的本次 runLatest 返回。
 * 宿主内部 verifier/controller 已验证回执 HMAC；下面继续限定轮次/角色/历史绑定。
 * 任意未知、未落地、恢复失败、冲突/截止/预算即停，不拿诊断作验收。
 */
export function createApprovedRepairEpisode({ host, contract, policy }) {
  const c = assertEvidenceContract(contract), p = assertPolicy(policy, c)
  if (!isEvidenceHost(host) || host.runtime.view().contractDigest !== c.digest) throw new Error('repair-native-host-contract')
  let started = false, busy = false, result = null
  const close = (status, outcomes, publications, decisions) => {
    result = immutableJson({ schema: 'cfb.approved-repair-episode/1', policyDigest: p.digest, solved: outcomes.at(-1)?.ok === true,
      status, outcomes, publications, decisions, counters: host.runtime.view() })
    return result
  }
  const diagnose = (r) => {
    const d = r.diagnostic, receipts = d?.receipts, history = d?.state?.history, prior = d?.state?.prior
    if (!d || d.acceptanceUnchanged !== true || !Array.isArray(receipts) || !receipts.length || !Array.isArray(history) || history.length !== receipts.length || d.state.count !== receipts.length || !prior) return null
    const seen = new Set()
    for (let i = 0; i < receipts.length; i++) {
      const a = receipts[i], b = a.binding, h = history[i]
      if (!['pass', 'fail'].includes(a.status) || c.checks.find((x) => x.id === a.subjectId)?.role !== 'diagnostic' || !b || b.phase !== 'diagnostic' ||
        b.sessionId !== host.sessionId || b.contractDigest !== c.digest || b.programId !== r.state.programId || b.roundId !== r.state.roundId || b.revision !== r.state.revision ||
        seen.has(a.subjectId) || h.receiptId !== a.id || h.checkId !== a.subjectId || h.status !== a.status || h.posteriorApplied !== true) return null
      seen.add(a.subjectId)
    }
    const entries = Object.entries(prior).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), sum = entries.reduce((n, [, value]) => n + value, 0)
    if (!entries.length || entries.some(([, v]) => !Number.isFinite(v) || v < 0 || v > 1) || Math.abs(sum - 1) > 1e-8) return null
    return { hypothesis: entries[0][0], confidence: entries[0][1], tied: entries.length > 1 && Math.abs(entries[0][1] - entries[1][1]) < 1e-8, checks: receipts.length }
  }
  const run = async ({ signal = null } = {}) => {
    if (busy) return immutableJson({ schema: 'cfb.approved-repair-blocked/1', solved: false, status: 'episode-busy' })
    if (started) return immutableJson({ schema: 'cfb.approved-repair-blocked/1', solved: false, status: 'episode-already-run' })
    if (signal !== null && !(signal instanceof AbortSignal)) return immutableJson({ schema: 'cfb.approved-repair-blocked/1', solved: false, status: 'invalid-signal' })
    if (signal?.aborted) return immutableJson({ schema: 'cfb.approved-repair-blocked/1', solved: false, status: 'episode-aborted' })
    started = true; busy = true
    const outcomes = [], publications = [], decisions = []; let actionId = p.firstActionId
    try {
      for (let index = 0; index < p.maxAttempts; index++) {
        if (signal?.aborted) return close('episode-aborted', outcomes, publications, decisions)
        const v = host.runtime.view()
        if (v.busy || v.done || v.repairs >= v.maxRepairRounds || v.rounds >= v.maxRepairRounds || v.rounds >= v.maxRounds || v.checks >= v.maxChecks) return close('runtime-stopped-or-budget', outcomes, publications, decisions)
        const a = c.actions.find((a) => a.id === actionId), command = c.checks.find((x) => a.checks.includes(x.id))?.label || a.checks[0]
        // 从受保护批准动作构造完整工具参数，不从旧稿抽取代码。
        const publication = host.captureDraft({ index, sessionId: host.sessionId, raw: '宿主本地批准策略；无生成模型调用。',
          text: `宿主批准的修复；验收命令是 \`${command}\`。预期：冻结目标通过。`, calls: [{ name: 'edit_file', args: { path: a.path, old_text: a.oldText, new_text: a.newText } }] })
        publications.push(publication)
        if (!publication.authorized) return close('publication-rejected', outcomes, publications, decisions)
        if (signal?.aborted) return close('episode-aborted', outcomes, publications, decisions)
        const retryPossible = index + 1 < p.maxAttempts && v.repairs + 1 < v.maxRepairRounds && v.rounds + 1 < v.maxRepairRounds && v.rounds + 1 < v.maxRounds
        const lean = p.diagnosticMode === 'before-retry'
        const r = await host.runLatest(index, { signal, diagnostics: !lean || retryPossible, stopOnUnknown: lean }); outcomes.push(r)
        if (r.ok === true) return close('verified', outcomes, publications, decisions)
        if (signal?.aborted) return close('episode-aborted', outcomes, publications, decisions)
        if (r.status !== 'rolled-back' || r.restored?.restored !== true || r.recoveryError) return close('recovery-or-runtime-stop', outcomes, publications, decisions)
        if (r.receipts?.some((x) => x.status === 'unknown')) return close('unknown-evidence', outcomes, publications, decisions)
        if (!r.receipts?.some((x) => x.binding.phase === 'action' && x.status === 'pass')) return close('action-not-confirmed', outcomes, publications, decisions)
        if (lean && !retryPossible) return close('repair-budget', outcomes, publications, decisions)
        const diagnosis = diagnose(r)
        if (!diagnosis) return close('unknown-diagnostic', outcomes, publications, decisions)
        if (index + 1 >= p.maxAttempts) return close('repair-budget', outcomes, publications, decisions)
        if (p.routing === 'posterior') {
          if (diagnosis.tied || diagnosis.confidence + 1e-12 < p.minPosterior || !p.routes[diagnosis.hypothesis]) return close('insufficient-posterior', outcomes, publications, decisions)
          actionId = p.routes[diagnosis.hypothesis]
        } else actionId = p.fallbackActionId
        decisions.push({ afterRound: r.state.roundId, route: p.routing, nextActionId: actionId, confidence: diagnosis.confidence, diagnosticChecks: diagnosis.checks })
      }
      return close('repair-budget', outcomes, publications, decisions)
    } catch { return close('host-unavailable', outcomes, publications, decisions) }
    finally { busy = false }
  }
  return Object.freeze({ schema: 'cfb.approved-repair-controller/1', policyDigest: p.digest, run, view: () => immutableJson({ started, busy, result }) })
}
