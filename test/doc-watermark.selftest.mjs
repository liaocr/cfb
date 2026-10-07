// Verify that documentation watermarks are derived from the current source and that drift is rejected.
// Five isolated negative fixtures exercise the guard itself, not just its happy path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'tools/doc-watermark.mjs')
let pass = 0, fail = 0
const test = (name, fn) => {
  try { fn(); pass++; console.log('PASS ' + name) }
  catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) }
}
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
const marker = '<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->\nplaceholder\n<!-- watermark:end -->'
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-watermark-fixture-'))
  for (const dir of ['src', 'test', 'tools/helpers', 'transfer/gold/family', 'docs', 'transfer']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## v1.2.3（fixture）\n\n')
  // Source copies let the fixture prove both ordinary anchors and their semantic order without importing project code.
  for (const f of ['birth.js', 'compile-v4.js', 'compile-v5-local.js']) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(root, 'src', f))
  fs.writeFileSync(path.join(root, 'test', 'one.selftest.mjs'), '// fixture\n')
  fs.writeFileSync(path.join(root, 'tools', 'one.mjs'), '// fixture\n')
  fs.writeFileSync(path.join(root, 'tools', 'helpers', 'one.mjs'), '// fixture\n')
  fs.writeFileSync(path.join(root, 'transfer', 'gold', 'family', 'one.json'), '{}\n')
  const counts = { srcModules: 3, testSuites: 1, toolsScripts: 1, toolsHelpers: 1, goldItems: 1, goldFamilies: 1 }
  const runRecord = { at: '2026-10-07T00:00:00Z', suitesPass: '1/1 套件', pass: 1, fail: 0, skip: 0, seconds: '0.1' }
  const receipt = { schema: 'cfb.doc-watermark/1', generatedAt: '2026-10-07', counts, version: '1.2.3', selftest: { online: runRecord, isolated: runRecord } }
  fs.writeFileSync(path.join(root, 'transfer', 'watermark.json'), JSON.stringify(receipt, null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'README.md'), `# fixture\n\n${marker}\n\n${marker}\n\n## 5. 当前实测基线（fixture）\n\n读数于 v1.2.3（2026-10-07）。\n`)
  fs.writeFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), `# fixture v1.2.3\n\n${marker}\n`)
  fs.writeFileSync(path.join(root, 'transfer', 'HANDOFF.md'), `# fixture v1.2.3\n\n${marker}\n`)
  const w = run(['--write', '--root', root])
  if (w.status !== 0) throw new Error('fixture generation failed: ' + w.stderr + w.stdout)
  return root
}
function withFixture(testBody) {
  const root = fixture()
  try { testBody(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function assertRejected(root, diagnostic) {
  const r = run(['--check', '--root', root])
  assert.notEqual(r.status, 0, 'drift unexpectedly passed')
  assert.match(r.stderr + r.stdout, diagnostic)
}

try {
  test('current repository watermarks, live version headings, and receipt agree', () => {
    const r = run(['--check'])
    assert.equal(r.status, 0, r.stderr + r.stdout)
  })
  test('negative 1: marked-block and executable-source drift are rejected', () => withFixture((root) => {
    const readme = path.join(root, 'README.md')
    const original = fs.readFileSync(readme, 'utf8')
    fs.writeFileSync(readme, original.replace('v1.2.3', 'v9.9.9'))
    assertRejected(root, /watermark-content-drift:README\.md/)
    fs.writeFileSync(readme, original)

    const file = path.join(root, 'src/birth.js')
    let source = fs.readFileSync(file, 'utf8')
    // The production anchor occurs before the JSON metadata; mutate that executable occurrence, not its declaration.
    const at = source.indexOf('if (!handle) return pass(')
    assert.ok(at >= 0, 'fixture source anchor not found')
    source = source.slice(0, at) + source.slice(at).replace('if (!handle) return pass(', 'if (!handle) return reject(')
    fs.writeFileSync(file, source)
    assertRejected(root, /birth-watermark-code-anchor-missing:1/)
  }))
  test('negative 2: off-block active-document version drift is rejected', () => withFixture((root) => {
    const file = path.join(root, 'docs/ARCHITECTURE.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# fixture v1.2.3', '# fixture v9.9.9'))
    assertRejected(root, /watermark-off-block-version-mismatch:docs\/ARCHITECTURE\.md/)
  }))
  test('negative 3: split marker pair is rejected', () => withFixture((root) => {
    const file = path.join(root, 'docs/ARCHITECTURE.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- watermark:end -->', ''))
    assertRejected(root, /watermark-marker-count:ARCHITECTURE\.md/)
  }))
  test('negative 4: package, changelog, and receipt versions must stay aligned', () => withFixture((root) => {
    const packageFile = path.join(root, 'package.json')
    const changelogFile = path.join(root, 'CHANGELOG.md')
    fs.writeFileSync(changelogFile, '## v1.2.4（fixture）\n\n')
    assertRejected(root, /watermark-changelog-version-mismatch:changelog=1\.2\.4:package=1\.2\.3/)

    fs.writeFileSync(changelogFile, '## v1.2.4（fixture）\n\n')
    fs.writeFileSync(packageFile, JSON.stringify({ version: '1.2.4' }, null, 2) + '\n')
    for (const file of ['docs/ARCHITECTURE.md', 'transfer/HANDOFF.md']) {
      const full = path.join(root, file)
      fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('v1.2.3', 'v1.2.4'))
    }
    const readme = path.join(root, 'README.md')
    fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('读数于 v1.2.3', '读数于 v1.2.4'))
    assertRejected(root, /watermark-version-stale:receipt=1\.2\.3:package=1\.2\.4/)
  }))
  test('negative 5: adding a suite without refreshing the receipt is rejected', () => withFixture((root) => {
    fs.writeFileSync(path.join(root, 'test', 'extra.selftest.mjs'), '// new suite\n')
    assertRejected(root, /watermark-counts-stale:testSuites=1→2/)
  }))
} finally {
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exitCode = fail ? 1 : 0
}
