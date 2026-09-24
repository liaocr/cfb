// dsh-cot-form-b / fs-lock.js —— 独占锁文件（O_EXCL）+ 「持锁进程已死」的保守接管
//
// 背景（v11.10）：evidence-ledger / evidence-storage / snapshot-store 都用 openSync(lock, 'wx') 建锁，
//   且有意「不按年龄抢锁」（挂起的活进程可能仍持有它）。代价是：网关在持锁期间崩溃一次，
//   锁文件就永远留着 ⇒ 之后每次都 *-busy ⇒ memory 模式永久降级，只能人工删文件。
//
// 接管判据（全部满足才接管，否则照旧 fail-closed）：
//   ① 锁内容是本模块写的新格式 `pid@hostname@ms`（旧格式 / 空文件 / 解析失败 ⇒ 不接管）；
//   ② hostname 与本机相同（跨机器共享目录时无法判断对方进程是否存活 ⇒ 不接管）；
//   ③ pid 不是本进程，且 process.kill(pid, 0) 报 ESRCH（进程确实不存在；EPERM = 存在但无权 ⇒ 视为活着）。
// 仍然**不按年龄**接管：挂起的活进程 pid 存在 ⇒ 永远不会被抢。
//
// 竞态：两个进程同时发现同一把死锁时，先把死锁**原子改名**到唯一路径，再核对改名走的内容
//   与刚才判定为死锁的内容逐字一致；不一致（说明抢到了别人刚建的新锁）⇒ 尽力用 link 放回并放弃。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'

const stats = { acquired: 0, busy: 0, staleRecovered: 0 }
/** 诊断用：本进程内的锁统计（接管次数可证伪「崩溃残留锁」是否真实发生过）。 */
export function lockStats() { return { ...stats } }

export function lockOwnerText() {
  return process.pid + '@' + os.hostname() + '@' + Date.now()
}

/** 解析锁内容；不是新格式 ⇒ null（调用方据此 fail-closed）。 */
export function parseLockOwner(text) {
  const m = /^(\d+)@([^@\s]+)@(\d+)$/.exec(String(text || '').trim())
  if (!m) return null
  return { pid: Number(m[1]), host: m[2], at: Number(m[3]) }
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true   // 不认识 ⇒ 当作活着（保守）
  try { process.kill(pid, 0); return true } catch (e) { return !(e && e.code === 'ESRCH') }
}

/** 这把锁是否可以证明为「持有者已死」的残留锁。 */
export function isStaleLock(text) {
  const o = parseLockOwner(text)
  if (!o) return false
  if (o.host !== os.hostname()) return false
  if (o.pid === process.pid) return false
  return !pidAlive(o.pid)
}

function tryRecoverStale(lockPath) {
  let observed
  try { observed = fs.readFileSync(lockPath, 'utf8') } catch { return false }
  if (!isStaleLock(observed)) return false
  const moved = lockPath + '.stale-' + crypto.randomBytes(6).toString('hex')
  try { fs.renameSync(lockPath, moved) } catch { return false }
  let got = null
  try { got = fs.readFileSync(moved, 'utf8') } catch { /* ignore */ }
  if (got !== observed) {
    // 改名走的是别人刚建的新锁 ⇒ 尽力放回（link 在目标已存在时失败，不会覆盖更新的锁）
    try { fs.linkSync(moved, lockPath) } catch { /* ignore */ }
    try { fs.unlinkSync(moved) } catch { /* ignore */ }
    return false
  }
  try { fs.unlinkSync(moved) } catch { /* ignore */ }
  stats.staleRecovered++
  return true
}

/**
 * 以 O_EXCL 打开锁文件并写入持有者；返回 fd（调用方负责 close + unlink）。
 * 锁已被占用且无法证明持有者已死 ⇒ 抛出 code='EEXIST' 的错误（与 openSync('wx') 同形）。
 */
export function openLockExclusive(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = fs.openSync(lockPath, 'wx')
    } catch (e) {
      if (e && e.code === 'EEXIST' && attempt === 0 && tryRecoverStale(lockPath)) continue
      if (e && e.code === 'EEXIST') stats.busy++
      throw e
    }
    try { fs.writeSync(fd, lockOwnerText()) } catch { /* 写不进持有者也仍是一把有效的独占锁 */ }
    stats.acquired++
    return fd
  }
  stats.busy++
  throw Object.assign(new Error('EEXIST: lock busy ' + lockPath), { code: 'EEXIST' })
}
