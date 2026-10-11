#!/usr/bin/env node
/**
 * onboard.mjs —— 确认 DSH 外部插件在【这台机器】上装好了。
 *
 * ── 两种注册形态（本脚本都认）────────────────────────────────────────────────
 *
 * 【推荐】bundle 形态（2026-09-19 起为本仓库默认）
 *   插件是 npm 包，各自携带 cordis.patch.yml，通过 package.json 声明：
 *     "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
 *   官方契约：dsh-app-boot/lib/index.js:295-299
 *   注册点：profile 的 dsh.profile.bundles 里【列包名】。
 *   好处：**没有任何绝对路径** ⇒ 跨机器/跨盘符/跨 checkout 直接能装。
 *
 * 【遗留】路径形态（仍支持，但不再是推荐做法）
 *   profile 的 cordis.patch.yml 里写 name: 'file:///D:/dsh/packages/.../index.js'。
 *   绝对路径跨不了卷 ⇒ 换台机器就失效 ⇒ 需要本脚本 --apply 改写。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node deploy/onboard.mjs              # 体检（默认，不写任何文件）
 *   node deploy/onboard.mjs --apply      # 仅修【遗留路径形态】（先备份）
 *   node deploy/onboard.mjs --revert     # 从最近一次备份还原
 *   node deploy/onboard.mjs --profile tui
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECKOUT = path.resolve(HERE, '..')

/** id → { dir: 相对 checkout 的包目录, pkg: 包名, main: 入口 } */
const MONOREPO_PLUGINS = {
  'cmb-probe':             { dir: 'deploy/probe',                     pkg: '@dsh-external/dsh-probe',              main: 'index.mjs' },
  'context-memory-bundle': { dir: 'packages/dsh-context-memory-bundle', pkg: '@dsh-external/dsh-context-memory-bundle', main: 'index.js' },
  'boundary-plugin':       { dir: 'packages/dsh-boundary-plugin',     pkg: 'dsh-boundary-plugin',                  main: 'index.js' },
  'cot-form-b':            { dir: 'packages/dsh-cot-form-b',          pkg: '@dsh-external/dsh-cot-form-b',         main: 'index.js' },
  'degeneration-guard':    { dir: 'packages/dsh-degeneration-guard',  pkg: '@dsh-external/dsh-degeneration-guard', main: 'index.js' },
}

// This repository is distributed as a standalone plugin, not the whole DSH
// monorepo. Detect that layout before looking for non-existent sibling packages.
let standalone = false
try { standalone = JSON.parse(fs.readFileSync(path.join(CHECKOUT, 'package.json'), 'utf8')).name === '@dsh-external/dsh-cot-form-b' } catch {}
const PLUGINS = standalone
  ? { 'cot-form-b': { dir: '.', pkg: '@dsh-external/dsh-cot-form-b', main: 'index.js' } }
  : MONOREPO_PLUGINS

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const REVERT = argv.includes('--revert')
const pi = argv.indexOf('--profile')
const PROFILE = pi >= 0 && argv[pi + 1] ? argv[pi + 1] : 'web'

const dshHome = () => {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}
const toFileUrl = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\/+/, '')

const HOME = dshHome()
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE)
const PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml')
const MANIFEST = path.join(PROFILE_DIR, 'package.json')

const C = { ok: '\u2713', no: '\u2717', warn: '!' }
const line = (s) => process.stdout.write(s + '\n')

// ── --revert ────────────────────────────────────────────────────────────────
if (REVERT) {
  line('')
  line('DSH 插件挂载还原 —— onboard.mjs --revert')
  line('  patch : ' + PATCH)
  line('')
  if (!fs.existsSync(PATCH)) { line('  ' + C.no + ' patch 不存在，无法还原'); process.exit(2) }
  const dir = path.dirname(PATCH)
  const base = path.basename(PATCH) + '.bak-onboard-'
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort()
  if (!baks.length) { line('  ' + C.no + ' 找不到任何 ' + base + '* 备份'); process.exit(2) }
  const newest = baks[baks.length - 1]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(PATCH, PATCH + '.bak-onboard-' + stamp)
  fs.copyFileSync(path.join(dir, newest), PATCH)
  line('  ' + C.ok + ' 已还原 ← ' + newest)
  line('  ' + C.ok + ' 还原前的状态另存为 ' + path.basename(PATCH) + '.bak-onboard-' + stamp)
  line('')
  process.exit(process.exitCode || 0)
}

line('')
line('DSH 插件体检 —— onboard.mjs')
line('  checkout : ' + CHECKOUT)
line('  DSH_HOME : ' + HOME)
line('  profile  : ' + PROFILE + (APPLY ? '   [--apply：将写入]' : '   [体检模式：不写]'))
line('')

