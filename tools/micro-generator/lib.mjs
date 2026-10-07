import crypto from 'node:crypto'
import fs from 'node:fs'

export const FACT_STATUSES = new Set(['preserved', 'omitted', 'contradicted', 'uncertain'])
export const CLAIM_STATUSES = new Set(['supported', 'unsupported', 'contradictory', 'uncertain'])
export const SPLITS = new Set(['train', 'dev', 'blind'])
export const IMPORTANCE_WEIGHTS = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 })
export const AI_REVIEWER_ID = 'arena-agent-mode'
export const AI_REVIEW_MODE = 'ai-single-reviewer'

function validateAiSingleReviewProvenance(provenance, reviewerIds, expectedScope, at, key) {
  const prefix = key || 'reviewProvenance'
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    at(prefix, 'required for an AI single-reviewer decision')
    return
  }
  if (provenance.mode !== AI_REVIEW_MODE) at(`${prefix}.mode`, `must be ${AI_REVIEW_MODE}`)
  if (provenance.reviewerType !== 'ai') at(`${prefix}.reviewerType`, 'must explicitly identify an AI reviewer')
  if (provenance.reviewerId !== AI_REVIEWER_ID) at(`${prefix}.reviewerId`, `must identify ${AI_REVIEWER_ID}`)
  if (provenance.reviewerCount !== 1) at(`${prefix}.reviewerCount`, 'must be exactly one')
  if (provenance.humanReviewerCount !== 0) at(`${prefix}.humanReviewerCount`, 'must be zero; do not imply a human review')
  if (provenance.independentSecondReview !== false) at(`${prefix}.independentSecondReview`, 'must be false for the authorized single-reviewer policy')
  if (typeof provenance.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(provenance.reviewedAt)) at(`${prefix}.reviewedAt`, 'must be a YYYY-MM-DD date')
  if (provenance.scope !== expectedScope) at(`${prefix}.scope`, `must be ${expectedScope}`)
  if (!Array.isArray(provenance.limitations) || provenance.limitations.length === 0 || provenance.limitations.some((value) => typeof value !== 'string' || !value.trim())) at(`${prefix}.limitations`, 'must record at least one review limitation')
  if (!Array.isArray(reviewerIds) || reviewerIds.length !== 1 || reviewerIds[0] !== AI_REVIEWER_ID) at('reviewers', `must contain only ${AI_REVIEWER_ID}; no second reviewer is required or claimed`)
}

export const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
export const inputSha256 = ({ raw, ctx }) => sha256(`${sha256(raw)}:${sha256(ctx)}`)
export const stableCaseId = ({ family, raw, ctx, draft }) => `${String(family).replace(/[^a-zA-Z0-9._-]+/g, '-')}-${sha256(`${inputSha256({ raw, ctx })}:${sha256(draft)}`).slice(0, 16)}`

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8')
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] }
    catch (error) { throw new Error(`${file}:${i + 1}: invalid JSON: ${error.message}`) }
  })
}

export function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

