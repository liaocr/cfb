// Stronger sidecar to the existing annotation/1 contract. Structural completeness
// checks never claim automatic entailment, independent review or reader validity.
import { inputSha256, sha256, validateAnnotation } from './lib.mjs'

export const digestJson = (x) => sha256(JSON.stringify(x))
export const flatRowDigest = (r) => digestJson([r.id, r.repo, r.system, r.user, r.assistant])
export const boundAnnotationDigest = (a) => digestJson(a)
const arr = (x) => Array.isArray(x) ? x : []
const SOURCE_CLASSES = new Set(['material', 'repetition', 'deliberation', 'quoted-code', 'ctx-retained', 'nonmaterial'])

function checkSpan(span, text, label, errors) {
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length) {
    errors.push(label + ': invalid UTF-16 span'); return false
  }
  if (span.quote !== text.slice(span.start, span.end)) { errors.push(label + ': quote does not match source'); return false }
  return true
}

export function checkTextCoverage(text, units, label) {
  const errors = [], spans = []
  if (!Array.isArray(units)) return [label + ': coverage units must be an array']
  for (const [i, unit] of units.entries()) if (checkSpan(unit, text, `${label}[${i}]`, errors)) spans.push(unit)
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) errors.push(label + ': overlapping coverage units')
    if (/\S/u.test(text.slice(cursor, span.start))) errors.push(`${label}: unreviewed non-whitespace at ${cursor}..${span.start}`)
    cursor = Math.max(cursor, span.end)
  }
  if (/\S/u.test(text.slice(cursor))) errors.push(`${label}: unreviewed non-whitespace at ${cursor}..${text.length}`)
  return errors
}

export function validateCompleteReview(annotation, review) {
  const errors = []
  if (!annotation || typeof annotation.raw !== 'string' || typeof annotation.ctx !== 'string' || typeof annotation.referenceDraft !== 'string') return ['invalid annotation source strings']
  errors.push(...validateAnnotation(annotation, { requireFinalSplit: true }))
  if (!review || review.schema !== 'cfb.compression-review/1') return [...errors, 'missing complete review sidecar']
  if (review.caseId !== annotation.caseId || review.annotationSha256 !== boundAnnotationDigest(annotation)) errors.push('review annotation binding mismatch')
  if (review.inputSha256 !== inputSha256(annotation) || review.draftSha256 !== sha256(annotation.referenceDraft)) errors.push('review input/draft binding mismatch')
  if (review.status !== 'complete-ai-single-review') errors.push('review is not complete')
  if (annotation.sourceCoverage !== 'complete' || annotation.annotationStatus !== 'adjudicated') errors.push('annotation not complete and adjudicated')
  if (review.semanticCertification !== false || review.targetReadbackVerified !== false) errors.push('review sidecar must not manufacture semantic/reader certification')
  if (review.reviewerId !== 'arena-agent-mode' || review.humanReviewerCount !== 0 || review.independentSecondReview !== false) errors.push('AI single-review provenance mismatch')
  if (!arr(review.limitations).length) errors.push('review limitations required')
  const ids = new Set(arr(annotation.facts).map((f) => f.factId))
  const seenUnits = new Set()
  for (const field of ['raw', 'ctx']) {
    const units = review.sourceUnits?.[field]
    errors.push(...checkTextCoverage(annotation[field], units, 'source.' + field))
    for (const unit of arr(units)) {
      if (!unit.unitId || seenUnits.has(unit.unitId)) errors.push('source unit ID missing or duplicate')
      seenUnits.add(unit.unitId)
      if (!SOURCE_CLASSES.has(unit.classification) || typeof unit.rationale !== 'string' || !unit.rationale.trim()) errors.push('source classification/rationale required')
      if (!Array.isArray(unit.factIds) || unit.factIds.some((id) => !ids.has(id))) errors.push('source unit has unknown fact IDs')
      if (['material', 'quoted-code'].includes(unit.classification) && !arr(unit.factIds).length) errors.push('material source unit requires explicit atomic facts')
    }
  }
  for (const fact of arr(annotation.facts)) {
    const span = fact.sourceSpan
    if (span && !arr(review.sourceUnits?.[span.field]).some((u) => u.start <= span.start && u.end >= span.end && arr(u.factIds).includes(fact.factId))) errors.push('fact not bound to a classified source unit: ' + fact.factId)
  }
  const claims = arr(review.draftClaims), claimIds = new Set()
  errors.push(...checkTextCoverage(annotation.referenceDraft, review.draftClaims, 'draft'))
  for (const claim of claims) {
    if (!claim.claimId || claimIds.has(claim.claimId)) errors.push('draft claim ID missing or duplicate')
    claimIds.add(claim.claimId)
    if (!['supported', 'unsupported', 'contradictory', 'uncertain', 'nonfactual'].includes(claim.status)) errors.push('unknown claim status')
    if (!Array.isArray(claim.sourceFactIds) || claim.sourceFactIds.some((id) => !ids.has(id))) errors.push('draft claim cites unknown fact')
    if (claim.status === 'supported' && !arr(claim.sourceFactIds).length) errors.push('supported claim without source facts')
    if (typeof claim.rationale !== 'string' || !claim.rationale.trim()) errors.push('draft claim rationale required')
  }
  const risky = claims.filter((c) => ['unsupported', 'contradictory', 'uncertain'].includes(c.status)).length
  if (annotation.referenceReview?.status !== 'adjudicated' || annotation.referenceReview.unsupportedClaimsReviewed !== true) errors.push('reference claim review incomplete')
  if (annotation.referenceReview?.unsupportedClaimsCount !== claims.filter((c) => c.status === 'unsupported').length) errors.push('reference unsupported count contradicts explicit claims')
  if (risky) errors.push('reference contains unsafe claims: ' + risky)
  if (annotation.referenceReview?.allMustPreserveFactsSatisfied !== true) errors.push('must-preserve facts not all satisfied')
  return [...new Set(errors)]
}

export function assessReference(annotation, review) {
  const errors = validateCompleteReview(annotation, review)
  const statuses = new Map(arr(annotation?.referenceReview?.factStatuses).map((r) => [r.factId, r.status]))
  const mandatory = arr(annotation?.facts).filter((f) => f.mustPreserve)
  return {
    caseId: annotation?.caseId || null, errors,
    reviewApparatusPass: errors.length === 0,
    materialFacts: mandatory.length,
    preservedMaterialFacts: mandatory.filter((f) => statuses.get(f.factId) === 'preserved').length,
    claims: arr(review?.draftClaims).length,
    characters: { raw: annotation?.raw?.length ?? null, ctx: annotation?.ctx?.length ?? null, draft: annotation?.referenceDraft?.length ?? null },
    charRatioProxy: annotation?.raw?.length ? annotation.referenceDraft.length / annotation.raw.length : null,
    realTokenSavings: null, realContinuationEffect: null,
    qualification: 'Explicit AI single-reviewer labels and exact coverage bindings; not automatic semantic proof or a valid target-reader ruler.',
  }
}

export function exactSpan(text, quote, { from = 0 } = {}) {
  const start = text.indexOf(quote, from)
  if (start < 0) throw new Error('review quote absent: ' + quote.slice(0, 100))
  return { start, end: start + quote.length, quote }
}