// ── [1] 包文件完整性 ────────────────────────────────────────────────────────
line('[1] 插件包（checkout 侧）')
const missingFiles = []
for (const [id, spec] of Object.entries(PLUGINS)) {
  const abs = path.join(CHECKOUT, spec.dir)
  const hasMain = fs.existsSync(path.join(abs, spec.main))
  const hasPatch = fs.existsSync(path.join(abs, 'cordis.patch.yml'))
  let declared = null
  try { declared = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')).dsh?.bundle?.patch } catch {}
  const ok = hasMain && hasPatch && declared === './cordis.patch.yml'
  if (!ok) missingFiles.push(id)
  line('  ' + (ok ? C.ok : C.no) + ' ' + id.padEnd(22) + (hasMain ? '' : ' 缺入口') + (hasPatch ? '' : ' 缺 cordis.patch.yml') + (declared === './cordis.patch.yml' ? '' : ' 未声明 dsh.bundle.patch'))
}

// ── [2] profile 侧 ──────────────────────────────────────────────────────────
line('')
line('[2] profile（' + PROFILE_DIR + '）')
if (!fs.existsSync(PATCH) || !fs.existsSync(MANIFEST)) {
  line('  ' + C.no + ' profile 不完整（缺 cordis.patch.yml 或 package.json）')
  process.exit(2)
}
let manifest = null
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch (e) {
  line('  ' + C.no + ' package.json 解析失败: ' + String(e.message)); process.exit(2)
}
const bundles = manifest.dsh?.profile?.bundles || []
const deps = manifest.dependencies || {}
line('  ' + C.ok + ' bundles 共 ' + bundles.length + ' 项；dependencies 共 ' + Object.keys(deps).length + ' 项')

// ── [2b] 部署漂移：profile/node_modules 的副本是否仍与 checkout 一致 ─────────
// 2026-09-20 事故（实测）：源码改了、pnpm install 却【不会】刷新这些包 —— 锁文件里
//   file: 依赖只记 {directory, type: directory}，没有内容哈希，pnpm 据此认定"已最新"。
//   结果 5 个包的已安装副本全部停在 09-18，而"源树全绿"被误当作"线上已修复"，
//   把整整两天的修复、连同两次"重启即验证"的假阳性一起掩盖了。
//   漂移必须能被【检测】到，否则它只能靠巧合暴露。
line('')
line('[2b] 部署漂移（源树 ↔ 已安装副本）')
// 开发件不进部署副本，因此**不参与**漂移比对 —— 否则每次加一个探针脚本，
// 检查器都会对插件误报"仅源码 N"，把真正的漂移淹掉（2026-09-21 实测）。
// 判据保守：只忽略两类无歧义的开发件。
//   _*.mjs / _*  —— deploy/probe 的探针命名约定
//   *.bak*       —— 备份文件
const isDevArtifact = (name) => name.startsWith('_') || /\.bak(?:[.-]|$)/.test(name)
const listFiles = (root) => {
  const out = []
  const walk = (d) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      if (isDevArtifact(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(root, p).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return out
}
const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const drifted = []
for (const [id, spec] of Object.entries(PLUGINS)) {
  const spec0 = deps[spec.pkg]
  if (typeof spec0 !== 'string' || !spec0.startsWith('file:')) continue
  const installed = path.join(PROFILE_DIR, 'node_modules', spec.pkg)
  if (!fs.existsSync(installed)) { line('  ' + C.no + ' ' + id.padEnd(22) + ' 未安装'); drifted.push(id); continue }
  const srcRoot = path.join(CHECKOUT, spec.dir)
  const a = listFiles(installed)
  const b = listFiles(srcRoot)
  const setB = new Set(b)
  const setA = new Set(a)
  let diffCount = 0, onlyDep = 0
  for (const f of a) {
    if (!setB.has(f)) { onlyDep++; continue }
    try { if (shaOf(path.join(installed, f)) !== shaOf(path.join(srcRoot, f))) diffCount++ } catch { diffCount++ }
  }
  const onlySrc = b.filter((f) => !setA.has(f)).length
  const ok = diffCount === 0 && onlyDep === 0 && onlySrc === 0
  if (!ok) drifted.push(id)
  line('  ' + (ok ? C.ok : C.no) + ' ' + id.padEnd(22) + (ok ? '与源树一致' : ('漂移：内容不同 ' + diffCount + '，仅部署 ' + onlyDep + '，仅源码 ' + onlySrc)))
}
if (drifted.length) {
  line('')
  line('  ' + C.warn + ' ' + drifted.length + ' 个包的已安装副本与源树不一致。')
  line('      pnpm install 不会刷新它们（见上）。必须删掉目录再装，例如：')
  line('        Remove-Item -Recurse -Force "' + path.join(PROFILE_DIR, 'node_modules', '<包名>'))
  line('        pnpm install --ignore-scripts')
  // 让漂移影响退出码：这样它可以进 CI / preflight，而不是只能靠人眼看输出。
  process.exitCode = 4
}

// ── [3] 逐插件判定：bundle 形态 还是 遗留路径形态 ────────────────────────────
line('')
line('[3] 注册状态')
const patchText = fs.readFileSync(PATCH, 'utf8')
const patchLines = patchText.split('\n')
const legacy = []   // 需要 --apply 修的
const results = []

for (const [id, spec] of Object.entries(PLUGINS)) {
  const inBundles = bundles.includes(spec.pkg)
  const nmDir = path.join(PROFILE_DIR, 'node_modules', ...spec.pkg.split('/'))
  const resolvable = fs.existsSync(nmDir)
  const hasPkgPatch = fs.existsSync(path.join(nmDir, 'cordis.patch.yml'))
  // 遗留形态：profile patch 里该 id 下有一行 name: 'file://...'
  let legacyLine = -1
  let curId = null
  for (let i = 0; i < patchLines.length; i++) {
    const t = patchLines[i].trim()
    const mId = /^-\s*id:\s*([A-Za-z0-9_\-]+)\s*$/.exec(t)
    if (mId) { curId = mId[1]; continue }
    if (curId === id && /^name:\s*'?file:\/\//.test(t)) { legacyLine = i + 1; break }
  }

  if (legacyLine > 0) {
    const url = (/name:\s*'?(file:\/\/[^'\s]+)'?/.exec(patchLines[legacyLine - 1].trim()) || [])[1]
    const actual = url ? url.replace(/^file:\/\/+/, '') : ''
    const expected = path.resolve(path.join(CHECKOUT, spec.dir, spec.main)).replace(/\\/g, '/')
    const same = actual.toLowerCase() === expected.toLowerCase()
    legacy.push({ id, lineNo: legacyLine, same, expected, actual })
    results.push({ id, form: 'legacy', ok: same, note: same ? '' : '指向别处：' + actual })
  } else if (inBundles && resolvable && hasPkgPatch) {
    results.push({ id, form: 'bundle', ok: true, note: spec.pkg })
  } else if (inBundles && !resolvable) {
    results.push({ id, form: 'bundle', ok: false, note: '已在 bundles 但未安装 ⇒ 跑 dsh plugin --profile ' + PROFILE + ' install' })
  } else {
    results.push({ id, form: 'none', ok: false, note: '既未按包名注册，也无遗留挂载点' })
  }
}
for (const r of results) {
  const tag = r.form === 'bundle' ? '[bundle]' : r.form === 'legacy' ? '[legacy]' : '[  --  ]'
  line('  ' + (r.ok ? C.ok : C.no) + ' ' + tag + ' ' + r.id.padEnd(22) + r.note)
}

// ── [4] 结论 ────────────────────────────────────────────────────────────────
line('')
line('[4] 结论')
const bad = results.filter((r) => !r.ok)
const needRewrite = legacy.filter((l) => !l.same)
line('  插件 ' + results.length + ' 个；bundle 形态 ' + results.filter(r=>r.form==='bundle').length +
     '；遗留路径形态 ' + legacy.length + '；不通 ' + bad.length)
if (!bad.length) {
  line('  ' + C.ok + ' 全部注册正确，无需改动。')
  if (legacy.length) line('  ' + C.warn + ' 提示：仍有 ' + legacy.length + ' 处遗留 file:// 路径，建议迁到 bundle 形态（见 docs/INSTALL.md）')
  line('')
  process.exit(process.exitCode || 0)
}
if (!needRewrite.length) {
  line('  ' + C.no + ' 有不通项，且不是路径问题，--apply 帮不上：')
  for (const r of bad) line('      ' + r.id + ' : ' + r.note)
  line('')
  process.exit(3)
}
if (!APPLY) {
  line('')
  line('  这是体检模式，未写入。要修正遗留路径请加 --apply：')
  line('    node deploy/onboard.mjs --apply')
  line('')
  process.exit(process.exitCode || 0)
}

// ── [5] --apply：只改 name: 行的路径，注释与其余字节不动 ─────────────────────
line('')
line('[5] 写入')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = PATCH + '.bak-onboard-' + stamp
fs.copyFileSync(PATCH, bak)
line('  ' + C.ok + ' 已备份 → ' + path.basename(bak))
let changed = 0
for (const l of needRewrite) {
  const i = l.lineNo - 1
  const indent = patchLines[i].match(/^\s*/)[0]
  const spec = PLUGINS[l.id]
  patchLines[i] = indent + "name: '" + toFileUrl(path.join(CHECKOUT, spec.dir, spec.main)) + "'"
  changed++
}
fs.writeFileSync(PATCH, patchLines.join('\n'), 'utf8')
line('  ' + C.ok + ' 已改写 ' + changed + ' 行 name:')
line('')
line('  完成。重跑一次体检复核：')
line('    node deploy/onboard.mjs')
line('')