export function validateAnnotation(record, { requireFinalSplit = false } = {}) {
  const errors = []
  const at = (key, message) => errors.push(`${record?.caseId || '<missing-caseId>'}.${key}: ${message}`)
  if (!record || record.schema !== 'cfb.micro-generator-annotation/1') at('schema', 'expected cfb.micro-generator-annotation/1')
  if (!record?.caseId) at('caseId', 'required non-empty id')
  if (!record?.family) at('family', 'required family id')
  if (!record?.raw) at('raw', 'required non-empty source')
  if (typeof record?.ctx !== 'string') at('ctx', 'must be a string')
  if (typeof record?.referenceDraft !== 'string' || !record.referenceDraft) at('referenceDraft', 'required non-empty reviewed/reference target')
  const sourceHashes = record?.sourceHashes || {}
  if (sourceHashes.rawSha256 !== sha256(record?.raw ?? '')) at('sourceHashes.rawSha256', 'missing or stale')
  if (sourceHashes.ctxSha256 !== sha256(record?.ctx ?? '')) at('sourceHashes.ctxSha256', 'missing or stale')
  if (sourceHashes.referenceSha256 !== sha256(record?.referenceDraft ?? '')) at('sourceHashes.referenceSha256', 'missing or stale')
  if (requireFinalSplit && !SPLITS.has(record?.finalSplit)) at('finalSplit', 'must be train, dev, or blind')
  if (record?.finalSplit != null && !SPLITS.has(record.finalSplit)) at('finalSplit', 'must be train, dev, blind, or null')
  if (!['unreviewed', 'partial', 'complete'].includes(record?.sourceCoverage)) at('sourceCoverage', 'invalid coverage status')
  if (!['unreviewed', 'draft', 'reviewed', 'adjudicated'].includes(record?.annotationStatus)) at('annotationStatus', 'invalid status')
  if (!Array.isArray(record?.reviewers)) at('reviewers', 'must be an array of reviewer IDs')
  const reviewers = Array.isArray(record?.reviewers) ? record.reviewers : []
  if (reviewers.some((id) => typeof id !== 'string' || id.length === 0)) at('reviewers', 'reviewer IDs must be non-empty strings')
  const distinctReviewerCount = new Set(reviewers.filter((id) => typeof id === 'string' && id.length > 0)).size
  if (distinctReviewerCount !== reviewers.length) at('reviewers', 'reviewer IDs must be unique')
  if (!Array.isArray(record?.facts)) at('facts', 'must be an array')
  const facts = Array.isArray(record?.facts) ? record.facts : []
  const ids = new Set()
  for (const [i, fact] of facts.entries()) {
    const key = `facts[${i}]`
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) { at(key, 'must be an object'); continue }
    if (typeof fact.factId !== 'string' || !fact.factId || ids.has(fact.factId)) at(key + '.factId', 'must be a present, unique string')
    if (typeof fact.factId === 'string') ids.add(fact.factId)
    if (typeof fact.proposition !== 'string' || !fact.proposition) at(key + '.proposition', 'must be non-empty text')
    if (!Object.hasOwn(IMPORTANCE_WEIGHTS, fact.importance)) at(key + '.importance', 'unknown importance')
    if (!['positive', 'negative', 'mixed', 'not-applicable', 'uncertain'].includes(fact.polarity)) at(key + '.polarity', 'unknown polarity')
    if (!['asserted', 'required', 'prohibited', 'possible', 'conditional', 'reported', 'uncertain'].includes(fact.modality)) at(key + '.modality', 'unknown modality')
    if (!Array.isArray(fact.conditions) || fact.conditions.some((value) => typeof value !== 'string')) at(key + '.conditions', 'must be a string array')
    if (!Array.isArray(fact.entities) || fact.entities.some((value) => typeof value !== 'string')) at(key + '.entities', 'must be a string array')
    if (fact.tags != null && (!Array.isArray(fact.tags) || fact.tags.some((tag) => !['number', 'threshold', 'time', 'actor', 'negation', 'condition', 'exception', 'decision', 'causality', 'identifier'].includes(tag)) || new Set(fact.tags).size !== fact.tags.length)) at(key + '.tags', 'contains invalid or duplicate tags')
    if (typeof fact.mustPreserve !== 'boolean') at(key + '.mustPreserve', 'must be boolean')
    const span = fact.sourceSpan
    if (!span || !['raw', 'ctx'].includes(span.field)) at(key + '.sourceSpan', 'field must be raw or ctx')
    else {
      const text = record[span.field]
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length) {
        at(key + '.sourceSpan', `invalid UTF-16 offsets for ${span.field} (length ${text.length})`)
      } else if (text.slice(span.start, span.end) !== span.quote) {
        at(key + '.sourceSpan.quote', 'does not equal the source substring at [start,end)')
      }
    }
  }
  if (record?.sourceCoverage === 'complete' && facts.length === 0) at('facts', 'complete coverage requires at least one atomic fact')
  if (record?.annotationStatus === 'adjudicated' && record.sourceCoverage !== 'complete') at('sourceCoverage', 'reviewed source facts require complete coverage')
  const ref = record?.referenceReview
  if (!ref || !['pending', 'adjudicated'].includes(ref.status)) at('referenceReview.status', 'must be pending or adjudicated')
  if (ref?.status === 'adjudicated') {
    const statuses = Array.isArray(ref.factStatuses) ? ref.factStatuses : []
    const byId = new Map(statuses.map((x) => [x.factId, x.status]))
    if (statuses.length !== facts.length || byId.size !== facts.length || facts.some((f) => !FACT_STATUSES.has(byId.get(f.factId)))) at('referenceReview.factStatuses', 'must adjudicate every fact exactly once')
    if (typeof ref.allMustPreserveFactsSatisfied !== 'boolean') at('referenceReview.allMustPreserveFactsSatisfied', 'must be boolean after adjudication')
    if (ref.allMustPreserveFactsSatisfied === true && facts.some((fact) => fact.mustPreserve && byId.get(fact.factId) !== 'preserved')) at('referenceReview.allMustPreserveFactsSatisfied', 'true conflicts with a must-preserve omission/contradiction/uncertain label')
    if (typeof ref.unsupportedClaimsReviewed !== 'boolean' || ref.unsupportedClaimsReviewed !== true) at('referenceReview.unsupportedClaimsReviewed', 'must be true after review')
    if (!Number.isInteger(ref.unsupportedClaimsCount) || ref.unsupportedClaimsCount < 0) at('referenceReview.unsupportedClaimsCount', 'must be a non-negative count')
  }
  if (record?.annotationStatus === 'adjudicated' || ref?.status === 'adjudicated') {
    validateAiSingleReviewProvenance(record?.reviewProvenance, reviewers, 'raw-context-facts-and-reference-claims', at, 'reviewProvenance')
  }
  return errors
}

