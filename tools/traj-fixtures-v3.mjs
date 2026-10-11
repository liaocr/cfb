// tools/traj-fixtures-v3.mjs —— PREREG-v8 修复：package.json 的 test 脚本指向 verify.mjs，但 v2 两题的仓库里没有这个文件，
// 而沙箱的 npm test 是 canned 输出（照跑 test/*.selftest.mjs），于是模型会去追「verify.mjs 为什么不存在却是绿的」，这是题目缺陷不是能力。
// v3 只做一件事：给 wrong-model 与 sse-truncated 两题补上一个真实可运行的 verify.mjs（运行 test/*.selftest.mjs，与 README 一致）。
// 其余 files / canned / fixed / prompt 与 v2 逐字相同（从 TRAJ_TASKS_V2 派生，不复制粘贴）。
import { TRAJ_TASKS_V2 } from './traj-fixtures-v2.mjs'

const VERIFY_SRC = `import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const suites = fs.readdirSync('test').filter((f) => f.endsWith('.selftest.mjs')).sort()
let fails = 0
for (const s of suites) {
  const r = spawnSync(process.execPath, ['test/' + s], { encoding: 'utf8' })
  if (r.status === 0) console.log('  PASS test/' + s)
  else { fails++; console.log('  FAIL test/' + s + '\\n' + (r.stdout + r.stderr).trim().split('\\n').slice(0, 12).join('\\n')) }
}
console.log('  合计: ' + (suites.length - fails) + ' 通过 / ' + fails + ' 失败')
process.exitCode = fails ? 1 : 0
`

const FIX_IDS = new Set(['wrong-model', 'sse-truncated'])
export const TRAJ_TASKS_V3 = TRAJ_TASKS_V2.map((t) => {
  if (!FIX_IDS.has(t.id)) return t
  if (t.files['verify.mjs']) throw new Error('v3: verify.mjs 已存在，不应覆盖 ' + t.id)
  return { ...t, files: { ...t.files, 'verify.mjs': VERIFY_SRC } }
})
