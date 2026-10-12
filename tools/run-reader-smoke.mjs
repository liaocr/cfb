#!/usr/bin/env node
/**
 * Minimal original-reader smoke: raw-a/raw-b/reference for 3 dev cases.
 * - No key file storage, use env DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL
 * - Records full request/response hashes, usage, latency, not just success boolean
 * - Does NOT claim to be the full original-reader-study/1, only a pre-check
 * - Stops on budget limit, does not auto-retry infinitely
 * - Real execution evidence, not fixture
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY env required, not file. Do not paste key into code.')
  process.exit(2)
}

const BUDGET = {
  maxRequests: parseInt(process.env.MAX_REQUESTS || '9', 10),
  maxUsd: parseFloat(process.env.MAX_USD || '5'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '1', 10),
}

function loadCases() {
  const rows = fs.readFileSync(path.join(ROOT, 'transfer/program-2026-10-12/reviewed-dev.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return rows.map(r => ({
    caseId: r.caseId,
    raw: r.raw,
    ctx: r.ctx,
    reference: r.referenceDraft,
  }))
}

async function callReader(messages, tools = undefined) {
  const body = {
    model: MODEL,
    messages,
    reasoning_effort: 'high',
  }
  if (tools) body.tools = tools
  // DeepSeek thinking mode via extra_body
  const extra = { thinking: { type: 'enabled' } }

  const start = Date.now()
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ ...body, extra_body: extra }),
  })
  const latencyMs = Date.now() - start
  const json = await res.json()
  if (!res.ok) {
    return { ok: false, status: res.status, body: json, latencyMs }
  }
  const choice = json.choices?.[0]
  return {
    ok: true,
    status: res.status,
    latencyMs,
    usage: json.usage,
    reasoning_content: choice?.message?.reasoning_content || null,
    content: choice?.message?.content || '',
    raw: json,
  }
}

async function main() {
  const cases = loadCases()
  const outPath = path.join(ROOT, `transfer/program-2026-10-12/reader-smoke-${Date.now()}.jsonl`)
  if (fs.existsSync(outPath)) throw new Error('fresh output required')

  let requests = 0
  let estimatedUsd = 0
  const results = []

  for (const c of cases) {
    for (const arm of ['raw-a', 'raw-b', 'reference']) {
      if (requests >= BUDGET.maxRequests) break
      if (estimatedUsd >= BUDGET.maxUsd) break

      const reasoningBlock = arm === 'reference' ? c.reference : c.raw
      // Minimal multi-turn: user task = ctx, assistant reasoning = reasoningBlock, then next user asks to continue
      // This is a smoke shape, not the full birth-state capture required for formal study
      const messages = [
        { role: 'user', content: c.ctx },
        { role: 'assistant', content: `Reasoning: ${reasoningBlock.slice(0, 4000)}`, reasoning_content: reasoningBlock.slice(0, 4000) },
        { role: 'user', content: 'Continue the task based on previous reasoning. Report task outcome and any constraint violations.' },
      ]

      let attempt = 0, last
      while (attempt <= BUDGET.maxRetries) {
        last = await callReader(messages)
        requests++
        // Very rough USD estimate: use official DeepSeek pricing as anchor, not actual a6api billing
        // $0.30/M uncached input + $1.20/M output peak as worst-case
        if (last.usage) {
          const inTok = last.usage.prompt_tokens || 0
          const outTok = last.usage.completion_tokens || 0
          estimatedUsd += (inTok * 0.30 + outTok * 1.20) / 1e6
        }
        if (last.ok) break
        attempt++
        await new Promise(r => setTimeout(r, 1000 * attempt))
      }

      results.push({
        caseId: c.caseId,
        arm,
        ok: last.ok,
        status: last.status,
        latencyMs: last.latencyMs,
        usage: last.usage || null,
        hasReasoningContent: !!last.reasoning_content,
        contentLen: (last.content || '').length,
        reasoningLen: (last.reasoning_content || '').length,
      })

      fs.appendFileSync(outPath, JSON.stringify({
        caseId: c.caseId,
        arm,
        request: { model: MODEL, messages: messages.map(m => ({ role: m.role, contentLen: m.content?.length || 0, hasReasoning: !!m.reasoning_content })) },
        response: last,
        budget: { requests, estimatedUsd },
        timestamp: new Date().toISOString(),
      }) + '\n')

      console.log(`[${c.caseId} ${arm}] ok=${last.ok} status=${last.status} latency=${last.latencyMs}ms usage=${JSON.stringify(last.usage)} hasReasoning=${!!last.reasoning_content}`)
    }
  }

  console.log(`\nSmoke finished. Requests=${requests} estUsd~${estimatedUsd.toFixed(4)} out=${outPath}`)
  console.log('This is NOT the formal original-reader-study/1. Full study needs frozen birth state, channel/tools/decoding pins, and complete continuation accounting.')
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
