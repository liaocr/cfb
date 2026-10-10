import fs from 'node:fs'
import { judge } from '../tools/gen-ruler.mjs'
const T = String.fromCharCode(96)
const rows = fs.readFileSync('.cfb-offline/teacher/drafts.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const get = (id) => rows.find((o) => o.id === id)

console.log('### 1. 尾斜杠最小复现')
const raw1 = 'x'.repeat(900)
const ctx1 = 'drwxr-xr-x 2 root root 80 Jul 5 05:31 test_results' + String.fromCharCode(10) + 'some context here ' + 'y'.repeat(250)
const body = '目录结构说明：该目录下有 test_results/ 这个子目录，' + '说明文字。'.repeat(60)
const d1 = body.replace('test_results/', T + 'test_results/' + T)
const r1 = judge({ raw: raw1, ctx: ctx1, draft: d1 })
console.log('  ctx 含 test_results =', ctx1.includes('test_results'), '| 含 test_results/ =', ctx1.includes('test_results/'))
console.log('  带尾斜杠 failed =', JSON.stringify(r1.failed), ' invented =', JSON.stringify(r1.detail.quotes.inventedAnchors))
const d1b = body.replace('test_results/', T + 'test_results' + T)
const r1b = judge({ raw: raw1, ctx: ctx1, draft: d1b })
console.log('  去掉尾斜杠 failed =', JSON.stringify(r1b.failed), ' invented =', JSON.stringify(r1b.detail.quotes.inventedAnchors))

console.log('')
console.log('### 2. auth0_auth0-python_pr190#b6 (G3 idRetention=0)')
const o2 = get('auth0_auth0-python_pr190#b6')
console.log('  DRAFT:', JSON.stringify(o2.draft))
console.log('  raw 里 Auth0 次数 =', (o2.raw.match(/Auth0/g) || []).length, '| ctx =', (o2.ctx.match(/Auth0/g) || []).length)

console.log('')
console.log('### 3. adamchainz_flake8-logging_pr4#b7 (G4)')
const o3 = get('adamchainz_flake8-logging_pr4#b7')
console.log('  ratio =', (o3.draft.length / o3.raw.length).toFixed(3))
console.log('  DRAFT:', JSON.stringify(o3.draft))