// Bounded, process-local admission. Only queued compaction opportunities are
// superseded; callers keep their original text. An active owner is never evicted.
export function createCompileLanes({ maxKeys = 128 } = {}) {
  const lanes = new Map()
  function reserve(key, { signal, deadline = Date.now() + 8000 } = {}) {
    let resolve, reject, timer, granted = false, finished = false
    const ready = new Promise((a, b) => { resolve = a; reject = b })
    let lane = lanes.get(key)
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
    const fail = reason => {
      if (finished || granted) return
      finished = true; cleanup()
      if (lane?.pending === ticket) lane.pending = null
      if (lane && !lane.active && !lane.pending && lanes.get(key) === lane) lanes.delete(key)
      reject(new Error(reason))
    }
    const cancel = () => fail('compile-queue-cancelled')
    const ticket = {
      ready,
      start() {
        if (finished) return
        if (signal?.aborted || Date.now() >= deadline) { fail('compile-queue-expired'); return }
        granted = true; cleanup(); lane.active = ticket; resolve()
      },
      fail,
      release() {
        if (finished || !granted) return
        finished = true
        if (lane.active !== ticket) return
        lane.active = null
        const next = lane.pending; lane.pending = null
        if (next) next.start()
        if (!lane.active && !lane.pending) lanes.delete(key)
      },
    }
    if (signal?.aborted || Date.now() >= deadline) { fail('compile-queue-expired'); return ticket }
    if (!lane) {
      if (lanes.size >= maxKeys) { fail('compile-queue-capacity'); return ticket }
      lane = { active: null, pending: null }; lanes.set(key, lane)
    }
    if (!lane.active) ticket.start()
    else {
      lane.pending?.fail('compile-queue-superseded')
      lane.pending = ticket
      signal?.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => fail('compile-queue-expired'), Math.max(1, deadline - Date.now()))
    }
    return ticket
  }
  return { reserve, get size() { return lanes.size } }
}
