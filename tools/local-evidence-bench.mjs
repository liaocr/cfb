#!/usr/bin/env node
// 工程 S0 基座 + 三切分有界策略搜索。参考已知/代理自写；不是主模型能力实验。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as I from '../index.js'
import { assertOfflineNamespace } from './verify-offline.mjs'
export const LOCAL_SIGNATURE = I.immutableJson({ taskFamily: 'local-engineering-s0', environment: 'node-local-v1', contractVersion: '1' })
export function localPolicyCandidates() {
  const document = I.createEvidenceDocument({ protected: { kernel: 'evidence-program/1', checks: 'frozen-host', signature: LOCAL_SIGNATURE },
    requiredSections: ['mode'], sections: [{ id: 'mode', text: '{"mode":"idle"}' }] })
  const create = (mode) => {
    const next = mode === 'idle' ? document : I.editEvidenceDocument(document, [{ type: 'replace', id: 'mode', expectedText: '{"mode":"idle"}', text: JSON.stringify({ mode }) }]).document
    return I.createMemoryCandidate({ kind: 'rule', body: next.sections[0].text, signature: LOCAL_SIGNATURE, trigger: { op: 'equals', field: 'failed', value: true },
      sources: ['agent-written-known-reference-local32-v1', 'bounded-document:' + next.id] })
  }
  const idle = create('idle'), unchecked = create('unchecked'), checked = create('checked')
  return { document, idle, unchecked, checked, candidates: [idle, unchecked, unchecked, checked] }
}
export function localRobustSuite(base = I.createLocalEvidenceSuite()) {
  const profiles = ['base', 'format', 'swap']
  return I.freezeEffectSuite({ id: base.id + ':robust', evaluatorVersion: base.evaluatorVersion + ':base-format-swap', ...Object.fromEntries(['train', 'selection', 'test'].map((split) => [split,
    base[split].flatMap((f) => profiles.map((profile) => ({ ...f, id: f.id + ':' + profile, input: { ...f.input, profile } }))) ])) })
}
export async function runLocalEvidenceBench({ store } = {}) {
  const base = I.createLocalEvidenceSuite(), suite = localRobustSuite(base), policy = localPolicyCandidates()
  const evaluateAsync = (candidate, input, signal) => I.executeLocalEvidenceCase(candidate, input, { perturbation: input.profile === 'format' ? 'format' : 'none', observer: input.profile === 'swap' ? 'secondary' : 'primary' })
  const search = await I.runEvidenceSearch({ store, suite, candidates: policy.candidates, evaluateAsync, evaluationScope: sourceDigest() })
  const rows = (id, profile) => search.records.filter((r) => r.candidateId === id && r.fixtureId.endsWith(':' + profile))
  const rate = (items) => ({ n: items.filter((x) => x.output.correct === true).length, total: items.length, unknown: items.filter((x) => typeof x.output.correct !== 'boolean').length })
  const baseline = rows(null, 'base'), selected = rows(policy.checked.id, 'base'), format = rows(policy.checked.id, 'format'), swap = rows(policy.checked.id, 'swap')
  const paired = I.compareEvidencePairs(baseline.map((b) => ({ id: b.fixtureId, before: { action: b.output.actualVerified }, after: { action: selected.find((r) => r.fixtureId === b.fixtureId)?.output.actualVerified } })))
  return I.immutableJson({ schema: 'cfb.local-engineering-validation/1', modelCalls: 0, externalApiCalls: 0, cost: 0,
    corpus: { scenarios: 32, families: 8, split: { train: base.train.length, selection: base.selection.length, test: base.test.length }, authored: 'agent-known-reference', evaluatorCasesWithPerturbation: 96 },
    baseline: rate(baseline), checked: rate(selected), formattingPerturbation: rate(format), evaluatorSwap: rate(swap),
    observerAgreement: { n: search.records.filter((r) => r.output.agreement === true).length, total: search.records.length },
    runtimeCases: search.records.length, loopbackRequests: search.records.reduce((n, r) => n + (r.output.loopbackRequests || 0), 0), localOracleProcesses: search.records.reduce((n, r) => n + (r.output.localOracleProcesses || 0), 0),
    rejectedUnchecked: search.screened.find((r) => r.candidateId === policy.unchecked.id)?.gate || null,
    acceptedChecked: search.activeIds.includes(policy.checked.id), recurrentIssues: search.issues.filter((x) => x.count > 1).length,
    paired, search, limitations: ['严格策略对保守无行动基线的改善只证明工程控制链。', '两个观察器共享同一已知参考，是不同实现，不是独立人写/不可泄露的泛化证据。',
      '生成器没有外部 API 调用；搜索限于宿主批准的三个本地 mode，不能任意改仓库/判据/旧提示词。', 'test 在固定候选并持久预占后才执行；扰动扩展也计入 gate，任一负项/unknown 都拒绝。',
      '缺失模型答案全部 unknown；没有 forced answering/QAEval/LLM 因果重要性或白盒训练。'] })
}
function sourceDigest() {
  const files = ['src/local-evidence.js', 'src/evidence-search.js', 'src/evidence-context.js', 'src/evidence-intents.js', 'src/evidence-runtime.js', 'src/evidence-program.js', 'src/evidence-host.js', 'src/evidence-checkpoint.js', 'src/evidence-store.js', 'src/effect-archive.js', 'tools/local-evidence-bench.mjs']
  return I.evidenceDigest(files.map((p) => [p, fs.readFileSync(p, 'utf8')]))
}
async function main(argv) {
  if (argv.length) throw new Error('本工具无在线/重用盲测开关；请用 node tools/verify-offline.mjs --lab')
  const isolation = assertOfflineNamespace(), directory = path.resolve('.cfb-runtime/local-evidence/library')
  const store = I.createEvidenceStore({ directory, sessionId: 'local-engineering-library-v1' }), head = store.readHead('local-report'), source = sourceDigest()
  let report, cached = false
  if (head) {
    const saved = store.getJson(head.ref, { kind: 'local-report' })
    if (saved.sourceDigest !== source) throw new Error('已有盲测报告的源码版本不同；拒绝在已消耗任务族上重新搜索。请先核对新语料/版本，不能仅改 cycle id。')
    report = saved.report; cached = true
  } else {
    report = await runLocalEvidenceBench({ store })
    const ref = store.putJson({ sourceDigest: source, report }, { kind: 'local-report' }); store.setHead('local-report', ref, { expectedRevision: null })
  }
  fs.mkdirSync('.cfb-runtime/local-evidence', { recursive: true }); fs.writeFileSync('.cfb-runtime/local-evidence/report.json', JSON.stringify(report, null, 2) + '\n')
  const { search, paired, ...summary } = report
  console.log(JSON.stringify({ ...summary, paired: { answerUnchanged: paired.answerUnchanged, actionChanged: paired.actionChanged }, search: { counters: search.counters, finalGate: search.final.map((x) => x.gate), activeIds: search.activeIds, issues: search.issues.length }, isolation, cachedReportReplay: cached, reportPath: '.cfb-runtime/local-evidence/report.json' }, null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => { console.error(e.stack); process.exitCode = 1 })
