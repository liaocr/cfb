#!/usr/bin/env node
// Keep generated documentation watermarks tied to the checked-in source and measured test receipts.
// No dependencies, network access, API keys, or guessed test counts.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECEIPT_SCHEMA = 'cfb.doc-watermark/1'
const DOCS = [
  { file: 'README.md', blocks: ['summary', 'gates'] },
  { file: 'docs/ARCHITECTURE.md', blocks: ['gates'] },
  { file: 'transfer/HANDOFF.md', blocks: ['summary'] },
]
const BLOCK_RE = /(<!-- watermark:begin[^\r\n]*-->)[ \t]*\r?\n([\s\S]*?)\r?\n(<!-- watermark:end -->)/g

function fail(message) { throw new Error(message) }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (e) { fail(`cannot-read-json:${path.relative(SCRIPT_ROOT, file)}:${e.message}`) }
}
function walkFiles(root, rel, predicate, recursive = true) {
  const base = path.join(root, rel)
  if (!fs.existsSync(base)) return []
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (recursive) visit(full); continue }
      if (entry.isFile() && predicate(entry.name)) out.push(full)
    }
  }
  visit(base)
  return out
}
function countDirect(root, rel, predicate) {
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && predicate(e.name)).length
}
function currentShape(root) {
  const goldFiles = walkFiles(root, 'transfer/gold', (n) => n.endsWith('.json'))
  const families = new Set(goldFiles.map((f) => path.relative(path.join(root, 'transfer/gold'), f).split(path.sep)[0]))
  return {
    srcModules: walkFiles(root, 'src', (n) => n.endsWith('.js')).length,
    testSuites: countDirect(root, 'test', (n) => n.endsWith('.selftest.mjs')),
    toolsScripts: countDirect(root, 'tools', (n) => n.endsWith('.mjs')),
    toolsHelpers: walkFiles(root, 'tools/helpers', (n) => n.endsWith('.mjs')).length,
    goldItems: goldFiles.length,
    goldFamilies: families.size,
  }
}
function loadSourceWatermark(root) {
  const file = path.join(root, 'src/birth.js')
  const source = fs.readFileSync(file, 'utf8')
  const re = /\/\* DOC-WATERMARK-BEGIN\s*\r?\n([\s\S]*?)\r?\nDOC-WATERMARK-END \*\//g
  const matches = [...source.matchAll(re)]
  if (matches.length !== 1) fail(`birth-watermark-metadata-count:${matches.length}`)
  let meta
  try { meta = JSON.parse(matches[0][1]) }
  catch (e) { fail(`birth-watermark-metadata-json:${e.message}`) }
  if (!meta || !Array.isArray(meta.gates) || meta.gates.length !== 6) fail('birth-watermark-requires-six-gates')
  const executableSource = source.replace(matches[0][0], '')
  for (const [i, gate] of meta.gates.entries()) {
    if (!gate || typeof gate.title !== 'string' || typeof gate.detail !== 'string' || !Array.isArray(gate.anchors) || !gate.anchors.length) {
      fail(`birth-watermark-invalid-gate:${i + 1}`)
    }
    for (const anchor of gate.anchors) {
      if (typeof anchor !== 'string' || !anchor || !executableSource.includes(anchor)) fail(`birth-watermark-code-anchor-missing:${i + 1}:${String(anchor)}`)
    }
  }
  if (typeof meta.closingNote !== 'string' || !Array.isArray(meta.closingAnchors) || !meta.closingAnchors.length) fail('birth-watermark-invalid-closing-note')
  for (const item of meta.closingAnchors) {
    if (!item || typeof item.file !== 'string' || typeof item.text !== 'string') fail('birth-watermark-invalid-closing-anchor')
    const anchorFile = path.join(root, item.file)
    if (!fs.existsSync(anchorFile) || !fs.readFileSync(anchorFile, 'utf8').includes(item.text)) fail(`birth-watermark-closing-anchor-missing:${item.file}:${item.text}`)
  }
  // Keep the conceptual gate order tied to the actual production call chain.
  const finishStart = executableSource.indexOf('export async function birthFinish(')
  const acceptCall = executableSource.indexOf('const acc = birthAccept(raw, candidate, cfgAcc)', finishStart)
  const archiveGate = executableSource.indexOf('if (!handle) return pass(', finishStart)
  if (finishStart < 0 || archiveGate < 0 || acceptCall < 0 || archiveGate > acceptCall) fail('birth-watermark-gate-order-drift:archive-before-accept-required')
  const acceptStart = executableSource.indexOf('function birthAcceptWithScanner(')
  const acceptEnd = executableSource.indexOf('// Internal fault-injection seam', acceptStart)
  if (acceptStart < 0 || acceptEnd < 0) fail('birth-watermark-accept-function-not-found')
  const acceptSource = executableSource.slice(acceptStart, acceptEnd)
  const emptyAt = acceptSource.indexOf("why: 'empty-candidate'")
  const inventedAt = acceptSource.indexOf("why: 'invented-identifier'")
  const scanErrorAt = acceptSource.indexOf("why: 'identifier-check-error'")
  const tokenGuardAt = acceptSource.indexOf('netSavedTokensEst < minSavedTokens')
  const charGuardAt = acceptSource.indexOf("why: 'no-gain'")
  if (!(emptyAt >= 0 && inventedAt > emptyAt && scanErrorAt > emptyAt && tokenGuardAt >= 0 && charGuardAt > tokenGuardAt)) {
    fail('birth-watermark-gate-order-drift:accept-guards-changed')
  }
  if (!executableSource.includes("why: 'condensed'")) fail('birth-watermark-condensed-outcome-missing')
  return meta
}
function validateCurrentDocClaims(root, pkg) {
  const expected = String(pkg.version)
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const changelogVersion = /^##\s+v(\d+\.\d+\.\d+)\b/m.exec(changelog)?.[1]
  if (!changelogVersion) fail('watermark-changelog-version-heading-missing')
  if (changelogVersion !== expected) fail(`watermark-changelog-version-mismatch:changelog=${changelogVersion}:package=${expected}`)

  for (const { file } of DOCS) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const heading = text.split(/\r?\n/).find((line) => /^#\s+/.test(line)) || ''
    const headingVersion = /\bv(\d+\.\d+\.\d+)\b/.exec(heading)?.[1]
    if (headingVersion && headingVersion !== expected) {
      fail(`watermark-off-block-version-mismatch:${file}:heading=${headingVersion}:package=${expected}`)
    }
  }

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const sectionAt = readme.search(/^## 5\. 当前实测基线/m)
  if (sectionAt >= 0) {
    const bodyStart = readme.indexOf('\n', sectionAt) + 1
    const rest = readme.slice(bodyStart)
    const nextSection = rest.search(/^##\s/m)
    const section = nextSection >= 0 ? rest.slice(0, nextSection) : rest
    const baselineVersion = /\bv(\d+\.\d+\.\d+)\b/.exec(section)?.[1]
    if (!baselineVersion) fail('watermark-readme-baseline-version-missing')
    if (baselineVersion !== expected) fail(`watermark-off-block-version-mismatch:README.md:baseline=${baselineVersion}:package=${expected}`)
  }
}
function validateReceiptAndShape(root) {
  const pkg = readJson(path.join(root, 'package.json'))
  validateCurrentDocClaims(root, pkg)
  const receipt = readJson(path.join(root, 'transfer/watermark.json'))
  if (receipt.schema !== RECEIPT_SCHEMA) fail(`watermark-schema:${receipt.schema || 'missing'}`)
  if (String(receipt.version) !== String(pkg.version)) fail(`watermark-version-stale:receipt=${receipt.version}:package=${pkg.version}; run watermark:record`)
  const shape = currentShape(root)
  const keys = Object.keys(shape)
  const stale = keys.filter((k) => Number(receipt.counts?.[k]) !== shape[k])
  if (stale.length) fail(`watermark-counts-stale:${stale.map((k) => `${k}=${receipt.counts?.[k]}→${shape[k]}`).join(',')}; run watermark:record`)
  for (const lane of ['online', 'isolated']) {
    const r = receipt.selftest?.[lane]
    if (!r || typeof r.at !== 'string' || typeof r.suitesPass !== 'string' || !Number.isFinite(r.pass) || !Number.isFinite(r.fail) || !Number.isFinite(r.skip) || typeof r.seconds !== 'string') {
      fail(`watermark-selftest-receipt-invalid:${lane}`)
    }
  }
  return { pkg, receipt, shape }
}
function ratioOf(run, lane) {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(run.suitesPass || ''))
  if (!m) fail(`watermark-suite-ratio-invalid:${lane}:${run.suitesPass}`)
  return `${m[1]}/${m[2]} 套件通过`
}
function formatRun(run, lane) {
  return `${ratioOf(run, lane)} · \`${run.pass} 通过 / ${run.fail} 失败 / ${run.skip} 跳过\``
}
function summaryBody(data, style) {
  const { pkg, receipt, shape } = data
  const version = `v${pkg.version}`
  const online = formatRun(receipt.selftest.online, 'online')
  const isolated = formatRun(receipt.selftest.isolated, 'isolated')
  const scale = `**规模**：\`src/\` ${shape.srcModules} 个零依赖模块 · \`tools/\` ${shape.toolsScripts} 个脚本 + ${shape.toolsHelpers} 个 helpers · \`test/\` ${shape.testSuites} 套自测 · \`transfer/gold/\` ${shape.goldItems} 条（${shape.goldFamilies} 个家族）`
  if (style === 'handoff') return [
    `- **当前版本：${version}** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块）`,
    '- **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**',
    `- 验收口径 \`npm run verify:offline\`（真断网 Linux 命名空间）：${isolated}`,
    `- 快速自检 \`npm test\`（联网机上跑，需要隔离的那条断言按设计跳过）：${online}`,
    '- 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。',
    `- ${scale}`,
  ].join('\n')
  return [
    `> **当前版本：${version}** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块）`,
    '> **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**',
    `> · 验收口径 \`npm run verify:offline\`（真断网 Linux 命名空间）：${isolated}`,
    `> · 快速自检 \`npm test\`（联网机上跑，需要隔离的那条断言按设计跳过）：${online}`,
    '> 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。',
    `> ${scale}`,
  ].join('\n')
}
function gatesBody(meta) {
  return meta.gates.map((g, i) => `${i + 1}. ${g.title} —— ${g.detail}`).join('\n') + '\n\n' + meta.closingNote
}
function expectedBodies(root, data, gateMeta) {
  const render = (type, file) => type === 'summary'
    ? summaryBody(data, file === 'transfer/HANDOFF.md' ? 'handoff' : 'readme')
    : gatesBody(gateMeta)
  return Object.fromEntries(DOCS.map(({ file, blocks }) => [file, blocks.map((b) => render(b, file))]))
}
function rewriteMarkedText(file, types, bodies, { checkOnly = false } = {}) {
  let text = fs.readFileSync(file, 'utf8')
  const expectedBegins = (text.match(/<!-- watermark:begin\b/g) || []).length
  const expectedEnds = (text.match(/<!-- watermark:end\s*-->/g) || []).length
  const matches = [...text.matchAll(BLOCK_RE)]
  if (expectedBegins !== types.length || expectedEnds !== types.length || matches.length !== types.length) {
    fail(`watermark-marker-count:${path.basename(file)}:expected=${types.length}:begin=${expectedBegins}:end=${expectedEnds}:paired=${matches.length}`)
  }
  let i = 0
  const diffs = []
  text = text.replace(BLOCK_RE, (whole, begin, body, end) => {
    const expected = bodies[i]
    const normalized = body.replace(/\r\n/g, '\n')
    if (normalized !== expected) diffs.push(i + 1)
    i++
    return checkOnly ? whole : `${begin}\n${expected}\n${end}`
  })
  if (checkOnly && diffs.length) fail(`watermark-content-drift:${path.basename(file)}:blocks=${diffs.join(',')}; run npm run watermark`)
  if (!checkOnly && diffs.length) fs.writeFileSync(file, text)
  return diffs.length > 0
}
function writeAll(root, data, gateMeta) {
  const bodies = expectedBodies(root, data, gateMeta)
  const changed = []
  for (const doc of DOCS) {
    const file = path.join(root, doc.file)
    if (rewriteMarkedText(file, doc.blocks, bodies[doc.file])) changed.push(doc.file)
  }
  return changed
}
function checkAll(root, data, gateMeta) {
  const bodies = expectedBodies(root, data, gateMeta)
  for (const doc of DOCS) rewriteMarkedText(path.join(root, doc.file), doc.blocks, bodies[doc.file], { checkOnly: true })
}
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, file)
}
function isoDay(at) { return at.toISOString().slice(0, 10) }
function runCommand(root, args, label) {
  const env = { ...process.env }
  // Recording is a zero-API maintenance command; do not expose model credentials to tests.
  for (const key of Object.keys(env)) if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE|CFB_JUDGE|CFB_PROPOSER).*?(?:KEY|TOKEN|SECRET)$/i.test(key)) delete env[key]
  const r = spawnSync(process.execPath, args, {
    cwd: root, env, encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024,
  })
  const output = String(r.stdout || '') + String(r.stderr || '')
  if (r.error) fail(`${label}-spawn-error:${r.error.message}`)
  const m = /合计:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*(\d+)\s*跳过\s*\((\d+)\s*\/\s*(\d+)\s*套件通过\)[^\n]*?用时\s*([\d.]+)s/.exec(output)
  if (!m) fail(`${label}-summary-unparseable; tail:\n${output.split('\n').slice(-15).join('\n')}`)
  return {
    at: new Date().toISOString(),
    suitesPass: `${m[4]}/${m[5]} 套件`,
    pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3]), seconds: m[6],
    exitCode: r.status == null ? 1 : r.status,
    output,
  }
}
function printRun(label, run) {
  const ratio = ratioOf(run, label)
  console.log(`${label}: ${ratio}; ${run.pass} passed, ${run.fail} failed, ${run.skip} skipped; ${run.seconds}s (exit ${run.exitCode})`)
  if (run.exitCode !== 0 || run.fail !== 0 || !/^([0-9]+)\s*\/\s*\1\s/.test(run.suitesPass)) {
    console.error(run.output.split('\n').slice(-35).join('\n'))
  }
}
function record(root, gateMeta) {
  if (path.resolve(root) !== SCRIPT_ROOT) fail('--record-is-only-supported-in-the-real-checkout')
  const pkg = readJson(path.join(root, 'package.json'))
  validateCurrentDocClaims(root, pkg)
  const receiptFile = path.join(root, 'transfer/watermark.json')
  const prior = readJson(receiptFile)
  if (prior.schema !== RECEIPT_SCHEMA) fail(`watermark-schema:${prior.schema || 'missing'}`)

  // Record is transactional: stage fresh counts so the watermark selftest can run, but restore every
  // touched file if either full verification lane fails or cannot be parsed.
  const touched = [receiptFile, ...DOCS.map(({ file }) => path.join(root, file))]
  const backups = new Map(touched.map((file) => [file, fs.readFileSync(file, 'utf8')]))
  let committed = false
  try {
    let data = {
      ...prior,
      generatedAt: isoDay(new Date()), // UTC calendar day; detailed run timestamps carry a trailing Z.
      counts: currentShape(root),
      version: String(pkg.version),
    }
    // Bring structure/version blocks in sync before the watermark selftest runs.
    atomicWrite(receiptFile, JSON.stringify(data, null, 2) + '\n')
    writeAll(root, { pkg, receipt: data, shape: data.counts }, gateMeta)

    const online = runCommand(root, ['verify.mjs'], 'online')
    const isolated = runCommand(root, ['tools/verify-offline.mjs'], 'isolated')
    printRun('online', online)
    printRun('isolated', isolated)
    const runFailed = [online, isolated].some((r) => r.exitCode !== 0 || r.fail !== 0 || !/^([0-9]+)\s*\/\s*\1\s/.test(r.suitesPass))
    if (runFailed) fail('record-refused:one-or-more-verification-lanes-not-fully-green; previous receipt and docs restored')

    data = {
      ...data,
      generatedAt: isoDay(new Date()),
      selftest: {
        ...data.selftest,
        online: { at: online.at, suitesPass: online.suitesPass, pass: online.pass, fail: online.fail, skip: online.skip, seconds: online.seconds },
        isolated: { at: isolated.at, suitesPass: isolated.suitesPass, pass: isolated.pass, fail: isolated.fail, skip: isolated.skip, seconds: isolated.seconds },
      },
    }
    atomicWrite(receiptFile, JSON.stringify(data, null, 2) + '\n')
    const fresh = validateReceiptAndShape(root)
    writeAll(root, fresh, gateMeta)
    checkAll(root, fresh, gateMeta)
    committed = true
    console.log('watermark: receipt recorded; online and isolated suites are fully PASS')
  } finally {
    if (!committed) {
      for (const [file, text] of backups) atomicWrite(file, text)
    }
  }
}
function parseArgs(argv) {
  const modes = argv.filter((a) => ['--check', '--write', '--record'].includes(a))
  if (modes.length !== 1) fail('usage: node tools/doc-watermark.mjs --check|--write|--record [--root DIR]')
  let root = SCRIPT_ROOT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (!argv[i + 1]) fail('--root-needs-directory')
      root = path.resolve(argv[++i])
    } else if (!['--check', '--write', '--record'].includes(argv[i])) fail(`unknown-argument:${argv[i]}`)
  }
  return { mode: modes[0], root }
}
function main(argv = process.argv.slice(2)) {
  try {
    const { mode, root } = parseArgs(argv)
    const gateMeta = loadSourceWatermark(root)
    if (mode === '--record') return record(root, gateMeta)
    const data = validateReceiptAndShape(root)
    if (mode === '--write') {
      const changed = writeAll(root, data, gateMeta)
      console.log(changed.length ? `watermark: wrote ${changed.join(', ')}` : 'watermark: already current')
      return
    }
    checkAll(root, data, gateMeta)
    console.log('watermark: check passed')
  } catch (e) {
    console.error(`watermark: ${e.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
