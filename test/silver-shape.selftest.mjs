#!/usr/bin/env node
// test/silver-shape.selftest.mjs —— 形状检查器（tools/silver-shape.mjs）的回归
// 为什么单独钉：它管的是**银标**批量产出的形状，判据一漂就会成批产出"过闸但没归因"的训练样本。
// 它不评金标 —— 金标只认真机 outcome（见 tools/silver-shape.mjs 文件头定位段）。
// 这里既测「该放的放过」，也测「该挡的挡住」——只测前者等于没有闸。
import nodeAssert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (target, kind) => (...args) => { const r = target[kind](...args); pass += 1; return r },
  apply: (target, thisArg, args) => { const r = target(...args); pass += 1; return r },
})
const ROOT = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-shape-'))
const plan = path.join(tmp, '.cfb-runtime', 'traj', 'tX')
fs.mkdirSync(path.join(plan, 'pending'), { recursive: true })
fs.mkdirSync(path.join(plan, 'drafts'), { recursive: true })

const RAW = ['调查 `src/a.js` 的 `hedgedCall`：`primarySettled` 在 `primary.then` 里置位，`setTimeout` 到 `hedgeAfterMs` 1600 时若仍为 false 就触发。',
  '本地 16 核从不失败，CI 2 核每 5 次 1 次 FAIL，报 `expected hedgeStartedAt=null, got 1712`。',
  '先连跑 8 次看 `hedgeStartedAt=` 是什么，再决定动不动 `src/a.js`。'].join('\n')
const CTX = 'CI 里 test/a.selftest.mjs 每 5 次失败 1 次，本地从不失败。【台账】已走过的路：第 1 轮 bash `cat ci/last5.log` → 「run 2: FAIL」；第 2 轮 for 循环 → 「bash: 该沙箱不支持 shell 循环，请直接跑单条命令」；这些不再重跑。'
fs.writeFileSync(path.join(plan, 'pending', 'a-s0-r3.json'), JSON.stringify({ id: 'a-s0-r3', raw: RAW, ctx: CTX, calls: [], minChars: 3100 }))

