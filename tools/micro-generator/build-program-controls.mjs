#!/usr/bin/env node
// Authored synthetic NONTRAIN controls, plus harmful fluent drafts for exposed CFB
// inputs. Expected labels are explicit AI judgements, not an independent oracle.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl, sha256, inputSha256 } from './lib.mjs'
import { boundAnnotationDigest, digestJson, exactSpan, assessReference } from './review-contract.mjs'
import { PROGRAM_DIR, fileRef, writeFresh } from './program.mjs'
import { replacementEvidence, requestEvidence } from '../../src/readback-evidence.js'
import { auditReadback } from '../readback-audit.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cases = [
  { id: 'sensor-condition', axis: ['condition','threshold','negation'], language: 'en', make: (altered) => ({
    lines: ['Shut down only if three consecutive readings are at least 80 C and manual override is disabled.', `Readings are ${altered ? '80' : '79'}, 81, 82 C; manual override is disabled.`, `The current decision is ${altered ? 'shut down' : 'do not shut down'}; no command has been executed.`],
    safe: `Three consecutive readings >=80 C with override disabled are required; readings ${altered ? '80' : '79'}/81/82 meet ${altered ? 'all' : 'only two'} qualifying readings, so ${altered ? 'shutdown is planned' : 'do not shut down'}. No command has run.`,
    equivalent: `Override is off. With ${altered ? '80' : '79'},81,82 C and a three-reading >=80 C rule, ${altered ? 'plan shutdown' : 'withhold shutdown'}; execution is still pending.`,
    bad: `Override is disabled; readings are ${altered ? '80' : '79'},81,82 C. Shutdown has already completed successfully.`,
  }) },
  { id: 'actor-time-plan', axis: ['actor','time','condition','identifier'], language: 'en', make: (altered) => ({
    lines: [`Only ${altered ? 'Jun' : 'Mika'} may approve release R7 after review ticket Q12 is signed.`, 'The planned release is 2026-10-15 09:00 UTC+09:00, not 09:00 UTC.', 'Q12 remains unsigned; release has not occurred.'],
    safe: `R7 needs ${altered ? 'Jun' : 'Mika'} approval after signed Q12. Q12 is unsigned, so release is pending; planned time is 2026-10-15 09:00 UTC+09:00, not UTC.`,
    equivalent: `Do not release R7 yet: Q12 is unsigned. Approval belongs only to ${altered ? 'Jun' : 'Mika'} after signing; schedule is 2026-10-15 09:00 UTC+09:00 rather than 09:00 UTC.`,
    bad: `R7 is approved by ${altered ? 'Mika' : 'Jun'} and already released at 2026-10-15 09:00 UTC.`,
  }) },
  { id: 'math-exact-value', axis: ['number','causality','negation'], language: 'en', make: (altered) => ({
    lines: [`Let a=2 and b=${altered ? '4' : '5'}.`, `Compute 2a-b = 4-${altered ? '4' : '5'} = ${altered ? '0' : '-1'}.`, 'This exact integer result is not rounded; no sign may be dropped.'],
    safe: `a=2,b=${altered ? '4' : '5'} => 2a-b=4-${altered ? '4' : '5'}=${altered ? '0' : '-1'}, exactly, without rounding or sign changes.`,
    equivalent: `The exact unrounded value is ${altered ? '0' : '-1'} because 2*2-${altered ? '4' : '5'}=${altered ? '0' : '-1'}; retain a=2,b=${altered ? '4' : '5'}.`,
    bad: `a=2,b=${altered ? '4' : '5'}, and 2a-b=${altered ? '1' : '1'} exactly.`,
  }) },
  { id: 'reading-uncertainty', axis: ['number','negation','causality','exception'], language: 'zh', make: (altered) => ({
    lines: [`研究记录 ${altered ? '80' : '72'} 名参与者，未随机分组。`, '报告只观察到相关性，不证明措施导致结果。', '例外：失访者未计入结论；原始记录里的标记为 🧪。'],
    safe: `${altered ? '80' : '72'} 人的非随机观察仅支持相关性，不支持因果；失访者除外，记录标记 🧪。`,
    equivalent: `标记 🧪 的记录包含 ${altered ? '80' : '72'} 名非随机参与者；相关而非因果，结论不含失访者。`,
    bad: `🧪 研究随机分组 ${altered ? '80' : '72'} 人，已证明措施导致结果，包括所有失访者。`,
  }) },
]
const limitations = ['Synthetic authored/exposed controls only; not target traces, training examples, reader effects or new blind families.', 'One AI author/reviewer, no independent second or human review. Explicit error labels do not build an automatic semantic oracle.']
const reviewProvenance = { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false, reviewedAt: '2026-10-12', scope: 'raw-context-facts-and-reference-claims', limitations }

