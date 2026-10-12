// Hash-only readback observations. Hook options are NOT final provider wire bytes,
// and token accounting/syntax validity is NOT evidence of semantic continuation.
import crypto from 'node:crypto'
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x), 'utf8').digest('hex')
export const evidenceSha256 = sha

export function replacementEvidence({ raw, draft, ctx = '', sessionId = null, taskId = null, index = null }) {
  return { schema: 'cfb.birth-replacement-evidence/1', stage: 'birth-decision', sessionId, taskId, index,
    rawSha256: sha(raw), draftSha256: sha(draft), ctxSha256: sha(ctx), inputSha256: sha(`${sha(raw)}:${sha(ctx)}`),
    rawChars: raw.length, draftChars: draft.length,
    qualification: 'Replacement decision identity only; not proof of host persistence, final payload or receiver usage.' }
}

export function reasoningChannelHashes(messages) {
  const channels = []
  for (const [messageIndex, m] of (Array.isArray(messages) ? messages : []).entries()) {
    if (!m || m.role !== 'assistant') continue
    for (const key of ['reasoning_content', 'reasoning']) if (typeof m[key] === 'string' && m[key]) channels.push({ messageIndex, channel: key, chars: m[key].length, sha256: sha(m[key]) })
    if (Array.isArray(m.content)) for (const [blockIndex, b] of m.content.entries()) if (b && ['reasoning', 'thinking'].includes(b.type) && typeof b.text === 'string' && b.text) channels.push({ messageIndex, blockIndex, channel: 'content.' + b.type, chars: b.text.length, sha256: sha(b.text) })
  }
  return channels
}

export function requestEvidence({ body, sessionId = null, sequence = null, requestId = null, stage = 'hook-options', fixtureOnly = null }) {
  if (!['hook-options', 'transport-payload'].includes(stage)) throw new Error('unknown-readback-capture-stage')
  const messages = Array.isArray(body?.messages) ? body.messages : []
  // Selected body, not HTTP headers, URL credentials or plaintext text previews.
  const selected = { model: body?.model ?? null, messages, tools: body?.tools ?? null,
    thinking: body?.thinking ?? null, temperature: body?.temperature ?? null, max_tokens: body?.max_tokens ?? null }
  return { schema: 'cfb.readback-request-evidence/1', stage, sessionId, sequence, requestId,
    model: typeof body?.model === 'string' ? body.model : null, requestSha256: sha(selected),
    toolsSha256: sha(selected.tools), decodingSha256: sha([selected.thinking, selected.temperature, selected.max_tokens]),
    messageCount: messages.length, reasoningChannels: reasoningChannelHashes(messages), fixtureOnly,
    qualification: stage === 'hook-options' ? 'Host hook arguments only; provider serialization may still alter them.' : 'Caller-supplied serialized transport body identity; execution/provider receipt and semantic effects must be verified separately.' }
}
