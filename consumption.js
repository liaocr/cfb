// Observed presentation is not provider billing. No token or currency estimates.
export function createConsumptionMeter(trace = () => {}) {
  const items = new Map()
  function applied(taskId, text) {
    if (!taskId || typeof text !== 'string' || !text) return
    const bytes = Buffer.byteLength(text)
    if (bytes > 256 * 1024) return
    items.set(taskId, { text, bytes, presentations: 0 })
    while (items.size > 128 || [...items.values()].reduce((n, x) => n + x.bytes, 0) > 1024 * 1024) items.delete(items.keys().next().value)
  }
  function observe(options) {
    if (!items.size) return
    try {
      const texts = []
      const collect = (value, depth = 0) => {
        if (depth > 5) return
        if (typeof value === 'string') { texts.push(value); return }
        if (Array.isArray(value)) { for (const v of value) collect(v, depth + 1); return }
        if (value && typeof value === 'object') {
          if (typeof value.text === 'string') texts.push(value.text)
          if (value.content != null) collect(value.content, depth + 1)
        }
      }
      // Inspect existing text blocks, not a second serialization of the full
      // request (which may also contain large image/base64/tool-argument data).
      collect(options?.messages || [])
      const counts = new Map()
      for (const x of items.values()) counts.set(x.text, (counts.get(x.text) || 0) + 1)
      for (const [taskId, x] of items) {
        if (counts.get(x.text) !== 1) continue // Do not assign identical output to an arbitrary task.
        if (texts.some(text => text.includes(x.text))) {
          x.presentations++
          trace('memory-presented-in-options', { taskId, presentations: x.presentations, summaryChars: x.text.length, billedTokens: null, source: 'llm-hook-options-not-provider-receipt' })
        }
      }
    } catch {} // Observation must never block or break the main model.
  }
  return { applied, observe }
}
