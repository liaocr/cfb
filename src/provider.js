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
  // ★ 2026-09-27 审计：冒号后只允许**行内**空白（[ \t]*），不能用 \s* —— 它会跨过换行，
  //   把「值为空的键」的下一行（往往是别的键名）当成钥匙读走（自测复现：读到 "OPENAI_API_KEY:"）。
  //   值的三种形态：双引号串 / 单引号串（引号内允许 # 与空格）/ 裸串（到空白或 # 为止）。
  const m = t.match(new RegExp('^[ \\t]*' + esc + ':[ \\t]*(?:"([^"\\r\\n]*)"|\'([^\'\\r\\n]*)\'|([^\\s#]+))', 'm'))
  if (!m) throw new Error(cfg.credentialRef + ' not found in ' + cfg.credentialsPath)
  const v = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])
  if (!v) throw new Error(cfg.credentialRef + ' is empty in ' + cfg.credentialsPath)
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
/** 宿主 provider 表所在的顶层键（与 dsh 的 settings.yaml 契约一致；本模块只认这一段）。 */
export const PROVIDER_TABLE_ROOT = 'llm-pi-ai'

/** YAML 标量的最小解析：去掉行内注释（空白 + #），再剥一层成对引号。不做转义处理（钥匙与 URL 用不到）。 */
function yamlScalar(v) {
  let s = String(v == null ? '' : v).trim()
  if (s.startsWith('"')) { const j = s.indexOf('"', 1); return j > 0 ? s.slice(1, j) : s.slice(1) }
  if (s.startsWith("'")) { const j = s.indexOf("'", 1); return j > 0 ? s.slice(1, j) : s.slice(1) }
  const hash = s.search(/[ \t]#/)
  if (hash >= 0) s = s.slice(0, hash).trim()
  return s
}

function readProviderSpecUncached(settingsPath, providerName) {
  let text
  try { text = fs.readFileSync(settingsPath, 'utf8') } catch { return null }
  // 缩进按「字符数」算；tab 记作 1 个缩进单位以上（YAML 本身禁止 tab 缩进，这里只求单调可比）
  const indentOf = (s) => s.length - s.replace(/^[ \t]*/, '').length
  // ★ 2026-09-27 审计：此前只找**文件里第一个** `providers:`，不看它的父键。settings.yaml 里任何插件
  //   只要在 llm-pi-ai 之前也有一段 providers:（自测复现），端点与钥匙名就会解析到别人的表上 ——
  //   推理原文 + 钥匙发往一个不属于宿主 provider 的 baseURL，且无任何留痕。违反不变式④「不猜」。
  //   现在用缩进栈追踪父键：只接受父键恰为 PROVIDER_TABLE_ROOT 的那一段 providers:。
  const stack = []   // [{ indent, key }]，当前行的祖先链
  let pIndent = -1, nameIndent = -1, cur = null, hit = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^[ \t]*#/.test(raw)) continue
    const i = indentOf(raw)
    const body = raw.trim()
    if (pIndent < 0) {
      while (stack.length && stack[stack.length - 1].indent >= i) stack.pop()
      // 键名允许裸写或加引号（YAML 两种写法等价）
      const km = body.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.\-]+)):(?:[ \t]+.*)?$/)
      const key = km ? (km[1] ?? km[2] ?? km[3]) : null
      if (key === 'providers' && /^(?:"providers"|'providers'|providers):[ \t]*(?:#.*)?$/.test(body)
          && stack.length && stack[stack.length - 1].key === PROVIDER_TABLE_ROOT) { pIndent = i; continue }
      if (key) stack.push({ indent: i, key })
      continue
    }
    if (i <= pIndent) break
    if (nameIndent < 0) nameIndent = i
    if (i === nameIndent) {
      const m = body.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.\-]+)):[ \t]*(?:#.*)?$/)
      cur = m ? (m[1] ?? m[2] ?? m[3]) : null
      if (cur && cur === providerName) hit = {}
      continue
    }
    if (i > nameIndent && cur === providerName && hit) {
      const m = body.match(/^([A-Za-z0-9_]+):[ \t]*(.+?)[ \t]*$/)
      if (m) { const k = m[1]; if (k !== 'id' && k !== 'name') { const v = yamlScalar(m[2]); if (v) hit[k] = v } }
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
