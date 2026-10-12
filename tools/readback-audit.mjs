#!/usr/bin/env node
// Import recorded hook/wire observations only; never initiates network/model calls.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical)
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])]))
  return x
}
const digest = (x) => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const hex = (x) => /^[a-f0-9]{64}$/.test(String(x || ''))

export function parseReadbackLog(text) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return []
    if (line.startsWith('{')) {
      try { return [JSON.parse(line)] } catch (e) { throw new Error(`readback log:${i + 1}: invalid JSON: ${e.message}`) }
    }
    const m = /^\[([^\]]+)\] \[([^\]]+)\] (\{.*\})$/.exec(line)
    if (!m) throw new Error('readback log:' + (i + 1) + ': invalid trace framing')
    try { return [{ tag: m[2], at: m[1], data: JSON.parse(m[3]) }] } catch (e) { throw new Error(`readback log:${i + 1}: invalid trace JSON: ${e.message}`) }
  })
}

export function auditReadback(events) {
  const births = [], requests = [], errors = [], seen = new Set()
  let duplicates = 0, ignored = 0
  for (const [line, event] of events.entries()) {
    const data = event?.data ?? event
    const r = data?.readbackEvidence || data
    if (!['cfb.birth-replacement-evidence/1', 'cfb.readback-request-evidence/1'].includes(r?.schema)) { ignored++; continue }
    // Timestamp/file/key order copies must not manufacture observations.
    const body = Object.fromEntries(Object.entries(r).filter(([key]) => !['at','timestamp','capturedAt'].includes(key)))
    const key = digest(body)
    if (seen.has(key)) { duplicates++; continue } seen.add(key)
    if (typeof r.sessionId !== 'string' || !r.sessionId) { errors.push('unattributed session at line ' + (line + 1)); continue }
    if (r.schema === 'cfb.birth-replacement-evidence/1') {
      if (!r.taskId || !hex(r.rawSha256) || !hex(r.draftSha256) || !hex(r.inputSha256) || r.stage !== 'birth-decision') { errors.push('invalid birth identity at line ' + (line + 1)); continue }
      births.push({ ...r, line, observationSha256: key })
    } else {
      if (!hex(r.requestSha256) || !Array.isArray(r.reasoningChannels) || !['hook-options','transport-payload'].includes(r.stage)) { errors.push('invalid request identity at line ' + (line + 1)); continue }
      if (r.reasoningChannels.some((c) => !hex(c.sha256) || !Number.isInteger(c.messageIndex) || c.messageIndex < 0)) { errors.push('invalid reasoning channel hashes at line ' + (line + 1)); continue }
      requests.push({ ...r, line, observationSha256: key })
    }
  }
  const birthKeys = new Map(), conflictingBirths = new Set(), requestKeys = new Map(), conflictingRequests = new Set()
  for (const b of births) {
    const key = b.sessionId + ':' + b.taskId
    if (birthKeys.has(key) && birthKeys.get(key) !== b.observationSha256) { conflictingBirths.add(key); errors.push('conflicting-birth-decision:' + key) }
    birthKeys.set(key, b.observationSha256)
  }
  for (const r of requests) if (r.requestId) {
    const key = r.sessionId + ':' + r.requestId + ':' + r.stage
    if (requestKeys.has(key) && requestKeys.get(key) !== r.requestSha256) { conflictingRequests.add(key); errors.push('conflicting-request-observation:' + key) }
    requestKeys.set(key, r.requestSha256)
  }
  const cleanRequests = requests.filter((r) => !conflictingRequests.has(r.sessionId + ':' + r.requestId + ':' + r.stage))
  const placements = births.filter((b) => !conflictingBirths.has(b.sessionId + ':' + b.taskId)).map((b) => {
    const after = cleanRequests.filter((r) => r.line > b.line && r.sessionId === b.sessionId)
    const matching = after.filter((r) => r.reasoningChannels.some((c) => c.sha256 === b.draftSha256))
    const hook = matching.filter((r) => r.stage === 'hook-options')
    const wire = matching.filter((r) => r.stage === 'transport-payload')
    const withRaw = after.filter((r) => r.reasoningChannels.some((c) => c.sha256 === b.rawSha256))
    return { taskId: b.taskId, sessionId: b.sessionId, inputSha256: b.inputSha256, draftSha256: b.draftSha256,
      laterHookDigestMatches: hook.length, laterTransportDigestMatches: wire.length,
      rawDigestAlsoSeen: withRaw.length,
      fixtureMatches: matching.filter((r) => r.fixtureOnly === true).length,
      status: wire.length ? 'digest-present-in-caller-recorded-transport' : hook.length ? 'hook-only-not-wire-proof' : 'no-exact-channel-digest-match',
      providerExecutionVerified: false, semanticContinuationVerified: false,
      qualification: 'Exact channel digest membership only; concatenated/transformed channels may require explicit body-side matching, and provider execution is unverified.' }
  })
  return { schema: 'cfb.readback-audit/1', ok: errors.length === 0, errors,
    counts: { uniqueBirthDecisions: births.length, uniqueRequestObservations: requests.length, duplicateObservations: duplicates, ignored }, placements,
    independentSampleCount: null, liveHostVerified: false, originalReaderEffectVerified: false,
    blockers: ['body/lineage membership is not independently verified HTTP execution', 'hook observations do not certify provider serialization', 'no paired original-receiver continuation outcomes'],
    paidApiCallsByThisCommand: 0, gpuRunsByThisCommand: 0, newBlindConsumedByThisCommand: 0 }
}

export function main(argv = process.argv.slice(2)) {
  let file = null, out = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--events' && argv[i + 1]) file = argv[++i]
    else if (argv[i] === '--out' && argv[i + 1]) out = argv[++i]
    else throw new Error('use --events FILE [--out NEW_FILE]')
  }
  if (!file) throw new Error('readback-events-file-required; no live calls are initiated')
  const bytes = fs.readFileSync(path.resolve(ROOT, file))
  const result = { ...auditReadback(parseReadbackLog(bytes.toString('utf8'))), source: { file, sha256: createHash('sha256').update(bytes).digest('hex') } }
  if (out) { const destination = path.resolve(ROOT, out); if (fs.existsSync(destination)) throw new Error('fresh-readback-audit-output-required'); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }) }
  console.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { try { process.exitCode = main() } catch (e) { console.error(e.message); process.exitCode = 1 } }
