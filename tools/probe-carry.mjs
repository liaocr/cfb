#!/usr/bin/env node
// tools/probe-carry.mjs —— 通道体检：这个 base_url/key/model 能不能跑模式 1（$0 级，只发几个 max_tokens:1）
// 为什么需要它：模式 1 的全部机制是「替换 assistant 消息里的 reasoning_content = 替换主模型看到的思考」。
//   有些网关（含聚合站）会把**入站** reasoning_content 直接剥掉：模型照样能答、照样能出思维链，
//   但你写进稿子里的东西主模型一个字节都看不到 ⇒ raw 臂与 hand 臂输入逐字节相同 ⇒ 对比零信息，钱白花。
//   traj-run 的通道预检里那一项叫「携带」（carry），这里把它单独拿出来，换 key 前 10 秒自测。
// 判据（与 traj-run 同一实现，不另造口径）：① 带 1200 字历史思考 vs 剥掉它，Δprompt_tokens ≥ 0.12×字数；
//   ② 对照组把同字数放进 content —— ② 有 Δ 而 ① 没有 ⇒ 是「专剥 reasoning_content」；② 也 0 ⇒ 计量口径不可比。
//   system_fingerprint == fp_dspure_app_v1 是同一件事的代理证据（有它就不必量）。
// 用法：DEEPSEEK_API_KEY=… DEEPSEEK_BASE_URL=… DEEPSEEK_MODEL=… node tools/probe-carry.mjs [--with-cot]
//   --with-cot 额外发一次 128-token 请求，确认这条通道会不会**返回**思维链（模式 1 两头都要：能收、能出）。
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const { carryCheck } = await import(pathToFileURL(ROOT + 'tools/traj-run.mjs').href)
const { makeChat, TRUSTED_FP, responseText } = await import(pathToFileURL(ROOT + 'tools/effect-eval.mjs').href)

const o = { model: process.env.DEEPSEEK_MODEL || 'deepseek-v4.1-flash', baseUrl: process.env.DEEPSEEK_BASE_URL, apiKey: process.env.DEEPSEEK_API_KEY }
if (!o.baseUrl || !o.apiKey) { console.error('缺 DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY'); process.exit(2) }
const chat = makeChat(o)
const FAKE = '这一段只是用来量通道有没有把历史思考送进模型：先确认 settled.ok 的来源，再看 parseSse 对半包的处理，排除权限路线，下一步读 src/sse.js。'.repeat(15).slice(0, 1200)
const msgs = (payload, text) => [{ role: 'user', content: '1+1=?只答数字。' }, { role: 'assistant', content: text, ...(payload ? { reasoning_content: FAKE } : {}) }, { role: 'user', content: '再答一次。' }]
const tok = async (m) => { try { return Number((await chat({ model: o.model, messages: m, max_tokens: 1, stream: false })).usage?.prompt_tokens) } catch (e) { return NaN } }

let fatal = null
const carry = await carryCheck({ chat, o, messages: msgs(1, '2') }).catch((e) => { fatal = String(e?.message || e); return null })
console.log(`通道 ${o.baseUrl}  模型 ${o.model}`)
if (fatal) { console.log(`✗ 连不上：${fatal.slice(0, 160)}`); process.exit(1) }
console.log(`① 历史思考放 reasoning_content：${FAKE.length} 字 → Δ ${carry.delta} tokens（需 ≥ ${carry.need}）⇒ ${carry.ok ? '携带 ✓' : '剥掉了 ✗'}`)
const withC = await tok(msgs(0, '2 ' + FAKE)), without = await tok(msgs(0, '2'))
console.log(`② 对照组·同字数放 content：Δ ${withC - without} ⇒ ${withC - without >= carry.need ? '计量正常（所以 ① 的 0 是真剥字段）' : '连 content 也不算 ⇒ 这条通道没法用 Δ 判定'}`)
if (process.argv.includes('--with-cot')) {
  try {
    const r = await chat({ model: o.model, messages: [{ role: 'user', content: '一个包里有 3 盒钉，每盒 12 枚。给出总数并写出推理。' }], thinking: { type: 'enabled' }, max_tokens: 150, stream: false })
    console.log(`③ 出思维链：${String(r.message?.reasoning_content || '').length} 字 / 正文 ${responseText(r.message).length} 字 / fp ${JSON.stringify(r.fp || null)} / 回显 ${r.model}`)
  } catch (e) { console.log(`③ 出思维链：请求失败 ${String(e?.message).slice(0, 120)}`) }
}
const ok = carry.ok || TRUSTED_FP.has(carry.fp)
console.log(ok
  ? `\n✓ 可以跑模式 1：node tools/cfb-cycle.mjs plan-traj --n <N> --arms raw,hand --scenarios <家族> … 然后照它打印的 command 跑（hand 臂不花压缩钱）`
  : `\n✗ 不能跑模式 1：主模型看不到手写稿。要么换成 fp=${[...TRUSTED_FP].join('/')} 那类后端，要么换一个不剥入站 reasoning_content 的中转（判据就是 ① 的 Δ）。`)
process.exit(ok ? 0 : 1)
