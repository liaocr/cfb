#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseTrace } from './replay.mjs'
export function analyzeConsumption(text) {
  const rows = parseTrace(text), tasks = new Map()
  const task = id => { if (!tasks.has(id)) tasks.set(id, { taskId: id, prepared: false, generated: false, archived: false, stored: false, opportunities: 0, hits: 0, applied: false, acknowledged: false, presented: 0, failure: null }); return tasks.get(id) }
  for (const r of rows) {
    if (r.taskId) {
      const t = task(r.taskId)
      if (r.tag === 'birth-fired') t.fired = true
      if (r.tag === 'compiler-input-prepared') t.prepared = true
      if (r.tag === 'birth-distill-settled') { t.generated = r.ok === true; t.failure = r.ok ? null : r.reason || 'unknown' }
      if (r.tag === 'birth-archive-settled') t.archived = r.ok === true
      if (r.tag === 'birth-late-memory-stored') t.stored = true
      if (r.tag === 'birth-late-memory-refused') t.notStoredReason = r.reason
      if (r.tag === 'birth-condensed') { t.inlineProduced = true }
      if (r.tag === 'memory-presented-in-options') t.presented++
    }
    for (const id of r.taskIds || []) {
      const t = task(id)
      if (r.tag === 'birth-claim-opportunity') t.opportunities++
      if (r.tag === 'birth-claim-hit') t.hits++
      if (r.tag === 'birth-claim-emitted') t.applied = true
      if (r.tag === 'birth-claim-acknowledged') t.acknowledged = true
      if (r.tag === 'birth-claim-skip') t.lastSkip = r.reason
    }
  }
  const list = [...tasks.values()], count = fn => list.filter(fn).length
  return { kind: 'consumption-funnel', boots: rows.filter(r => r.tag === 'BOOT').length,
    counts: { fired: count(t => t.fired), inputPrepared: count(t => t.prepared), generated: count(t => t.generated),
      generatedAndArchived: count(t => t.generated && t.archived), stored: count(t => t.stored), storedWithLaterOpportunity: count(t => t.stored && t.opportunities > 0),
      hit: count(t => t.hits > 0), inlineProduced: count(t => t.inlineProduced), applied: count(t => t.applied), acknowledged: count(t => t.acknowledged), observedInLaterOptions: count(t => t.presented > 0),
      storedWithoutObservedOpportunity: count(t => t.stored && !t.opportunities) },
    tasks: list, productAcceptance: '未验收', billingSavings: null,
    limitations: ['A log end is not proof of session end; no observed opportunity is not a failed claim.',
      'Applied means the host append call returned successfully, not independently verified host projection.',
      'Presented means exact text observed in subsequent llm options within a bounded in-process meter, not billed tokens.',
      'No semantic-understanding claim is inferred from recording, transmission, or successful compilation.'] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, out] = process.argv.slice(2)
  if (!file) { console.error('Usage: node analyze-consumption.mjs TRACE [OUTPUT]'); process.exitCode = 2 }
  else { const report = JSON.stringify(analyzeConsumption(fs.readFileSync(file, 'utf8')), null, 2); if (out) fs.writeFileSync(out, report + '\n'); else console.log(report) }
}
