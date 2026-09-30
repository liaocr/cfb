// 公开小收据与私有 HMAC 仓双平面绑定；不含输入、响应正文、密钥或私有路径。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { assertSafePath, readJson, writeJson, syncDirectory } from './eval-files.mjs'
export const API_APPROVAL_SCOPE = 'cfb.minimal-api-approval.2026-09-30'
export const apiStoreDirectory = (directory) => path.join(path.resolve(directory), crypto.createHash('sha256').update(API_APPROVAL_SCOPE).digest('hex'))
const HEX = /^[a-f0-9]{64}$/
export function readWatermark(file) {
  try {
    const value = readJson(file, 65536), { digest, ...body } = value
    if (body.schema !== 'cfb.api-watermark/1' || body.scope !== API_APPROVAL_SCOPE || !HEX.test(body.planDigest || '') || !HEX.test(body.authorityId || '') || !HEX.test(body.revision || '') || !Number.isSafeInteger(body.sequence) || body.sequence < 1 || !Number.isSafeInteger(body.requests) || body.requests < 0 || body.requests > 13 || !Number.isSafeInteger(body.reservedNano) || body.reservedNano < 0 || body.reservedNano > 2e9 || !Array.isArray(body.jobs) || body.jobs.length !== body.requests || evidenceDigest(body) !== digest) throw new Error('api-watermark-integrity')
    return immutableJson(value)
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
export function projectWatermark(store, head, state) {
  const body = { schema: 'cfb.api-watermark/1', scope: API_APPROVAL_SCOPE, planDigest: state.planDigest, authorityId: store.authorityId,
    sequence: head.sequence, revision: head.revision, requests: state.entries.length, reservedNano: state.entries.reduce((n, e) => n + e.reservedNano, 0), halted: state.halted,
    jobs: state.entries.map((e) => ({ key: e.key, kind: e.kind, reservedNano: e.reservedNano, status: e.status, ...(e.reason ? { reason: e.reason } : {}) })) }
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
export function assertWatermark(store, head, state, file) {
  const marker = readWatermark(file)
  if (!head || !marker) throw new Error('api-budget-restore-required')
  if (marker.authorityId !== store.authorityId || marker.planDigest !== state.planDigest || marker.digest !== projectWatermark(store, head, state).digest) throw new Error('api-watermark-conflict')
  return marker
}
export function assertExistingBudget(directory, file) {
  assertSafePath(file)
  const marker = readWatermark(file)
  if (marker && (!fs.existsSync(path.join(apiStoreDirectory(directory), '.head-api-budget.json')) || !fs.existsSync(path.join(apiStoreDirectory(directory), 'authority.key')))) throw new Error('api-budget-restore-required')
  return marker
}
export function commitWatermark(store, head, state, file, { initial = false } = {}) {
  syncDirectory(store.directory)
  writeJson(file, projectWatermark(store, head, state), { exclusive: initial })
}