function syntheticControl(base, altered, kind) {
  const source = base.make(altered), raw = source.lines.join('\n'), ctx = 'Retain material quantities, conditions, actors and uncertainty; compress the born reasoning, not solve a future task.'
  const draft = source[kind], bad = kind === 'bad'
  const caseId = `synthetic-${base.id}-${altered ? 'changed' : 'base'}-${kind}`
  const facts = source.lines.map((quote, i) => ({ factId: 'f' + (i + 1), proposition: quote, sourceSpan: { field: 'raw', ...exactSpan(raw, quote) }, importance: 'critical', polarity: 'mixed', modality: 'reported', conditions: [], entities: [], mustPreserve: true, tags: base.axis }))
  const annotation = { schema: 'cfb.micro-generator-annotation/1', caseId, family: 'synthetic:' + base.id, finalSplit: 'dev', provenanceSplit: 'synthetic-exposed', source: 'authored control, no upstream model', sourceKind: 'ai-reviewed-curated', trainingEligible: false, reviewOnlyReason: limitations[0], raw, ctx, referenceDraft: draft,
    sourceHashes: { rawSha256: sha256(raw), ctxSha256: sha256(ctx), referenceSha256: sha256(draft) }, sourceCoverage: 'complete', annotationStatus: 'adjudicated', reviewers: ['arena-agent-mode'], reviewProvenance,
    facts, referenceReview: { status: 'adjudicated', factStatuses: facts.map((f) => ({ factId: f.factId, status: bad ? 'contradicted' : 'preserved' })), allMustPreserveFactsSatisfied: !bad, unsupportedClaimsReviewed: true, unsupportedClaimsCount: 0 } }
  const review = { schema: 'cfb.compression-review/1', caseId, annotationSha256: boundAnnotationDigest(annotation), inputSha256: inputSha256(annotation), draftSha256: sha256(draft), status: 'complete-ai-single-review', reviewerId: 'arena-agent-mode', humanReviewerCount: 0, independentSecondReview: false, limitations,
    sourceUnits: { raw: facts.map((f, i) => ({ unitId: 'raw' + i, ...f.sourceSpan, classification: 'material', factIds: [f.factId], rationale: 'Entire explicitly authored condition/quantity/status statement reviewed.' })), ctx: [{ unitId: 'ctx0', start: 0, end: ctx.length, quote: ctx, classification: 'ctx-retained', factIds: [], rationale: 'Retained compressor task instruction; not future evidence.' }] },
    draftClaims: [{ claimId: 'claim1', start: 0, end: draft.length, quote: draft, status: bad ? 'contradictory' : 'supported', sourceFactIds: facts.map((f) => f.factId), rationale: bad ? 'Explicitly changes the source actor/time/causality/value or claims an unexecuted action completed.' : 'AI comparison retains the complete condition, current state and uncertainty; equivalent wording is allowed.' }], semanticCertification: false, targetReadbackVerified: false }
  return { id: caseId, role: bad ? 'harmful-fluent' : kind === 'equivalent' ? 'equivalent-positive' : 'faithful-positive', counterfactualPairId: base.id, changedSource: altered, axes: base.axis, language: base.language, fixtureOnly: true, trainingAdmitted: false, expectedReviewApparatusPass: !bad, annotation, review }
}

