// dsh-cot-form-b / provider.js —— 副模型端点与凭据解析（跟随宿主 provider，解析不出来不猜）
//
//   resolveProviderEndpoint  settings.yaml → llm-pi-ai.providers.<宿主 provider> → { url, api, apiKeyEnv }
//   readApiKey / readApiKeyRef  .credentials.yaml 里按键名取钥匙（行首锚定 + 键名转义 + 剥引号）
import fs from 'node:fs'
import { DEFAULTS } from './config.js'

// ── v11.10 按文件身份缓存（stat 校验）──────────────────────────────────────
// 此前每次副模型调用都重新读取并逐行解析 settings.yaml 与 .credentials.yaml（同步 I/O，热路径上）。
// 现在只 stat 一次：文件身份（ino/size/mtime/ctime）不变 ⇒ 复用上次的解析结果；一变就重读。
// ⚠ 凭据缓存只存「按键名取出的那一个值」，不在内存里常驻整份凭据文件。
const fileCache = new Map()   // kind|path|name -> { sig, value }
const CACHE_MAX = 64
function fileSig(file) {
  try { const st = fs.statSync(file); return st.ino + ':' + st.size + ':' + st.mtimeMs + ':' + st.ctimeMs } catch { return null }
}
function cached(kind, file, name, compute) {
  const sig = fileSig(file)
  if (sig === null) return compute()        // 读不到 ⇒ 走原路径（它会给出原有的报错/null 语义）
  const k = kind + '|' + file + '|' + name
  const hit = fileCache.get(k)
  if (hit && hit.sig === sig) return hit.value
  const value = compute()
  fileCache.delete(k); fileCache.set(k, { sig, value })
  while (fileCache.size > CACHE_MAX) fileCache.delete(fileCache.keys().next().value)
  return value
}
/** 测试 / 诊断用：清空解析缓存。 */
export function clearProviderCache() { fileCache.clear() }

// ── 伴生调用 ────────────────────────────────────────────────────────────────
/**
 * 按键名从 credentials 文件取钥匙。
 *
 * ⛔ 匹配必须【锚定行首 + 转义键名】：
 *   旧版 `new RegExp(ref + ':\\s*([^\\s]+)')` 有两个已复现的坑：
 *   ① 不锚定 ⇒ 在 `MY_DEEPSEEK_API_KEY: sk-WRONG` 里查 `DEEPSEEK_API_KEY` 会命中
 *      （子串匹配），静默拿错钥匙 —— 比抛错难查得多；
 *   ② 键名直接进正则 ⇒ 特殊字符会改变语义；值带引号时引号会被当成钥匙的一部分。
 * 空 ref 仍然先拦：没指定过钥匙名 ⇒ 明确失败（上层原文放行）。
 */
export function readApiKey(cfg) {
  if (!cfg.credentialRef) throw new Error('credentialRef is empty: no key name was resolved or configured')
  // 只缓存成功结果：找不到键时照旧每次抛错（不缓存异常，避免把一次瞬时错误钉住）
  return cached('cred', cfg.credentialsPath, String(cfg.credentialRef), () => readApiKeyUncached(cfg))
}
function readApiKeyUncached(cfg) {
  const t = fs.readFileSync(cfg.credentialsPath, 'utf8')
  const esc = String(cfg.credentialRef).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = t.match(new RegExp('^[ \\t]*' + esc + ':\\s*([^\\s#]+)', 'm'))
  if (!m) throw new Error(cfg.credentialRef + ' not found in ' + cfg.credentialsPath)
  const v = m[1]
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) return v.slice(1, -1)
  return v
}

// 按【任意键名】取钥匙（从宿主 provider 的 apiKeyEnv 来，不写死具体名字）
export function readApiKeyRef(cfg, refName) {
  if (!refName) throw new Error('apiKeyEnv is empty')
  return readApiKey(Object.assign({}, cfg, { credentialRef: refName }))
}

// ── 宿主 provider 端点解析（禁止硬编码端点/钥匙）─────────────────────────────
// 只认 settings.yaml 里这一段（缩进解析，零 YAML 依赖）：
//   llm-pi-ai:
//     providers:
//       <name>:
//         apiKeyEnv: X
//         api: openai-completions | openai-responses | anthropic-messages
//         baseURL: https://...
export function readProviderSpec(settingsPath, providerName) {
  if (!providerName) return null
  const spec = cached('spec', settingsPath, String(providerName), () => readProviderSpecUncached(settingsPath, providerName))
  return spec ? { ...spec } : null   // 返回副本：调用方改它不会污染缓存
}
function readProviderSpecUncached(settingsPath, providerName) {
  let text
  try { text = fs.readFileSync(settingsPath, 'utf8') } catch { return null }
  const indentOf = (s) => s.length - s.replace(/^[ \t]*/, '').length
  let pIndent = -1, nameIndent = -1, cur = null, hit = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^[ \t]*#/.test(raw)) continue
    const i = indentOf(raw)
    const body = raw.trim()
    if (pIndent < 0) { if (/^providers:\s*$/.test(body)) pIndent = i; continue }
    if (i <= pIndent) break
    if (nameIndent < 0) nameIndent = i
    if (i === nameIndent) {
      const m = body.match(/^([A-Za-z0-9_.\-]+):\s*$/)
      cur = m ? m[1] : null
      if (cur && cur === providerName) hit = {}
      continue
    }
    if (i > nameIndent && cur === providerName && hit) {
      const m = body.match(/^([A-Za-z0-9_]+):\s*(.+?)\s*$/)
      if (m) { const k = m[1]; if (k !== 'id' && k !== 'name') hit[k] = m[2].replace(/^['"]|['"]$/g, '') }
    }
  }
  return hit && hit.baseURL ? hit : null
}

// 端点 URL 一律由 baseURL + api 风格推导 —— 不在任何地方写死商户地址
export function endpointUrl(baseURL, api) {
  const b = String(baseURL || '').replace(/\/+$/, '')
  if (!b) return null
  if (api === 'openai-responses') return /\/v1$/.test(b) ? b + '/responses' : b + '/v1/responses'
  if (api === 'openai-completions') return /\/v1$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions'
  return null
}

// 解析宿主 provider 的 {api, url, apiKeyEnv}；解析不出/不支持 ⇒ null（回落到显式配置）
export function resolveProviderEndpoint(cfg, providerName) {
  if (!cfg || cfg.followHostProvider === false) return null
  const name = providerName || cfg.followProvider
  if (!name) return null
  const spec = readProviderSpec(cfg.settingsPath || DEFAULTS.settingsPath, name)
  if (!spec) return null
  const api = spec.api || 'openai-completions'
  const url = endpointUrl(spec.baseURL, api)
  if (!url) return null
  return { provider: name, api, url, apiKeyEnv: spec.apiKeyEnv || null, baseURL: spec.baseURL }
}