const run = (draftText) => {
  const file = path.join(plan, 'drafts', 'a-s0-r3.md')
  fs.writeFileSync(file, draftText)
  // 检查器对 needs-work 是 exit 1，execFileSync 会抛；stdout 里的 JSON 才是判据，必须捞出来看
  let out
  try { out = execFileSync(process.execPath, [path.join(ROOT, 'tools/silver-shape.mjs'), file, '--id', 'a-s0-r3', '--plan', plan, '--json'], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { out = String(e.stdout || '') }
  if (!out.trim()) throw new Error('检查器没有输出 JSON：' + out)
  return JSON.parse(out)[0]
}
const names = (r) => r.missing

// A. 形状齐的稿：全过
const good = `本轮只取证，没定怎么动 \`src/a.js\`，本稿不替它定。

已观察到的事实：\`hedgedCall\` 的 \`primarySettled\` 在 \`primary.then\` 里置位，\`setTimeout\` 到 \`hedgeAfterMs\` 1600 时门闩仍 false 就触发，所以 1600 与 1500 只差 100ms。

已排除：定时器提前触发这条不成立——负载重时定时器只会迟到，迟到时 \`primarySettled\` 已是 true，\`hedgeStartedAt\` 该是 null，与 got 1712 相反。
已排除：\`for\` 循环拼命令这条排除，第 2 轮的回显是「bash: 该沙箱不支持 shell 循环，请直接跑单条命令」，拿不到文件内容。

本轮增量：等那 8 次的回显，读数里出现非空 \`hedgeStartedAt\` ⇒ 说明本地就量得出来，先按 100ms 余量太窄来谈；8 次全是 null ⇒ 说明本地量不出来，得换能压住事件循环的方式，此时别动 \`src/a.js\`。

还没定：\`test/a.selftest.mjs\` 里 \`hedgeAfterMs\` 取值是不是贴脸写的，第 3 轮没定。`
const r0 = run(good)
assert.equal(r0.verdict, 'silver-ok', JSON.stringify(r0.layers.filter((l) => !l[1]).map((l) => l[0])))
assert.ok(!names(r0).length)

// B. 空洞排除（只有结论、没理由）⇒ 必须挡
const r1 = run(good.replace(/已排除：定时器提前触发这条不成立——[^\n]*/, '已排除：定时器提前触发。'))
assert.ok(names(r1).includes('L2 排除带理由'), '空洞排除必须被 L2 挡住')

// C. 一条排除都没有 ⇒ 那是摘要不是归因
const r2 = run(good.split('\n').filter((l) => !/^已排除/.test(l)).join('\n'))
assert.ok(names(r2).includes('L2 排除带理由'), '一条排除都没有 ⇒ 不算归因，L2 挡')

// D. 原文没下决定，稿里却写落点句 ⇒ 挡（invented-decision 的写稿阶段版）
const r3 = run(good + '\n\n改法只落一个：把 `hedgeAfterMs` 拉到 5000。\n')
assert.ok(names(r3).includes('L3 落点与原文一致'), '原文没下决定时不许出现落点句 ⇒ L3 挡')

// E. 没到手材料的处置：两种合法形态都要认，都没有要挡
const noBranch = good.split('\n').filter((l) => !/本轮增量/.test(l)).join('\n')
assert.ok(names(run(noBranch)).includes('L4 未到手材料的处置'), '既没预注册分叉也没交代 ⇒ L4 挡')
// E-b. 这一格本就没有会改变归因的待读读数 ⇒ 形态 b（点名欠的动作）必须放行，不许逼它照某份老稿的句式造句
assert.ok(!names(run(noBranch + '\n本轮没有待读的回显：第 4 轮欠的是把已定的 edits 发出去。\n')).includes('L4 未到手材料的处置'), '形态 b 要放行')
// E-c. 光写"没查"不是交代 ⇒ 仍挡（防形态 b 变成偷懒通道）
assert.ok(names(run(noBranch + '\n这块没查。\n')).includes('L4 未到手材料的处置'), '"没查"不算处置 ⇒ 必须仍挡')

// F. 机制描述里的「若…就…」不得当成预注册（判据不能靠"有个若字"糊过去）
const mechOnly = noBranch.replace(/还没定：[^\n]*/, '还没定：`setTimeout` 到 `hedgeAfterMs` 时若门闩仍是 false 就走 `startHedge`，这条链路本身没查。')
assert.ok(names(run(mechOnly)).includes('L4 未到手材料的处置'), '只在描述机制的句子里出现「若」不算预注册 ⇒ 必须仍挡')

// G. 未解为空 ⇒ 挡。注意首行「本轮只取证，没定怎么动…」本身就会被 slotsOf 记成 open 槽，
//    所以要连那句免责一起摘掉，否则测的是「有未解」而不是「没未解」。
assert.ok(names(run(mechOnly.split('\n').filter((l) => !/^还没定/.test(l) && !/^本轮只取证/.test(l)).join('\n'))).includes('L5 未解与待办'), '没留未解 ⇒ L5 挡')

// H. 定罪词裸奔（"必然"）要被 L6 挡，哪怕内容本身没错
assert.ok(names(run(good + '\n负载一重定时器就迟到，这是必然的。\n')).includes('L6 越界嫌疑句'), '"必然"不在定界符内 ⇒ L6 挡')

// I. 找不到 pending 要报错，不能默认放行
let died = false
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/silver-shape.mjs'), path.join(plan, 'drafts', 'a-s0-r3.md'), '--id', 'ghost', '--plan', plan], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' })
} catch (e) { died = /找不到 pending/.test(String(e.stdout) + String(e.stderr)) }
assert.ok(died, 'pending 缺失必须失败关闭')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('silver-shape: 形状检查器的放行与拦截（空洞排除 / 无排除 / 替主模型下决定 / 两种处置形态 / 偷懒式交代 / 机制句不算预注册 / 无未解 / 裸定罪词 / pending 缺失 fail-closed）通过')
console.log(`PASS=${pass} FAIL=0`)
