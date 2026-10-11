// test/manifest-ignore.selftest.mjs —— 清单必须与 .gitignore 一致（CI 是干净检出，被忽略的文件不存在）。
//
// 回归背景：manifest.mjs 曾经维护一份与 .gitignore 重复的**硬编码**忽略列表。两边不同步时，
// 本地生成的清单会收录被忽略的文件（.cfb-offline/*、eval-profile.json），于是远端 CI 的
// `node manifest.mjs --check` 必然报「缺失」而失败——本地却全绿，问题只在 CI 暴露。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const test = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }

/** 用 git 判定「是否被忽略」——单一事实来源就是 git 自己。 */
const isIgnored = (rel) => {
  // --no-index also evaluates the ignore rule for force-tracked paths (e.g. corpus.json).
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', rel], { cwd: ROOT })
  return r.status === 0
}

try {
  const list = fs.readFileSync(path.join(ROOT, 'MANIFEST.sha256'), 'utf8')
  const rels = list.split('\n').map((l) => /^[0-9a-f]{64}  (.+)$/.exec(l.trim())?.[1]).filter(Boolean)

  test('01 MANIFEST 已生成且非空', () => {
    assert.ok(rels.length > 100, '清单过小，疑似未生成：' + rels.length)
  })
  test('02 清单不得收录任何被 .gitignore 排除的文件（CI 干净检出会缺失）', () => {
    const bad = rels.filter((r) => isIgnored(r))
    assert.deepEqual(bad, [], '以下文件被 git 忽略却写进了清单，CI 必然失败：' + JSON.stringify(bad))
  })
  test('03 清单里每个文件在仓库内真实存在', () => {
    const gone = rels.filter((r) => !fs.existsSync(path.join(ROOT, r)))
    assert.deepEqual(gone, [], '清单包含不存在的文件：' + JSON.stringify(gone.slice(0, 6)))
  })
  test('04 manifest.mjs 不得再维护硬编码的忽略目录列表（必须读 .gitignore）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'manifest.mjs'), 'utf8')
    assert.ok(/\.gitignore/.test(src), 'manifest.mjs 必须读取 .gitignore')
    assert.ok(!/SKIP_DIRS/.test(src), 'manifest.mjs 不应再有 SKIP_DIRS 硬编码列表')
  })
  test('05 已知的本地产物目录必须在忽略规则内（防止有人把它从 .gitignore 删掉）', () => {
    for (const p of ['.cfb-runtime/keep', '.cfb-offline/corpus.json', 'eval-profile.json']) {
      assert.equal(isIgnored(p), true, p + ' 应被 .gitignore 忽略（否则会被写进清单，CI 失败）')
    }
  })
} finally {
  console.log('\n=== manifest-ignore selftest: ' + pass + ' pass / ' + fail + ' fail ===')
  process.exitCode = fail ? 1 : 0
}
