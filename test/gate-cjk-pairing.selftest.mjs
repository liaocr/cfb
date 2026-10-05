#!/usr/bin/env node
// test/gate-cjk-pairing.selftest.mjs —— v14.23.0 闸修复的验收：反引号配对段不得把中文散文当标识符
// 起因（t98 实测）：一份 $0 判据全绿的手写稿被 production-gate:invented-identifier 连拒 6 次，
//   拒的「标识符」是「 拉起的这个套件。若不再报 EACCES ⇒ 说明…」这种中文整段 ⇒ 违反 src/fidelity.js 头顶
//   自己写的设计：「刻意不取：中文词」「宁可漏报，不可误报」。
// 本用例要同时钉住两件事，缺一件就是拿修 bug 当放水：
//   A) 中文配对段 / 落单反引号后的中文散文 ⇒ 不报发明；
//   B) 真发明的路径、camelCase、snake_case 仍必须报（含"夹在中文里"的那种）。
import nodeAssert from 'node:assert/strict'
import { inventedIdentifiers } from '../src/fidelity.js'

let pass = 0
const assert = new Proxy(nodeAssert, {
  get: (t, k) => (...a) => { const r = t[k](...a); pass += 1; return r },
  apply: (t, x, a) => { const r = t(...a); pass += 1; return r },
})
const inv = (raw, out, opts) => {
  const r = inventedIdentifiers(raw, out, opts || {})
  const list = Array.isArray(r) ? r : (r && r.invented) || []
  return Array.isArray(list) ? list : []
}

const RAW = 'verify.mjs sets DSH_HOME to a temp dir. trace.js: const home = opts.home || process.env.DSH_HOME. The test passes { home: process.env.CFB_REAL_DSH_HOME }. The dir is /home/u/.dsh/storages/cot-form-b/trace.log owned by root.'

// ── A) 中文稿不再被误杀 ────────────────────────────────────────────────────
{
  const draft = '隔离由 `verify.mjs` 提供。回退写在 `trace.js`。逃逸点是 `{ home: process.env.CFB_REAL_DSH_HOME }` 这一处入参。\n\n验收：跑 `verify.mjs` 拉起的这个套件。若不再报 EACCES ⇒ 说明写入回到临时目录，判已修好。'
  assert.deepEqual(inv(RAW, draft), [], 'A1 逐字接地的中文稿（含反引号片段）必须零发明——t98 就是被这种句子连拒 6 次')
}
{
  const unbalanced = '验收：跑 `verify.mjs 拉起的这个套件。若仍报 EACCES ⇒ 说明还有第二处逃逸，要接着查未解，不要改权限。'
  assert.deepEqual(inv(RAW, unbalanced), [], 'A2 落单反引号后的整段中文不许被当成一个标识符（配对错位的旧行为）')
}
{
  const quoted = '已排除：改权限。原文写了「We can\'t fix #2 without sudo」。未解：「But should I also harden verify.mjs?」'
  assert.deepEqual(inv(RAW, quoted), [], 'A3 「」逐字引用的句子不参与标识符判定')
}

// ── B) 真发明一个都不能漏 ───────────────────────────────────────────────────
{
  const fakePath = inv(RAW, '改法：编辑 `src/evil.js` 里的 handler。')
  assert.ok(fakePath.some((x) => x.includes('src/evil.js')), 'B1 证据里没有的路径必须报（修闸后仍要报）：' + JSON.stringify(fakePath))
}
{
  const fakeIdent = inv(RAW, '调用 rebuildTraceWriter 之后就好。')
  assert.ok(fakeIdent.some((x) => /rebuildTraceWriter/.test(x)), 'B2 证据里没有的 camelCase 必须报：' + JSON.stringify(fakeIdent))
}
{
  const mixedCjk = inv(RAW, '跑 `src/evil.js` 看看。')
  assert.ok(mixedCjk.some((x) => x.includes('src/evil.js')), 'B3 标识符夹在中文里也照报（不是"含中文就整段放过"）：' + JSON.stringify(mixedCjk))
}
{
  const fakeSnake = inv(RAW, '把 hedge_after_ms 调大即可。')
  assert.ok(fakeSnake.some((x) => /hedge_after_ms/.test(x)), 'B4 snake_case 发明必须报：' + JSON.stringify(fakeSnake))
}
{
  const grounded = inv(RAW, '跑 `trace.js` 与 `verify.mjs`，看 /home/u/.dsh/storages/cot-form-b/trace.log。')
  assert.deepEqual(grounded, [], 'B5 全部有出处的写法不该报（反向确认没被改松）')
}

// ── C) new_text 豁免仍在（改法本来就要写新值，不能因此判发明）────────────────
{
  const newText = inv(RAW, '改法只落一个：`old_text` 是 `{ home: process.env.CFB_REAL_DSH_HOME }`，`new_text` 是 `{ home: process.env.DSH_HOME }`。')
  assert.equal(newText.length, 0, 'C1 new_text 段整段豁免，不该被这次修复影响：' + JSON.stringify(newText))
}

console.log(`gate-cjk-pairing: 闸的中文配对误杀已修，且真发明（路径/camelCase/snake_case）零漏报`)
console.log(`PASS=${pass} FAIL=0`)
