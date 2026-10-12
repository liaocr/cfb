#!/usr/bin/env node
// AI-authored review specifications for three already-exposed inputs, after reading
// their complete retained raw and ctx. Only offsets/hashes/serialization are automated.
// No teacher API, no reader outcome, no human/independent review and no train admission.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl, sha256, inputSha256, stableCaseId } from './lib.mjs'
import { boundAnnotationDigest, exactSpan, validateCompleteReview } from './review-contract.mjs'
import { PROGRAM_DIR, writeFresh } from './program.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const QUEUE = 'transfer/models/micro-generator-review-queue.jsonl'

// f(quote, proposition, mustPreserve, tags, modality, polarity).
const f = (quote, proposition, mustPreserve = true, tags = [], modality = 'reported', polarity = 'positive') => ({ quote, proposition, mustPreserve, tags, modality, polarity })
const SPECS = [
  {
    parent: 'flaky-timeout-445555c31e8f51b1',
    facts: [
      f('primaryDelayMs=1500, hedgeAfterMs=1600', 'The source test uses primaryDelayMs=1500 and hedgeAfterMs=1600.', true, ['number','threshold']),
      f('So hedgeStartedAt should be null.', 'The test expects hedgeStartedAt=null.', true, ['identifier']),
      f('`primary.then(() => { primarySettled = true })` sets primarySettled only after the promise resolves.', 'primarySettled is set in primary.then after promise resolution.', true, ['causality','identifier']),
      f('`clearTimeout(timer)` happens after `await primary.catch(...)`.', 'The source places clearTimeout(timer) after awaiting primary.catch.', true, ['time','identifier']),
      f('`server.address()` may return null before listening completes.', 'The source raises a possible listen/address ordering issue; it is not established by a tool result.', true, ['condition','identifier'], 'possible'),
      f('The failure shows got 1712 and 1698', 'The raw reports hedgeStartedAt values 1712 and 1698, not independently measured here.', true, ['number','time']),
      f("on a slow machine the fetch's internal processing (socket read, promise resolution) may be delayed more than the timer", 'Delayed fetch processing relative to the timer is a possible explanation, not a measured timing breakdown.', true, ['condition','causality'], 'possible'),
      f('t0 = Date.now() before fetch. The timer is set with setTimeout(1600). But the server delay is 1500ms from when the request arrives at the server.', 'Hedge timing starts at t0 before fetch; server delay starts after receipt, so the two durations have different origins.', true, ['number','time','causality']),
      f('If connect overhead > 100ms, hedge fires.', 'If connection overhead exceeds the 100ms margin, the hedge can precede the primary settlement.', true, ['threshold','condition','causality'], 'conditional'),
      f('On 16-core local, overhead is ~0ms. On 2-core CI, overhead can exceed 100ms.', 'The source hypothesizes negligible local overhead versus potentially larger CI overhead; no direct overhead measurement is retained.', false, ['number','actor','condition'], 'possible'),
      f('the margin between hedgeAfterMs (1600) and primaryDelayMs (1500) is only 100ms', 'The source increasingly attributes flakiness to the test timing margin rather than a confirmed product defect.', true, ['number','threshold','causality']),
      f("if primary settles exactly around the timer, ordering matters.", 'Ordering still matters near simultaneous timer and primary settlement.', true, ['condition','time'], 'conditional'),
      f('primaryDelayMs 200, hedgeAfterMs 2000', 'One proposed wider-margin option is primaryDelayMs=200 and hedgeAfterMs=2000.', true, ['number','decision'], 'possible'),
      f("But that still has a race in theory", 'A wider timing margin reduces practical flakiness but is not deterministic.', true, ['negation','condition'], 'reported', 'negative'),
      f('the test should control timing deterministically.', 'Deterministic timing control is another proposed fix.', true, ['decision'], 'possible'),
      f('§4 对冲在主请求 200 之后不得再发', 'The requirement is no new hedge after the primary returns 200, not no hedge while the primary is still pending.', true, ['negation','condition','time']),
      f('the timer fires BEFORE the primary settles (because of overhead), which is legitimately "hedge starts because primary was slow"', 'A hedge before a still-pending primary settles can be legitimate under the stated semantics.', true, ['condition','time'], 'conditional'),
      f('primaryDelayMs=200, hedgeAfterMs=5000', 'A second wider-margin proposal uses primaryDelayMs=200 and hedgeAfterMs=5000.', true, ['number','decision'], 'possible'),
      f('the hedge delay should be measured relative to when the request was actually sent', 'Changing the hedge clock origin to actual request send is considered, not selected or implemented.', true, ['time','decision'], 'possible'),
      f("Let me check if there's a git repo, more files, verify.mjs.", 'The current next step is further repository/harness exploration, not a completed fix.', true, ['decision'], 'possible'),
      f('package.json test = "node verify.mjs" but there\'s no verify.mjs listed.', 'package.json points to node verify.mjs, but the source says verify.mjs is not in the listing.', true, ['identifier','negation']),
    ],
    nonmaterial: [0,25,27],
    repeated: [5,7,9,10,11,15,16,21],
    draftLines: [
      ['Current hypothesis: a flaky timing assumption in test/hedge.selftest.mjs, not a confirmed product defect or completed fix.', [11,20]],
      ['primaryDelayMs=1500 starts after server receipt; hedgeAfterMs=1600 starts at t0 before fetch. There is only a 100ms margin; if connection/scheduling overhead exceeds it, the primary may still be pending when the hedge starts.', [1,8,9]],
      ['The test expects hedgeStartedAt=null; the raw reports 1712 and 1698. Delayed fetch handling versus timer handling is possible, but these observations do not directly measure overhead.', [2,6,7]],
      ['primarySettled is set in primary.then, with clearTimeout(timer) after await primary.catch. The requirement forbids a new hedge after primary 200; starting while primary is pending can be legitimate. Near-simultaneous ordering still matters.', [3,4,12,16,17]],
      ['The listen/address concern remains an unverified possibility; do not label it disproved.', [5]],
      ['Options remain open: primaryDelayMs=200 with hedgeAfterMs=2000 or 5000 only widens the margin, while deterministic timing is a stronger proposal. Moving the clock origin to actual send is also only being considered.', [13,14,15,18,19]],
      ['Next, inspect the remaining repository/harness clues: package.json uses node verify.mjs, but verify.mjs was not listed. No selected edit or post-edit validation is evidenced in this birth block.', [20,21]],
    ],
  },
  {
    parent: 'perf-regression-bf171c05465d1bab',
    facts: [
      f('I can only run commands in the repo root.', 'The source describes a restricted repository-root command environment.', true, ['condition'], 'reported'),
      f('The analyze-trace tool works though (it produced output).', 'analyze-trace produced output; this is not proof its implementation is readable.', true, ['identifier']),
      f('v11.9: outputTokens 260, outputChars 390, contentSpanMs 280, ttfb 610, finishWaitMs ~900', 'Reported v11.9 metrics: 260 output tokens, 390 chars, content span 280ms, ttfb 610ms, wait about 900ms.', true, ['number','time']),
      f('v11.10: outputTokens 1150, outputChars 1720, contentSpanMs 1650, ttfb 640, finishWaitMs ~2400', 'Reported v11.10 metrics: 1150 output tokens, 1720 chars, content span 1650ms, ttfb 640ms, wait about 2400ms.', true, ['number','time']),
      f('maxOutputTokens 850→4096, compressTargetMax 450→1800.', 'CHANGELOG is reported to raise maxOutputTokens 850 to 4096 and compressTargetMax 450 to 1800.', true, ['number','identifier']),
      f('compress-v3h:250-450 to compress-v3h:250-1800', 'The prompt version changed from compress-v3h:250-450 to compress-v3h:250-1800.', true, ['number','identifier']),
      f('maybe birthFinishWaitMs is a wait-for-finish that is being applied', 'A birthFinishWaitMs interaction is considered and not resolved in this block.', true, ['condition','identifier'], 'possible'),
      f('compressTargetMax: only affects v3 length target (target char limit in prompt)', 'README is reported to identify compressTargetMax as the v3 prompt character target.', true, ['identifier']),
      f('maxOutputTokens: 副模型单次输出上限 (secondary model single output limit)', 'README describes maxOutputTokens as an output ceiling, not the prompt target.', true, ['identifier']),
      f('Increasing it makes the model produce longer output → longer generation.', 'The leading source explanation connects the raised prompt target to output length and generation duration; it is not a controlled causal experiment.', true, ['causality'], 'reported'),
      f("outputTokens 260 was well below 850, so the cap wasn't binding.", 'The old 260 output tokens were below the old 850 ceiling.', true, ['number','threshold']),
      f("Raising the cap to 4096 doesn't by itself cause longer output — it just allows it.", 'The source reasons that raising a ceiling allows rather than forces longer output.', true, ['negation','causality'], 'reported', 'negative'),
      f('390 < 450, ok fine. And v11.10 outputChars 1720 ≈ 1800.', 'The source corrects its transient comparison: 390 is below 450 and 1720 is near 1800.', true, ['number','threshold']),
      f('revert compressTargetMax to 450.', 'Reverting compressTargetMax to 450 is proposed; no edit receipt is present in raw.', true, ['number','decision'], 'possible'),
      f('maxOutputTokens: 4096,', 'The displayed config contains maxOutputTokens=4096.', true, ['number','identifier']),
      f('compressTargetMin: 250,', 'The displayed config contains compressTargetMin=250.', true, ['number','identifier']),
      f('compressTargetMax: 1800,', 'The displayed config contains compressTargetMax=1800.', true, ['number','identifier']),
      f('birthFinishWaitMs: 1500,', 'The displayed config contains birthFinishWaitMs=1500; its relation to the reported 2400ms remains unverified.', true, ['number','identifier']),
      f('compressTargets returns min, max, promptVersion.', 'The source says compressTargets returns min, max and promptVersion.', true, ['identifier']),
      f('Some APIs: if you set max_tokens, the model may generate up to that. But it doesn\'t force longer.', 'The raw revisits possible API/cap interactions but does not establish a new driver.', false, ['condition','negation'], 'possible'),
      f('Let me run analyze-trace with --last N to see raw traces, and check other fields. Let me also try --steps llm.', 'The raw next proposes finer trace fields, --last N and --steps llm, before claiming an applied/validated repair.', true, ['decision','identifier'], 'possible'),
    ],
    nonmaterial: [2,9,23],
    repeated: [1,6,12,14,15,16,19,20,21,24],
    draftLines: [
      ['Reported metrics, v11.9 -> v11.10: outputTokens 260 -> 1150; outputChars 390 -> 1720; contentSpanMs 280 -> 1650; ttfb 610 -> 640; finishWaitMs about 900 -> 2400.', [3,4]],
      ['CHANGELOG raised maxOutputTokens 850 -> 4096 and compressTargetMax 450 -> 1800; promptVersion changed compress-v3h:250-450 -> compress-v3h:250-1800.', [5,6]],
      ['The leading explanation is the larger v3 prompt character target driving longer generation. maxOutputTokens is a ceiling: 260 < 850, and 1150 < 4096, so these observations do not show ceiling truncation; 390 < 450 and 1720 is near 1800. This is source reasoning, not a controlled rollback result.', [8,9,10,11,12,13,4,15]],
      ['Proposed change: revert compressTargetMax to 450, not an already executed edit. Displayed config is maxOutputTokens=4096, compressTargetMin=250, compressTargetMax=1800, birthFinishWaitMs=1500; compressTargets returns min/max/promptVersion.', [14,15,16,17,18,19]],
      ['The relation between birthFinishWaitMs=1500 and the reported ~2400ms, and possible hidden interactions, remains unresolved; do not erase it or declare latency restored.', [7,18]],
      ['Commands seem limited to the repository root; analyze-trace works. The current plan is to inspect finer trace fields, --last N and --steps llm. There is no post-change measurement in this birth block; the already visible ctx ledger remains authoritative for prior calls.', [1,2,21]],
    ],
  },
  {
    parent: 'sse-truncated-2c6c7d60c10b5d86',
    facts: [
      f("in `assembleSseFrames`, `finish` is set to `'stop'` when `[DONE]` is seen but no `finish_reason` was ever present.", 'The source attributes synthetic finish=stop to DONE without a real upstream finish_reason.', true, ['identifier','negation','causality']),
      f('`ok = r.finish != null || r.out.length > 0`', 'The existing settle success predicate accepts a nonempty output even without a finish reason.', true, ['identifier','causality']),
      f('truncated streams (only [DONE], or no ending signal) are treated as success → condensed.', 'The source connects these predicates to truncated streams being accepted and condensed.', true, ['causality','condition']),
      f('Truncated stream (only [DONE] appended, or no end signal at all) must settle ok:false and birth → passthrough.', 'DONE-only and no-ending truncated streams must settle ok:false and pass through raw.', true, ['negation','condition'], 'required', 'negative'),
      f('Complete stream (with finish_reason, including finish_reason=length) must still be condensed.', 'Complete streams with real finish_reason, including length, remain accepted for condensation.', true, ['condition','exception'], 'required'),
      f("`finish` should only be a real finish_reason from the upstream (don't synthesize 'stop' from [DONE]).", 'Only a real upstream finish_reason should define finish; DONE must not synthesize stop.', true, ['negation','identifier'], 'required', 'negative'),
      f('`settle.ok` should be `r.finish != null`', 'The proposed success predicate is r.finish != null, not output length.', true, ['decision','identifier'], 'required'),
      f("`assembleSseFrames([fin('stop'), '[DONE]'])` → out='' , finish='stop' → ok true.", 'A genuine stop finish with empty output still yields ok=true at transport settle.', true, ['exception','identifier']),
      f("`finish: finish || (done ? 'stop' : null)`", 'The existing return fallback done ? stop : null is the proposed removal point.', true, ['identifier','decision']),
      f('Per gateway doc, normal end has finish_reason then [DONE].', 'The source reports the gateway contract as finish_reason followed by DONE.', true, ['condition','time']),
      f("frames without [DONE] and without finish_reason → finish=null → ok false.", 'Without DONE or finish_reason the proposed result is finish=null and ok=false.', true, ['negation','condition']),
      f('what if a frame is malformed? Not needed.', 'Malformed-frame robustness is explicitly not investigated in this block.', true, ['negation','condition'], 'reported', 'negative'),
      f("I'll just not synthesize finish.", 'The prose favors the minimal no-synthetic-finish change, without committing to exposing done.', true, ['decision','negation']),
      f("let out = '', finish = null, done = false", 'The draft code sketch still includes a done boolean; this differs from the minimal prose.', true, ['identifier']),
      f("if (f === '[DONE]') { done = true; continue }", 'The sketch records DONE but continues without adding content or inventing finish.', true, ['identifier','negation']),
      f("out += j.choices?.[0]?.delta?.content || ''", 'The sketch accumulates choices[0].delta.content.', true, ['identifier']),
      f('const fr = j.choices?.[0]?.finish_reason\n    if (fr) finish = fr', 'The sketch obtains finish only from a truthy upstream choices[0].finish_reason.', true, ['identifier','condition']),
      f('return { out, finish, done, eventCount: frames.length }', 'The sketch returns out, finish, done and eventCount=frames.length; returned done remains an unsettled shape choice.', true, ['identifier']),
      f("trace('compiler-transport-settled', { ok, finish: r.finish, stream: true, outputChars: r.out.length, eventCount: r.eventCount })", 'The proposed settle trace retains ok/finish/stream/outputChars/eventCount.', true, ['identifier']),
      f('return { ok, ...r }', 'The proposed settle returns ok plus the result fields.', true, ['identifier']),
      f('birth uses settled.ok and settled.out.length.', 'The source says birth uses settled.ok and output length; settle acceptance is distinct from later birth gates.', true, ['identifier','condition']),
      f("Also add tests to cover the truncated cases so the suite covers it", 'The source plans new truncated-case tests, not just implementation changes.', true, ['decision'], 'required'),
      f('Let me now do the edits.', 'The block ends with planned edits, not receipts confirming edits or passing new tests.', true, ['decision','time'], 'possible'),
    ],
    nonmaterial: [0,12,17],
    repeated: [5,7,8,15,18],
    draftLines: [
      ['Diagnosis in the source: assembleSseFrames invents finish=stop from [DONE], and settle uses ok = r.finish != null || r.out.length > 0; either path can accept a truncated nonempty stream and condense it.', [1,2,3]],
      ['Proposed fix: remove finish || (done ? stop : null); retain only the upstream choices[0].finish_reason. settle should use ok = r.finish != null, never nonempty output as completion proof.', [6,7,9,17]],
      ['Required cases: [DONE]-only or no-ending/no-finish => ok:false and birth passthrough; real finish_reason=length remains complete and eligible for condensed. A genuine stop finish with empty out still settles ok:true; later birth gates remain separate.', [4,5,8,11,21]],
      ['This relies on the reported gateway contract: normal streams emit finish_reason then [DONE]. Do not treat bare [DONE] as equivalent completion.', [10,6]],
      ['The sketch accumulates delta.content, skips [DONE] while setting done, and returns out/finish/done/eventCount=frames.length. Prose leans minimal, while the sketch exposes done: that shape choice is unresolved, and done must not imply success.', [13,14,15,16,18]],
      ['Keep compiler-transport-settled ok/finish/stream/outputChars/eventCount and return { ok, ...r }. Add regressions for the truncated cases and the complete length/empty-stop controls, then validate with the ctx replay/test tools.', [19,20,22]],
      ['Malformed-frame handling is not investigated here. The raw ends planning edits: no edit receipt, passing new tests, or completed repair is evidenced yet.', [12,23]],
    ],
  },
]

