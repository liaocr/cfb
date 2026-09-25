// dsh-cot-form-b / handle-probe.js —— 句柄读回探针（v11.11 从 plugin.js 抽出，逐字搬移）
//
// birth 的内存预推句柄验证与 checkpoint 发射前抽样验证共用同一个探针。
/**
 * ★★ P0-2（2026-09-24）句柄读回探针 ★★
 *
 * 契约（三态，务必别把不可证当成证伪）：
 *   true  = 有**正面证据**能按句柄取回（读到内容；内容抽样对不上也算能读回，不拦发射）
 *   false = 有**正面证据**取不回（读 API 明确说没有这条记录，或用受控探针确认"失败信号可信"后抛错）
 *   null  = **不可证**（宿主没提供读 API / 读 API 抛错但探针无法区分是"没记录"还是"调用方式不对"）
 *
 * 为什么要受控探针：若读 API 对不存在的句柄也是抛错，那"抛错"本身就是证据；但若抛错源于签名不符，
 * 把抛错当证伪会误伤所有正常发射。所以先拿一根**必然不存在**的同形句柄试一次，确认失败信号可信。
 * 这一步只在首次探针时做一次（结果缓存在闭包里），不进入常规路径。
 */
export function mkHandleProbe(ctx, trace) {
  let control = null // null=未测；'can-fail'=失败信号可信；'cannot-fail'=无法区分
  const readStore = () => {
    try { return (ctx.get && ctx.get('cmbStore', false)) || null } catch { return null }
  }
  const controlProbe = async (store, sessionId) => {
    if (control) return control
    try {
      const out = await store.readRangeByHandle('art://' + '0'.repeat(22), sessionId, 1, 1)
      control = (out && Array.isArray(out.lines) && out.lines.length > 0) ? 'cannot-fail' : 'can-fail'
    } catch { control = 'can-fail' }
    return control
  }
  return async function probeHandle(handle, text, sessionId) {
    const store = readStore()
    if (!store || typeof store.readRangeByHandle !== 'function') return null
    if (typeof handle !== 'string' || !handle) return false
    try {
      const out = await store.readRangeByHandle(handle, sessionId, 1, 1)
      if (!out || !Array.isArray(out.lines) || out.lines.length === 0) return false
      // 内容抽样：首行前 40 字符（首行不含换行 ⇒ 不受 CAS 行拼接语义影响）
      const want = String(text || '').split('\n')[0].slice(0, 40)
      if (want && typeof out.lines[0] === 'string' && out.lines[0].slice(0, want.length) !== want) {
        trace('handle-probe-mismatch', { handle, wantChars: want.length })
      }
      return true
    } catch (e) {
      const c = await controlProbe(store, sessionId)
      if (c === 'can-fail') { trace('handle-probe-reject', { handle, error: String((e && e.message) || e) }); return false }
      trace('handle-probe-inconclusive', { handle, error: String((e && e.message) || e) })
      return null
    }
  }
}