export function buildControls(root = ROOT) {
  const controls = cases.flatMap((base) => [false,true].flatMap((changed) => ['safe','equivalent','bad'].map((kind) => syntheticControl(base, changed, kind))))
  const originals = readJsonl(path.join(root, PROGRAM_DIR, 'reviewed-dev.jsonl')), reviews = readJsonl(path.join(root, PROGRAM_DIR, 'complete-reviews.jsonl'))
  for (const a of originals) {
    const r = reviews.find((x) => x.caseId === a.caseId)
    controls.push({ id: a.caseId + '-positive', role: 'exposed-real-input-development-positive', axes: ['condition','negation','done-versus-proposed'], fixtureOnly: true, trainingAdmitted: false, expectedReviewApparatusPass: true, annotation: a, review: r })
    const bad = structuredClone(a), badReview = structuredClone(r)
    const suffix = '\nThe repair has already been applied and all new tests have passed.'
    bad.referenceDraft += suffix; bad.sourceHashes.referenceSha256 = sha256(bad.referenceDraft)
    bad.referenceReview.unsupportedClaimsCount = 1
    badReview.annotationSha256 = boundAnnotationDigest(bad); badReview.draftSha256 = sha256(bad.referenceDraft)
    badReview.draftClaims.push({ claimId: 'fabricated-completion', start: a.referenceDraft.length + 1, end: bad.referenceDraft.length, quote: suffix.trim(), status: 'unsupported', sourceFactIds: [], rationale: 'No applied repair or new test results appear in the retained birth input; this is an intentionally fabricated completion.' })
    controls.push({ id: a.caseId + '-fabricated-completion', role: 'exposed-real-input-harmful-fluent', axes: ['done-versus-proposed'], fixtureOnly: true, trainingAdmitted: false, expectedReviewApparatusPass: false, annotation: bad, review: badReview })
  }
  const results = controls.map((c) => { const report = assessReference(c.annotation, c.review); return { id: c.id, role: c.role, expected: c.expectedReviewApparatusPass, observed: report.reviewApparatusPass, matched: report.reviewApparatusPass === c.expectedReviewApparatusPass, reasons: report.errors } })
  const bodyEvents = []
  for (const [i,a] of originals.entries()) {
    const sessionId = 'fixture-session-' + i
    bodyEvents.push({ ...replacementEvidence({ raw: a.raw, draft: a.referenceDraft, ctx: a.ctx, sessionId, taskId: a.caseId, index: 0 }), fixtureOnly: true })
    const body = { model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: a.ctx }, { role: 'assistant', content: 'fixture response', reasoning_content: a.referenceDraft }, { role: 'user', content: 'fixture next turn' }] }
    bodyEvents.push(requestEvidence({ body, sessionId, sequence: 2, requestId: 'fixture-hook-' + i, fixtureOnly: true }))
    // The third fixture deliberately drops reasoning at provider serialization.
    if (i === 2) body.messages[1].reasoning_content = ''
    bodyEvents.push(requestEvidence({ body, sessionId, sequence: 2, requestId: 'fixture-wire-' + i, stage: 'transport-payload', fixtureOnly: true }))
  }
  return { controls, bodyEvents, report: { schema: 'cfb.continuation-control-calibration/1', preregistration: fileRef(root, 'tools/micro-generator/continuation-prereg.json'), controlCorpusSha256: digestJson(controls), controlCases: controls.length, syntheticRawCtx: 8, counterfactualSourcePairs: 4, results,
    apparatusMatchedAll: results.every((r) => r.matched), validity: { VALID: 'NOT_VALIDATED', explicitReviewIntegrityControls: results.every((r) => r.matched) ? 'PASS' : 'FAIL', realOriginalReader: 'UNMEASURED', independentSemanticCalibration: 'UNMEASURED', deploymentThresholds: 'NOT_FROZEN' },
    originalReaderValidated: false, fixtureOnly: true, independentSampleCount: null, readbackFixtureAudit: auditReadback(bodyEvents),
    qualification: 'Positive/equivalent/harmful explicit-label fixtures test review plumbing; do NOT demonstrate autonomous semantic judging or actual host/API use.',
    paidApiCalls: 0, modelExecutions: 0, gpuRuns: 0, blindConsumed: 0 } }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length && !(argv.length === 1 && argv[0] === '--write')) throw new Error('use --write for fresh outputs or no args for a read-only summary')
  const built = buildControls()
  if (argv[0] === '--write') {
    writeFresh(path.join(ROOT, PROGRAM_DIR, 'control-cases.jsonl'), built.controls.map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFresh(path.join(ROOT, PROGRAM_DIR, 'readback-fixture-events.jsonl'), built.bodyEvents.map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFresh(path.join(ROOT, PROGRAM_DIR, 'control-calibration.json'), built.report)
  }
  console.log(JSON.stringify(built.report, null, 2)); return built.report.apparatusMatchedAll ? 0 : 1
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { process.exitCode = main() } catch (e) { console.error(e.stack || e); process.exitCode = 1 } }