const limitations = [
  'The entire retained raw and ctx was read and classified by one Arena.ai AI reviewer; no human or independent second review.',
  'References were authored and reviewed in this session; they are development proposals, not gold or target-reader-certified targets.',
  'Coverage is of the retained compressor-visible ctx, not proof that the entire original conversation or birth-time source version is available.',
  'Source statements remain reports/hypotheses; no scenario edits, CI, target continuation, tokenizer, CPU LM or training was executed.',
  'All three families and parent inputs were already exposed development material; neither train nor new blind use is allowed.',
]
const provenance = { mode: 'ai-single-reviewer', reviewerType: 'ai', reviewerId: 'arena-agent-mode', reviewerCount: 1, humanReviewerCount: 0, independentSecondReview: false, reviewedAt: '2026-10-12', scope: 'raw-context-facts-and-reference-claims', limitations }

function paragraphSpans(text) {
  const result = [], re = /\n\s*\n/g
  let cursor = 0, match
  while ((match = re.exec(text))) {
    result.push({ start: cursor, end: match.index, quote: text.slice(cursor, match.index) }); cursor = re.lastIndex
  }
  if (cursor < text.length) result.push({ start: cursor, end: text.length, quote: text.slice(cursor) })
  return result.filter((s) => s.start !== s.end)
}

