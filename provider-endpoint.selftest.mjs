// provider-endpoint.selftest.mjs —— 端点解析的离线判决（不联网、不花钱、零个人信息）
//
// 2026-09-19 公测可移植性：原版直接读【作者机器上的】真实 ~/.dsh/settings.yaml，
//   并把作者用到的商户域名写进了断言。两个问题：
//     ① 泄漏：测试文件变成商户清单。
//     ② 不可移植：换台机器、别人拿去跑，全部断言直接失败——而失败原因和被测代码无关。
//   改为自带一份**合成 fixture**（写进临时目录，跑完删掉）：断言力不降，去掉外部依赖。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readProviderSpec, endpointUrl, resolveProviderEndpoint } from './index.js'

// ── 合成 settings.yaml：形状与真实文件一致（含 models 块，用来验"不污染字段"）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-endpoint-'))
const SET = path.join(TMP, 'settings.yaml')
fs.writeFileSync(SET, [
  'llm-pi-ai:',
  '  providers:',
  '    alpha:',
  '      apiKeyEnv: ALPHA_KEY',
  '      api: openai-responses',
  '      baseURL: https://alpha.test/v1',
  '      models:',
  '        - id: model-a',
  '        - id: model-b',
  '          name: model-b',
  '    beta:',
  '      apiKeyEnv: BETA_KEY',
  '      api: openai-completions',
  '      baseURL: https://beta.test/v1',
  '      models:',
  '        - id: model-c',
  '    gamma:',
  '      apiKeyEnv: GAMMA_KEY',
  '      api: anthropic-messages',
  '      baseURL: https://gamma.test',
  '    delta:',
  '      displayName: Delta Provider',
  '      apiKeyEnv: DELTA_KEY',
  '      api: openai-responses',
  '      baseURL: https://delta.test/erp/v1',
  '',
].join('\n'), 'utf8')

let pass = 0, fail = 0
const eq = (n, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (ok) pass++; else { fail++; console.log('  ✗ ' + n + '\n      实际=' + JSON.stringify(a) + '\n      期望=' + JSON.stringify(b)) } }
const ok = (n, a) => eq(n, !!a, true)

console.log('== 1. provider 表解析（合成 fixture）==')
const alpha = readProviderSpec(SET, 'alpha')
eq('alpha.api', alpha && alpha.api, 'openai-responses')
eq('alpha.baseURL', alpha && alpha.baseURL, 'https://alpha.test/v1')
eq('alpha.apiKeyEnv', alpha && alpha.apiKeyEnv, 'ALPHA_KEY')
ok('alpha 的 models 块没有污染字段（无 id/name）', alpha && alpha.id === undefined && alpha.name === undefined)
const beta = readProviderSpec(SET, 'beta')
eq('beta.api', beta && beta.api, 'openai-completions')
eq('beta.baseURL', beta && beta.baseURL, 'https://beta.test/v1')
const gamma = readProviderSpec(SET, 'gamma')
eq('gamma.api（anthropic）', gamma && gamma.api, 'anthropic-messages')
const delta = readProviderSpec(SET, 'delta')
eq('delta 带 displayName 也能解析出 baseURL', delta && delta.baseURL, 'https://delta.test/erp/v1')
eq('不存在的 provider ⇒ null', readProviderSpec(SET, 'nope'), null)

console.log('== 2. URL 推导（不写死任何商户地址）==')
eq('responses + /v1 尾', endpointUrl('https://x.test/v1', 'openai-responses'), 'https://x.test/v1/responses')
eq('responses 无 /v1 尾', endpointUrl('https://x.test', 'openai-responses'), 'https://x.test/v1/responses')
eq('completions + /v1 尾', endpointUrl('https://x.test/v1', 'openai-completions'), 'https://x.test/v1/chat/completions')
eq('completions 无 /v1 尾（裸域名形）', endpointUrl('https://x.test', 'openai-completions'), 'https://x.test/v1/chat/completions')
eq('尾部斜杠被吃掉', endpointUrl('https://x.test/v1/', 'openai-responses'), 'https://x.test/v1/responses')
eq('不支持的 api ⇒ null（不猜）', endpointUrl('https://x.test/v1', 'anthropic-messages'), null)
eq('★ 空 baseURL ⇒ null（不乱拼相对 URL）', endpointUrl('', 'openai-completions'), null)
eq('★ undefined baseURL ⇒ null', endpointUrl(undefined, 'openai-completions'), null)

console.log('== 3. 端到端解析 ==')
const cfgAlpha = { settingsPath: SET, followHostProvider: true }
const ep = resolveProviderEndpoint(cfgAlpha, 'alpha')
eq('alpha 解析出的 url', ep && ep.url, 'https://alpha.test/v1/responses')
eq('alpha 解析出的 apiKeyEnv', ep && ep.apiKeyEnv, 'ALPHA_KEY')
eq('alpha 解析出的 api', ep && ep.api, 'openai-responses')
eq('开关关掉 ⇒ null', resolveProviderEndpoint({ settingsPath: SET, followHostProvider: false }, 'alpha'), null)
eq('没有宿主 provider ⇒ null', resolveProviderEndpoint(cfgAlpha, null), null)
eq('provider 不存在 ⇒ null', resolveProviderEndpoint(cfgAlpha, 'nope'), null)
eq('settings 路径不存在 ⇒ null（不抛）', resolveProviderEndpoint({ settingsPath: path.join(TMP, 'none.yaml'), followHostProvider: true }, 'alpha'), null)
eq('anthropic 宿主 ⇒ null（本模块只支持两种 OpenAI 风格）', resolveProviderEndpoint(cfgAlpha, 'gamma'), null)

console.log('== 4. followProvider 经 cfg 传递（与 cfg.model=hm 同构）==')
eq('cfg.followProvider 生效', (resolveProviderEndpoint({ settingsPath: SET, followHostProvider: true, followProvider: 'beta' }) || {}).url, 'https://beta.test/v1/chat/completions')

console.log('== 5. ★ 2026-09-19 加固：没有端点就不猜 ==')
// DEFAULTS.baseUrl 已去具体化（空串）。解析不出宿主 provider 且无人显式配置端点时，
// generateDistillation 抛 no endpoint、distillOnce 抛 no endpoint，两条都由上层降级 rules。
eq('空 baseUrl + 解析不出 ⇒ 没有任何 URL 可拼', endpointUrl('', 'openai-completions'), null)
eq('DEFAULTS.baseUrl 已是空串（不再指向任何商户）',
   (await import('./index.js')).DEFAULTS.baseUrl, '')

fs.rmSync(TMP, { recursive: true, force: true })

console.log('')
console.log('provider-endpoint.js 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) process.exitCode = 1
