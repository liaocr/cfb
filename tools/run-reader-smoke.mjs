#!/usr/bin/env node
/**
 * Minimal paid original-reader smoke. Default mode is planning only; --execute is required for network dispatch.
 * Privacy contract: local artifacts contain hashes/usage/metadata only, never prompt or provider-response bodies.
 * The local spend ceiling is a pre-dispatch reservation under operator-supplied rates, not a provider-enforced cap.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendPrivateAuditEvent, buildReaderSmokeBody, parseReaderSmokeConfig, runReaderSmoke, validateReaderBaseUrl } from './helpers/reader-smoke.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const CASES_FILE = path.join(ROOT, 'transfer/program-2026-10-12/reviewed-dev.jsonl')

export function loadCases() {
  const text = fs.readFileSync(CASES_FILE, 'utf8')
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
    let r
    try { r = JSON.parse(line) } catch { throw new Error(`reader-smoke-invalid-case-json:${i + 1}`) }
    if (typeof r.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.caseId) || !['raw', 'ctx', 'referenceDraft'].every((k) => typeof r[k] === 'string')) throw new Error(`reader-smoke-invalid-case:${i + 1}`)
    return { caseId: r.caseId, raw: r.raw, ctx: r.ctx, reference: r.referenceDraft }
  })
  if (!rows.length || new Set(rows.map((r) => r.caseId)).size !== rows.length) throw new Error('reader-smoke-cases-empty-or-duplicate')
  return rows
}
function parseArgs(argv) {
  let execute = false, help = false
  for (const arg of argv) {
    if (arg === '--execute' && !execute) execute = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error(`unknown-argument:${arg}`)
  }
  return { execute, help }
}
function help() {
  console.log(`Reader smoke — default is local planning only.

  node tools/run-reader-smoke.mjs                 # no network; show the bounded plan
  node tools/run-reader-smoke.mjs --execute       # paid calls; requires explicit budgets, prices, source/date and API key

Execution environment (all rates are operator-supplied, not invoice guarantees):
  DEEPSEEK_API_KEY, MAX_REQUESTS, MAX_USD, INPUT_USD_PER_MILLION,
  OUTPUT_USD_PER_MILLION, PRICING_SOURCE (https URL), PRICING_VERIFIED_AT (YYYY-MM-DD)
  Optional: MAX_RETRIES (default 0), MAX_INPUT_TOKENS (32768), MAX_OUTPUT_TOKENS (512),
  REQUEST_TIMEOUT_MS (120000), MAX_RESPONSE_BYTES (1048576), REQUEST_FEE_USD (0).

Artifacts are written under .cfb-runtime/reader-smoke/ with owner-only permissions.
The reservation cap is per invocation and assumes the declared rates, a byte-based input bound plus 4096 tokens,
and the provider honoring max_tokens. Use a provider-side spending limit for a true invoice cap.`)
}
function makePrivateOutput() {
  const runtime = path.join(ROOT, '.cfb-runtime')
  const dir = path.join(runtime, 'reader-smoke')
  for (const p of [runtime, dir]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('reader-smoke-output-directory-must-not-be-symlink')
    fs.mkdirSync(p, { recursive: true, mode: 0o700 })
    fs.chmodSync(p, 0o700)
  }
  const file = path.join(dir, `reader-smoke-${Date.now()}-${process.pid}.jsonl`)
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.fchmodSync(fd, 0o600)
  return { file, fd }
}
function dryPlan(cases, config) {
  const slots = cases.length * 3
  const covered = Math.min(slots, config.maxRequests)
  console.log('PLAN ONLY — no API/network requests will be sent.')
  console.log(`cases=${cases.length} plannedSlots=${slots} MAX_REQUESTS=${config.maxRequests} MAX_RETRIES=${config.maxRetries} maxOutputTokens=${config.maxOutputTokens} timeoutMs=${config.timeoutMs}`)
  console.log(`per-invocation reservation ceiling=${config.maxUsd} USD; executable slots before retries ≤ ${covered}`)
  if (config.pricing) {
    const quotes = cases.flatMap((c) => ['raw', 'reference'].map((kind) => buildReaderSmokeBody({ model: MODEL, ctx: c.ctx, reasoning: kind === 'reference' ? c.reference : c.raw })))
    console.log(`operator pricing=${config.pricing.inputUsdPerMillion}/${config.pricing.outputUsdPerMillion} USD per million (source ${config.pricing.source}, verified ${config.pricing.verifiedAt}); no billable estimate is asserted here`)
    console.log(`requests are dispatched sequentially and each retry consumes a new request + worst-case reservation`)
    console.log(`body shape ready for ${quotes.length} distinct raw/reference inputs; max_tokens is attached only at execution`)
  } else console.log('Pricing is unset. --execute will refuse to run until explicit rate-card inputs are supplied.')
  return 0
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { help(); return 0 }
  const cases = loadCases()
  const config = parseReaderSmokeConfig(process.env, { forExecution: args.execute })
  validateReaderBaseUrl(BASE_URL)
  if (!args.execute) return dryPlan(cases, config)
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY env required; no key file fallback is used')
  const { file, fd } = makePrivateOutput()
  let result
  try {
    result = await runReaderSmoke({
      cases, model: MODEL, baseUrl: BASE_URL, apiKey, config,
      onReserve: (row) => appendPrivateAuditEvent(fd, 'reservation', row),
      onResult: (row) => appendPrivateAuditEvent(fd, 'result', row),
    })
    appendPrivateAuditEvent(fd, 'run', {
      status: result.status,
      stopReason: result.stopReason,
      expectedSlots: result.expectedSlots,
      recordedAttempts: result.recordedAttempts,
      requestsReserved: result.budget.requestsReserved,
      usdReserved: result.budget.reservedUsd,
      maxRequests: result.budget.maxRequests,
      maxUsd: result.budget.maxUsd,
      maxRetries: config.maxRetries,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      inputUsdPerMillion: config.pricing.inputUsdPerMillion,
      outputUsdPerMillion: config.pricing.outputUsdPerMillion,
      requestFeeUsd: config.pricing.requestFeeUsd,
      pricingSource: config.pricing.source,
      pricingVerifiedAt: config.pricing.verifiedAt,
      inputBoundBasis: 'full-json-utf8-bytes-plus-4096-protocol-tokens',
    })
    console.log(`\nSmoke ${result.status}. Requests reserved=${result.budget.requestsReserved}/${result.budget.maxRequests}; worst-case local reservation=${result.budget.reservedUsd.toFixed(6)}/${result.budget.maxUsd.toFixed(6)} USD.`)
    console.log(`Private metadata-only audit: ${path.relative(ROOT, file)}`)
    console.log('Provider billing is not verified; the amount is a local reservation under the declared rate card, not an invoice.')
    console.log('This is NOT the formal original-reader-study/1; it does not support promotion or model-readback claims.')
  } finally {
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  }
  return result.status === 'complete' ? 0 : 2
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }).catch((e) => { console.error(`reader-smoke: ${e.code || e.message}`); process.exitCode = 1 })
}