export function validatePrediction(prediction, annotation, { gates = null } = {}) {
  const errors = []
  const at = (key, message) => errors.push(`${prediction?.caseId || '<missing-caseId>'}.${key}: ${message}`)
  if (!prediction || prediction.schema !== 'cfb.micro-generator-prediction/1') at('schema', 'expected cfb.micro-generator-prediction/1')
  if (!annotation || prediction?.caseId !== annotation.caseId) at('caseId', 'prediction has no matching annotation case')
  if (annotation && prediction?.family !== annotation.family) at('family', 'does not match annotation family')
  if (annotation && prediction?.split !== annotation.finalSplit) at('split', 'does not match registered final split')
  if (annotation && prediction?.inputSha256 !== inputSha256({ raw: annotation.raw, ctx: annotation.ctx })) at('inputSha256', 'does not match the frozen raw+ctx input')
  if (!prediction?.model?.id) at('model.id', 'required')
  if (!/^[a-f0-9]{40}$/.test(String(prediction?.model?.revision || ''))) at('model.revision', 'must be an immutable lowercase 40-hex commit')
  if (!/^[a-f0-9]{64}$/.test(String(prediction?.model?.weightsSha256 || ''))) at('model.weightsSha256', 'must be a 64-hex weight/artifact identity')
  if (!prediction?.model?.quantization) at('model.quantization', 'required')
  if (!prediction?.promptVersion || !/^[a-f0-9]{64}$/.test(String(prediction?.promptSha256 || ''))) at('prompt', 'version and SHA-256 required')
  if (!Number.isFinite(prediction?.latencyMs) || prediction.latencyMs < 0) at('latencyMs', 'must be non-negative')
  if (typeof prediction?.draft !== 'string') at('draft', 'must be a string')
  const review = prediction?.review
  if (!review || !['pending', 'adjudicated'].includes(review.status)) at('review.status', 'must be pending or adjudicated')
  if (review?.status === 'adjudicated') {
    if (review.factCoverage !== 'complete') at('review.factCoverage', 'must be complete for adjudicated evaluation')
    if (review.claimCoverage !== 'complete') at('review.claimCoverage', 'must be complete for adjudicated evaluation')
    const reviewerIds = Array.isArray(review.reviewers) ? review.reviewers.filter((x) => typeof x === 'string' && x.length > 0) : []
    validateAiSingleReviewProvenance(review.reviewProvenance, reviewerIds, 'prediction-facts-and-claims', at, 'review.reviewProvenance')
    const expected = new Set((annotation?.facts || []).map((f) => f.factId))
    const seen = new Set()
    for (const row of review.facts || []) {
      if (!expected.has(row.factId) || seen.has(row.factId) || !FACT_STATUSES.has(row.status)) at('review.facts', `invalid, duplicate, or unknown fact outcome ${row.factId}`)
      seen.add(row.factId)
    }
    if (seen.size !== expected.size) at('review.facts', 'must adjudicate every annotated fact exactly once')
    const claimIds = new Set()
    for (const claim of review.claims || []) {
      if (!claim.claimId || claimIds.has(claim.claimId)) at('review.claims', 'claim ids must be present and unique')
      claimIds.add(claim.claimId)
      if (!CLAIM_STATUSES.has(claim.status)) at(`review.claims.${claim.claimId || '?'}`, 'invalid claim status')
      if (!Array.isArray(claim.sourceFactIds)) at(`review.claims.${claim.claimId || '?'}.sourceFactIds`, 'must be an array')
      else if (claim.sourceFactIds.some((id) => !expected.has(id))) at(`review.claims.${claim.claimId || '?'}.sourceFactIds`, 'unknown source fact id')
      else if (claim.status === 'supported' && claim.sourceFactIds.length === 0) at(`review.claims.${claim.claimId}`, 'supported claim must cite at least one fact id')
    }
  }
  if (prediction?.split === 'blind') {
    const protocol = prediction.blindProtocol
    if (!protocol || typeof protocol !== 'object') at('blindProtocol', 'blind predictions require frozen-gate provenance')
    else {
      for (const [key, label] of [['gateConfigSha256', 'gate config SHA-256'], ['blindRegistrySha256', 'blind registry SHA-256']]) {
        if (!/^[a-f0-9]{64}$/.test(String(protocol[key] || ''))) at(`blindProtocol.${key}`, `must be a ${label}`)
      }
      if (!protocol.gateId) at('blindProtocol.gateId', 'required')
      if (gates?.status === 'frozen') {
        if (protocol.gateId !== gates.gateId) at('blindProtocol.gateId', 'does not match the evaluated frozen gate')
        if (protocol.gateConfigSha256 !== gates.frozenConfigSha256) at('blindProtocol.gateConfigSha256', 'does not match the evaluated frozen gate')
        if (protocol.blindRegistrySha256 !== gates.blindFamilyRegistry?.registrySha256) at('blindProtocol.blindRegistrySha256', 'does not match the evaluated blind registry')
        if (!gates.blindFamilyRegistry?.families?.includes(prediction.family)) at('family', 'is not authorized by the frozen blind registry')
      }
    }
  } else if (prediction?.blindProtocol != null) at('blindProtocol', 'may only be attached to blind-split predictions')
  return errors
}

export function validateFamilyIsolation(records, { splitKey = 'finalSplit' } = {}) {
  const errors = []
  const familySplits = new Map()
  const inputSplits = new Map()
  const caseIds = new Set()
  for (const row of records) {
    const split = row?.[splitKey]
    if (!SPLITS.has(split)) continue
    if (caseIds.has(row.caseId)) errors.push(`duplicate caseId: ${row.caseId}`)
    caseIds.add(row.caseId)
    if (familySplits.has(row.family) && familySplits.get(row.family) !== split) errors.push(`family leakage: ${row.family} occurs in ${familySplits.get(row.family)} and ${split}`)
    else familySplits.set(row.family, split)
    if (typeof row.raw === 'string' && typeof row.ctx === 'string') {
      const hash = inputSha256({ raw: row.raw, ctx: row.ctx })
      if (inputSplits.has(hash) && inputSplits.get(hash) !== split) errors.push(`input leakage across splits for input ${hash.slice(0, 12)}`)
      else inputSplits.set(hash, split)
    }
  }
  return errors
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
