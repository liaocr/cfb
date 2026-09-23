// Only identical in-flight requests share transport. No settled-result cache,
// no queue, no eviction of active work, no cross-plugin or unscoped reuse.
import crypto from 'node:crypto'
export function createExactFlights({ maxEntries = 32, maxBytes = 4 * 1024 * 1024 } = {}) {
  const flights = new Map()
  let bytes = 0
  function run(identity, execute, { signal, trace = () => {} } = {}) {
    const emit = (tag, data) => { try { trace(tag, data) } catch {} }
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
    if (identity != null && flights.get(identity)?.attachments >= 128) identity = null
    const size = identity == null ? 0 : Buffer.byteLength(identity)
    let f = identity == null ? null : flights.get(identity)
    const shared = !!f
    if (!f) {
      const tracked = identity != null && flights.size < maxEntries && bytes + size <= maxBytes
      f = { flightId: crypto.randomUUID(), controller: new AbortController(), users: 0, attachments: 0, done: false, started: Date.now() }
      if (tracked) { flights.set(identity, f); bytes += size }
      f.remove = () => { if (tracked && flights.get(identity) === f) { flights.delete(identity); bytes -= size } }
      f.promise = Promise.resolve().then(() => {
        if (f.controller.signal.aborted) throw new Error('cancelled')
        return execute(f.controller.signal, f.flightId)
      }).finally(() => { f.done = true; f.remove() })
    }
    f.users++; f.attachments++
    emit(shared ? 'compiler-flight-shared' : 'compiler-flight-started', { flightId: f.flightId, shared, ageMs: Date.now() - f.started })
    return new Promise((resolve, reject) => {
      let ended = false
      const finish = (fn, value) => {
        if (ended) return
        ended = true; signal?.removeEventListener('abort', cancel); f.users--
        fn(value)
      }
      const cancel = () => {
        if (ended) return
        finish(reject, Object.assign(new Error('cancelled'), { meta: { flightId: f.flightId, sharedFlight: shared, cancelled: true } }))
        emit('compiler-consumer-cancelled', { flightId: f.flightId, remainingConsumers: f.users })
        if (!f.users && !f.done) { f.remove(); f.controller.abort() }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      f.promise.then(r => finish(resolve, { ...r, meta: { ...r.meta, flightId: f.flightId, sharedFlight: shared } }), e => {
        // Never mutate a shared Error or result on behalf of one consumer.
        const error = Object.assign(new Error(e?.message || String(e)), { meta: { ...e?.meta, flightId: f.flightId, sharedFlight: shared } })
        finish(reject, error)
      })
      if (signal?.aborted) cancel()
    })
  }
  return { run, get size() { return flights.size }, get bytes() { return bytes } }
}
