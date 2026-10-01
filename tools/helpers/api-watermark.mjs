// 公开小收据与私有 HMAC 仓双平面绑定；不含输入、响应正文、密钥或私有路径。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evidenceDigest, immutableJson } from '../../src/evidence-program.js'
import { assertSafePath, readJson, writeJson, syncDirectory } from './eval-files.mjs'
export const API_APPROVAL_SCOPE = 'cfb.minimal-api-approval.2026-09-30'
// v2 scope＝用户 2026-10-01 的新明确批准（网络容错有界评测）；旧 scope/收据/私有仓永久封存，不重开。
export const API_APPROVAL_SCOPE_V2 = 'cfb.bounded-api-approval.2026-10-01'
// v3＝同日新批准的生产等价可见上下文协议：通道已证丢弃reasoning历史（canary证伪），改测可见压缩稿对『思考丢失』现实的净价值。
export const API_APPROVAL_SCOPE_V3 = 'cfb.visible-context-approval.2026-10-01'
// v4＝v3矩阵的输出预算修正版（8192）+ response-incomplete样本级容错；v3计划死于首个current样本length截断，收据封存。
export const API_APPROVAL_SCOPE_V4 = 'cfb.visible-context-approval.2026-10-01-r2'
// v5＝用户「全面推进下一步」批准的扩样本复跑：同v4矩阵n=2→6/格（36主+3探针），判据claimOfV2预注册。
export const API_APPROVAL_SCOPE_V5 = 'cfb.visible-context-expanded.2026-10-01'
// v6＝v5的探针/样本语义修正：探针免思考要求（echo只测保真）；主请求逐响应验证失败降为样本级（预算6），v5探针死于channel-no-thinking。
export const API_APPROVAL_SCOPE_V6 = 'cfb.visible-context-expanded.2026-10-01-r2'
// v7＝指纹政策修正：中转池轮换使任何钉死指纹数小时即失效（v6探针死于此，诊断显示fp已变null且echo正常）；
// v7放开fp闸但逐响应记录并在报告公开直方图/配对同指纹数，身份证据=型号精确+canary逐字回显+思考在跑+usage界。
export const API_APPROVAL_SCOPE_V7 = 'cfb.visible-context-expanded.2026-10-01-r3'
export const KNOWN_API_SCOPES = Object.freeze([API_APPROVAL_SCOPE, API_APPROVAL_SCOPE_V2, API_APPROVAL_SCOPE_V3, API_APPROVAL_SCOPE_V4, API_APPROVAL_SCOPE_V5, API_APPROVAL_SCOPE_V6, API_APPROVAL_SCOPE_V7])
const SCOPE_MAX_REQUESTS = Object.freeze({ [API_APPROVAL_SCOPE]: 13, [API_APPROVAL_SCOPE_V2]: 15, [API_APPROVAL_SCOPE_V3]: 15, [API_APPROVAL_SCOPE_V4]: 15, [API_APPROVAL_SCOPE_V5]: 39, [API_APPROVAL_SCOPE_V6]: 39, [API_APPROVAL_SCOPE_V7]: 39 })
export const apiStoreDirectory = (directory, scope = API_APPROVAL_SCOPE) => path.join(path.resolve(directory), crypto.createHash('sha256').update(scope).digest('hex'))
const HEX = /^[a-f0-9]{64}$/
export function readWatermark(file) {
  try {
    const value = readJson(file, 65536), { digest, ...body } = value
    if (body.schema !== 'cfb.api-watermark/1' || !KNOWN_API_SCOPES.includes(body.scope) || !HEX.test(body.planDigest || '') || !HEX.test(body.authorityId || '') || !HEX.test(body.revision || '') || !Number.isSafeInteger(body.sequence) || body.sequence < 1 || !Number.isSafeInteger(body.requests) || body.requests < 0 || body.requests > SCOPE_MAX_REQUESTS[body.scope] || !Number.isSafeInteger(body.reservedNano) || body.reservedNano < 0 || body.reservedNano > 2e9 || !Array.isArray(body.jobs) || body.jobs.length !== body.requests || evidenceDigest(body) !== digest) throw new Error('api-watermark-integrity')
    return immutableJson(value)
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
export function projectWatermark(store, head, state, scope = API_APPROVAL_SCOPE) {
  const body = { schema: 'cfb.api-watermark/1', scope, planDigest: state.planDigest, authorityId: store.authorityId,
    sequence: head.sequence, revision: head.revision, requests: state.entries.length, reservedNano: state.entries.reduce((n, e) => n + e.reservedNano, 0), halted: state.halted,
    jobs: state.entries.map((e) => ({ key: e.key, kind: e.kind, reservedNano: e.reservedNano, status: e.status, ...(e.reason ? { reason: e.reason } : {}) })) }
  return immutableJson({ ...body, digest: evidenceDigest(body) })
}
export function assertWatermark(store, head, state, file, scope = API_APPROVAL_SCOPE) {
  const marker = readWatermark(file)
  if (!head || !marker) throw new Error('api-budget-restore-required')
  if (marker.scope !== scope || marker.authorityId !== store.authorityId || marker.planDigest !== state.planDigest || marker.digest !== projectWatermark(store, head, state, scope).digest) throw new Error('api-watermark-conflict')
  return marker
}
export function assertExistingBudget(directory, file, scope = API_APPROVAL_SCOPE) {
  assertSafePath(file)
  const marker = readWatermark(file)
  if (marker && marker.scope !== scope) throw new Error('api-watermark-conflict')
  if (marker && (!fs.existsSync(path.join(apiStoreDirectory(directory, scope), '.head-api-budget.json')) || !fs.existsSync(path.join(apiStoreDirectory(directory, scope), 'authority.key')))) throw new Error('api-budget-restore-required')
  return marker
}
export function commitWatermark(store, head, state, file, { initial = false, scope = API_APPROVAL_SCOPE } = {}) {
  syncDirectory(store.directory)
  writeJson(file, projectWatermark(store, head, state, scope), { exclusive: initial })
}
