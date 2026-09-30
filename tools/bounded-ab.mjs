#!/usr/bin/env node
// 兼容旧入口；具体生命周期统一到 effect-ready，无第二套执行/报告实现。
import { pathToFileURL } from 'node:url'
import { readyMain } from './effect-ready.mjs'
export { buildMinimalPlan, summarizeMinimal } from './helpers/eval-plan.mjs'
export async function boundedMain(argv) {
  let mode = 'prepare', seen = false; const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' || argv[i] === '--run') {
      if (seen) throw new Error('eval-option-context')
      seen = true; mode = argv[i] === '--run' ? 'run' : 'prepare'
    } else if (argv[i] === '--pricing' || argv[i] === '--home') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('eval-option-value')
      rest.push(argv[i], argv[++i])
    } else throw new Error('eval-option')
  }
  return readyMain([mode, ...(mode === 'run' ? ['--live'] : []), ...rest])
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) boundedMain(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((e) => {
  console.error(/^(?:eval|api|profile)-[a-z0-9-]+$/.test(e.message || '') ? e.message : 'eval-operation-failed'); process.exitCode = 1
})