export function buildReviewedDev(root = ROOT) {
  const rows = readJsonl(path.join(root, QUEUE)), annotations = [], reviews = []
  for (const spec of SPECS) {
    const parent = rows.find((r) => r.caseId === spec.parent)
    if (!parent) throw new Error('review parent missing: ' + spec.parent)
    const referenceDraft = spec.draftLines.map(([text]) => text).join('\n')
    const caseId = stableCaseId({ ...parent, draft: referenceDraft })
    const facts = spec.facts.map((fact, i) => ({
      factId: 'f' + (i + 1), proposition: fact.proposition,
      sourceSpan: { field: 'raw', ...exactSpan(parent.raw, fact.quote) },
      importance: fact.mustPreserve ? 'high' : 'low', polarity: fact.polarity, modality: fact.modality,
      conditions: fact.modality === 'conditional' ? [fact.proposition] : [], entities: [], mustPreserve: fact.mustPreserve, tags: fact.tags,
    }))
    // Already retained context remains in the receiver prefix. Inventory it explicitly;
    // an omitted duplicate ledger is not a draft omission of a new birth-time finding.
    const ctxSpans = paragraphSpans(parent.ctx)
    for (const [i, span] of ctxSpans.entries()) facts.push({ factId: 'ctx' + (i + 1), proposition: i === 0 ? 'The exact task, known observations and acceptance requirements remain in visible ctx.' : 'The retained ctx contains a previously visible ledger/continuation block; it is not new tool evidence.', sourceSpan: { field: 'ctx', ...span }, importance: 'medium', polarity: 'mixed', modality: 'reported', conditions: [], entities: [], mustPreserve: false, tags: i === 0 ? ['condition'] : ['time','identifier'] })
    const annotation = {
      ...parent, caseId, sourceId: parent.caseId, source: QUEUE,
      sourceKind: 'ai-reviewed-curated', sourceAudit: 'docs/CONTINUATION-PROGRAM-2026-10-12.md',
      finalSplit: 'dev', provenanceSplit: 'existing-dev', referenceDraft,
      sourceCoverage: 'complete', annotationStatus: 'adjudicated', reviewers: ['arena-agent-mode'],
      reviewProvenance: structuredClone(provenance),
      facts, referenceStatus: 'complete-ai-reviewed-development-proposal-not-reader-validated',
      sourceHashes: { rawSha256: sha256(parent.raw), ctxSha256: sha256(parent.ctx), referenceSha256: sha256(referenceDraft) },
      referenceReview: { status: 'adjudicated', factStatuses: facts.map((fact) => ({ factId: fact.factId, status: fact.mustPreserve ? 'preserved' : 'omitted' })), allMustPreserveFactsSatisfied: true, unsupportedClaimsReviewed: true, unsupportedClaimsCount: 0 },
      trainingEligible: false,
      reviewOnlyReason: 'Full retained-source AI development review only; source/model/license/birth boundary and real target-reader effect not admitted; exposed family remains dev-only.',
    }
    const sourceUnits = { raw: [], ctx: [] }
    for (const field of ['raw', 'ctx']) for (const [i, span] of paragraphSpans(parent[field]).entries()) {
      const ids = facts.filter((fact) => fact.sourceSpan.field === field && fact.sourceSpan.start >= span.start && fact.sourceSpan.end <= span.end).map((fact) => fact.factId)
      let classification = field === 'ctx' ? 'ctx-retained' : ids.length ? 'material' : spec.nonmaterial.includes(i) ? 'nonmaterial' : spec.repeated.includes(i) ? 'repetition' : 'deliberation'
      if (field === 'raw' && span.quote.includes('```') && ids.length) classification = 'quoted-code'
      sourceUnits[field].push({ unitId: field + '-p' + i, ...span, classification, factIds: ids, rationale: field === 'ctx' ? 'Reviewed retained task/ledger; survives unchanged in the reader prefix, not fabricated fresh observations.' : ids.length ? 'Contains explicitly inventoried reported facts, proposals or conditions; preserve the source epistemic status.' : classification === 'repetition' ? 'Reconsiders the same already inventoried timing/length/completion alternatives; no new tool result or committed action.' : classification === 'nonmaterial' ? 'Rhetorical transition or repeated intention; not a material new result.' : 'Exploratory questioning without a new observed result; its decision-relevant alternatives are explicitly retained elsewhere.' })
    }
    let cursor = 0
    const draftClaims = spec.draftLines.map(([text, ids], i) => {
      const span = exactSpan(referenceDraft, text, { from: cursor }); cursor = span.end
      return { claimId: 'claim' + (i + 1), ...span, status: 'supported', sourceFactIds: [...new Set([...ids.map((n) => 'f' + n), ...(text.includes('ctx') ? facts.filter((f) => f.sourceSpan.field === 'ctx').map((f) => f.factId) : [])])], rationale: 'AI reviewed the whole proposition against the cited retained facts, preserving planned/reported/conditional status. Negative claims are limited to absence of new receipts within this birth block, not all prior history.' }
    })
    const review = {
      schema: 'cfb.compression-review/1', caseId, annotationSha256: boundAnnotationDigest(annotation), inputSha256: inputSha256(annotation), draftSha256: sha256(referenceDraft),
      parentArtifact: { path: QUEUE, sha256: sha256(fs.readFileSync(path.join(root, QUEUE))), caseId: parent.caseId, recordSha256: sha256(JSON.stringify(parent)) },
      status: 'complete-ai-single-review', reviewedAt: '2026-10-12', reviewerId: 'arena-agent-mode', humanReviewerCount: 0, independentSecondReview: false,
      sourceUnits, draftClaims, limitations, semanticCertification: false, targetReadbackVerified: false,
    }
    const errors = validateCompleteReview(annotation, review)
    if (errors.length) throw new Error(caseId + ': ' + errors.join('; '))
    annotations.push(annotation); reviews.push(review)
  }
  return { annotations, reviews }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length && !(argv.length === 1 && argv[0] === '--write')) throw new Error('use --write for fresh programme files, or no arguments for read-only summary')
  const built = buildReviewedDev()
  if (argv[0] === '--write') {
    writeFresh(path.join(ROOT, PROGRAM_DIR, 'reviewed-dev.jsonl'), built.annotations.map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFresh(path.join(ROOT, PROGRAM_DIR, 'complete-reviews.jsonl'), built.reviews.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  console.log(JSON.stringify({ cases: built.annotations.length, facts: built.annotations.reduce((n, a) => n + a.facts.length, 0), claims: built.reviews.reduce((n, r) => n + r.draftClaims.length, 0), trainingAdmitted: false, targetReadbackVerified: false, paidApiCalls: 0 }))
  return 0
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = main() } catch (e) { console.error(e.stack || e); process.exitCode = 1 }
}
