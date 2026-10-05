#!/usr/bin/env node
// tools/silver-shape.mjs —— 手写稿的形状检查（零 API）：对着**原文事实**核，不依赖有没有旧稿
// 定位（用户 2026-10-05 纠正）：**金标只认真机 outcome，离线工具不评金标**。这套 L1–L7 是从金标改法里提炼的
//   测试工具，用途是（1）批量保银标达标（2）写稿阶段别把归因写成摘要。绿=够格进训练池，红=形状缺失。
//
// 为什么要有它：`cfb-gold-repair replay` 的差异账需要一个现役金标当参照，而 flaky-timeout / perf-regression
//   这类 0 金标的家族根本没有旧稿可比 ⇒ 新稿有没有到金标的样子，只能对着原文自己审。
//   闸链（hand-preflight）只保证「不改决定、不越界、能编译、长度省」，**不保证归因写全**。
//   老金标的质量差异全在这几层里，所以缺一样说明这稿还没到能拿去花主调用验的程度（省钱的预筛，不是评判）。
//
// 用法：node tools/silver-shape.mjs <draft.md> --id <goldId> [--plan t90] [--json]
//        node tools/silver-shape.mjs --plan t90 --all            # 把该计划下所有稿都审一遍
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { slotsOf, anchorsOf, hasFixIntentIn } from './helpers/hand-draft.mjs'
import { auditMode1Output } from './helpers/mode1-quality.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const f = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null }
const planName = f('plan') || 't90'
const HOME = path.isAbsolute(planName) ? planName : path.join(ROOT, '.cfb-runtime', 'traj', planName)
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const sents = (t) => norm(t).split(/(?<=[。；！？])/).map((x) => x.trim()).filter(Boolean)

const pendingOf = (id) => {
  for (const d of ['pending', path.join('pending', 'done')]) {
    const p = path.join(HOME, d, id + '.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  return null
}

const LEAD_RE = /^(?:已排除|排除了|排除过|这条排除|未解|还没定|没定|待解|待定|未定|决定|已定|验收(?:口径|标准)?|改法(?:只落一个|只落|如下)?)[：:]\s*/
const CAUSAL_RE = /(?:所以|因此|⇒|这就是|说明|原因在于?|正是因为|导致)/
const EXPLAIN_RE = /(?:因为|由于|——|：|⇒|所以|说明|不在|不再|不是|没被|仍|才|与.*无关|不成立|不足以|没覆盖|不是一回|另一回事|错在|取错|没证明|拿不到|没新东西|已记|同样的|都跑过|已跑过|已经跑过|只证明)/
const FORWARD_RE = /(?:下一轮|下一条|回显|到手|先(?:看|读|确认)|落地后|改完|再看|再说|补一条|先发)/
const BRANCH_RE = /(?:若|如果|假如|一旦)[^。；\n]{4,90}(?:就|则|先|此时|再说|别再|不要|下一条|下一轮|都不像|才)/
const LEDGER_CHARS = 550   // stored = 稿 + 程序台账。实测区间 459（perf）–554（sse_decoy），按高端估 ⇒ 宁可多报，真数以闸链为准

function auditOne(draftFile, id) {
  const pend = pendingOf(id) || die(`找不到 pending：${id}（--plan ${planName} 下有 pending/*.json 吗？）`)
  const raw = String(pend.raw || ''), ctx = String(pend.ctx || '')
  const ev = raw + '\n' + ctx
  const draft = fs.readFileSync(draftFile, 'utf8').trim()
  const D = slotsOf(draft), R = slotsOf(raw + '\n' + ctx)
  const hay = anchorsOf(ev)
  const grounded = (list) => list.filter((s) => { const a = [...anchorsOf(s)]; return !a.length || a.some((x) => hay.has(x)) })
  const dSent = sents(draft)

  // L1 因果链：有"观测→结论"的句子，且锚点落在原文里
  const causal = dSent.filter((s) => CAUSAL_RE.test(s) && grounded([s]).length)
  // L2 排除带理由：每条排除都要有解释，光有引导词判空洞
  // 理由可能写在同一段的后半句里，所以按「行」取块（我的稿一条排除一行），不拿 slotsOf 的切片判空洞
  const exclBlocks = draft.split('\n').filter((l) => /(?:已排除|排除了|排除过)[：:]/.test(l)).map((l) => norm(l).replace(/^[^。；：]*?(?:已排除|排除了|排除过)[：:]\s*/, ''))
  const excl = exclBlocks.length ? exclBlocks : D.excluded.map((x) => norm(x).replace(LEAD_RE, ''))
  const hollow = excl.filter((x) => x.length < 14 || !EXPLAIN_RE.test(x))
  // L3 落点一致性：原文下了决定 ⇒ 稿必须有落点句；原文没下 ⇒ 稿有就是替主模型下决定
  const intent = hasFixIntentIn(ev, R)
  const leadSent = dSent.filter((s) => /^(?:当前决定|改法|已定|决定)/.test(s) || /改法只落|只改一处|只动一处/.test(s))
  const triplesInDraft = D.triples.length
  // L4 对「还没到手的材料」的处置。两种合法写法**任选其一**：
  //  (a) 预注册分歧：某个读数到手后动作不同（条件句「若 A 就…」或对偶读数句「读出 A 就这样；读出 B 就那样」——
  //      flaky 那稿用的是后者，只认「若」会把真分支判没）
  //  (b) 显式交代：这一格没有会改变归因的待读读数，欠的只是把已定动作发出去——并点名那个动作
  // 为什么必须有 (b)：不是每格都有待读读数。硬逼每格都写「若 A 就…／若 B 就…」，等于拿某一份老金标的
  //   **形状**当尺子，逼写稿人造句子——我第一版 perf 稿就是这么缝出一句语义错的话（把验收读数当成证读数）。
  //   (b) 要求点名"欠的是什么动作"，否则光一句"没查"就能过关 ⇒ 那是偷懒，不是判断。
  // ⚠ 真机边界（2026-10-05，t91/t93/t94 三次实测，共 $0.301）：形态 a 的「分两种」不是普遍的加分项。
  //   perf-regression 那格我在稿里写全了 old→new 与「同一轮内发 edit_file」，仍 8–12 轮 edit=0；同格 raw 臂到第 11 轮才动手、第 12 轮又改回去。
  //   ⇒ 判据管不了「模型肯不肯停止取证去落地」，这一维只有真机能判。别用补句子冒充改进。
  const DUAL_RE = /(?:出现|是|仍|还|全是|都是|都没有|没|落在|不在)[^。]{2,44}(?:就|则|说明|该|得)[^。]{2,60}[；;][^。]{2,60}(?:就|则|说明|该|得)/
  const DISPOSAL_RE = /(?:没有|无)[^。；\n]{0,12}(?:待读|未到手|没到手)[^。；\n]{0,14}(?:读数|回显|取证)|(?:不影响|不改变|改不动)[^。；\n]{0,18}(?:改法|结论|归因|判断)|(?:只欠|欠的是把)[^。；\n]{2,34}(?:发|写出去|落)/
  // 按行测，不按句：sents() 会把「；」也当边界，对偶句会被切成两半 ⇒ 只按句测必然假阴性
  const dLines = draft.split(/\n+/).map((l) => norm(l)).filter(Boolean)
  const branches = dLines.filter((x) => (BRANCH_RE.test(x) || DUAL_RE.test(x)) && (FORWARD_RE.test(x) || /下一轮|回显|读数|拿到|到手|先读/.test(x)))
  const disposals = dLines.filter((x) => DISPOSAL_RE.test(x))
  // L5 未解与待办 —— 必须**收敛型**
  // 真机证据（2026-10-05 t93/t94，perf-regression）：每条轨迹只压挑中的那一轮 ⇒ 稿只介入一次。
  //   我在稿里写「未解：`birthFinishWaitMs` …就查有没有第二处设定」，等于给主模型**新增一项调查任务**：
  //   分叉后 hand 臂提到它的次数 8 vs raw 3、回滚词 8 vs 3，且 12 轮 edits=0。
  //   老金标那份 fixed@5 的未解是「确认同轮完成两处修改并跑 X，看到这两项输出即验收完成…收工」⇒ 钉死成一个动作。
  //   所以这里挡的不是「不许留未解」，而是「不许把未解写成下一个待办」。
  const CONVERGED_RE = /(?:即收工|即算好|即交付|看到[^。；\n]{0,40}(?:即|就算)(?:算|完成|收工)|确认[^。；\n]{0,30}(?:完成|写好|落地)|原样写进[^。；\n]{0,12}(?:结论|未解段))/   // 只认「完成判据」；「不再取证/不许回滚」是禁令，不算收敛（05b 就是这样蒙过判据、真机仍失败）
  const DIVERGENT_RE = /(?:就查|再查|待查|先查|再取证|继续查|再看[^。；\n]{0,16}(?:查|核|确认)|够不够没底|够不够仍未定|没底)/
  const openItems = D.open.map((x) => norm(x)).filter((x) => x.replace(LEAD_RE, '').length >= 8)
  const divergentOpen = openItems.filter((x) => DIVERGENT_RE.test(x.replace(LEAD_RE, '')) && !CONVERGED_RE.test(x))
  // 越界嫌疑：写了环境类断言词但没进免检定界符
  const sus = []
  for (const s of dSent) {
    if (!/(沙箱|白名单|环境|权限|必然|一定能)/.test(s)) continue
    const quoted = /「[^」]*(?:沙箱|白名单|环境|权限)[^」]*」/.test(s) || /`[^`\n]*(?:沙箱|白名单|环境)[^`\n]*`/.test(s)
    if (!quoted) sus.push(s.slice(0, 90))
  }
  const lint = auditMode1Output(draft, ev)
  const estStored = draft.length + LEDGER_CHARS
  // L8（提示项，不参与裁决）：raw 里主模型自己"起的头"（Let me / I should / maybe… 并点名某个对象），
  // 稿子里一个没提的，列出来。真机教训 t96：我那份 r8 稿连一个 "git" 都没写，而 r8 原话里已有
  //   「Let me check if there are git history」「Let me also check git log」⇒ 压缩把已起念的头删掉，
  //   下一轮它自己重新起一遍（r9「I can't use git show. But git log -p might work?」→ r10 真发 git show v11.9:src/config.js），
  //   于是越查越长、该发的 edit 一直没发。为什么不做成硬判据：分不清"新意图"与"已定案"
  //   （`git log --oneline` 在台账里、"翻历史找 v11.9 的 diff"是新的），硬判要么挡死所有稿要么漏判 ⇒ 交给人。
  const SEED_RE = /(?:let me|let's|i'll|i should|i can also|i might|maybe i|maybe we)[^.\n]{0,80}/gi
  const CMD_RE = /\b(git\s+\w+|analyze-trace|readlink|npm\s+\w+|find|grep|cat|sed|ls -la|env)\b/g
  const seeds = [...new Set(norm(raw).match(SEED_RE) || [])]
  const seedTargets = new Set()
  for (const sen of seeds) {
    for (const t of sen.match(/`([^`]{2,26})`/g) || []) seedTargets.add(t.replace(/`/g, ''))
    for (const t of sen.match(CMD_RE) || []) seedTargets.add(t.toLowerCase())
  }
  const droppedSeeds = [...seedTargets].filter((t) => !norm(draft).toLowerCase().includes(t.toLowerCase()))
  const layers = [
    ['L1 因果链（观测→结论，锚点落地）', causal.length > 0, `${causal.length} 句${causal.length ? '：「' + norm(causal[0]).slice(0, 46) + '」…' : '：稿里只有罗列，没有把证据连到结论'}`],
    ['L2 排除带理由', excl.length > 0 && hollow.length === 0, excl.length ? `${excl.length} 条排除，空洞/无理由 ${hollow.length} 条${hollow.length ? '：「' + hollow[0].slice(0, 40) + '」' : ''}` : '一条排除都没有 ⇒ 这不是归因，是摘要'],
    ['L3 落点与原文一致', intent ? (leadSent.length + triplesInDraft > 0) : (leadSent.length === 0 && triplesInDraft === 0), intent ? `原文有改法意图 ⇒ 稿需落点句（有 ${leadSent.length} 句、三元组 ${triplesInDraft} 条）` : `原文没下决定 ⇒ 稿里不许出现落点句（当前 ${leadSent.length + triplesInDraft} 处，须为 0）`],
    ['L4 未到手材料的处置', branches.length > 0 || disposals.length > 0, branches.length ? `形态 a：${branches.length} 条预注册分叉「${norm(branches[0]).slice(0, 44)}」…` : disposals.length ? `形态 b：交代没有待读读数并点名欠的动作「${norm(disposals[0]).slice(0, 52)}」…` : '既没预注册分叉（形态 a），也没交代"没有待读读数 + 欠哪个动作"（形态 b）⇒ 下一轮拿到稿不知道该等什么'],
    ['L5 未解是收敛型', openItems.length > 0 && divergentOpen.length === 0, openItems.length ? (divergentOpen.length ? `${divergentOpen.length} 条把未解写成了下一个待办：「${norm(divergentOpen[0]).slice(0, 54)}」… ⇒ 稿只介入一次，这等于派活` : `${openItems.length} 条，都是收敛型（钉死成一个动作或明写不影响本轮）`) : '没留未解 ⇒ 要么真没未解（少见），要么把悬念藏进了别处'],
    ['L6 越界嫌疑句', sus.length === 0 && lint.status === 'clean', sus.length ? `未用定界符框住的嫌疑句 ${sus.length} 条：「${sus[0]}」` : lint.status === 'clean' ? 'lint clean，且环境类说法都在引号内' : `lint: ${lint.issues.map((i) => i.category).join(',')}`],
    ['L8 起念的处置（提示）', droppedSeeds.length === 0, `raw 里 ${seeds.length} 句起念、点名 ${seedTargets.size} 个对象；稿里没提的 ${droppedSeeds.length} 个${droppedSeeds.length ? '：' + droppedSeeds.slice(0, 4).join(' / ') + ' ⇒ 被删掉的起念会在下一轮以新取证的形式还回来' : ''}`],
    ['L7 长度净省（估）', raw.length - estStored >= 50, `raw ${raw.length} → 稿 ${draft.length} ⇒ stored ≈ ${estStored}，净省 ${raw.length - estStored}（要 ≥ 50；台账按实测区间 459–554 的高端估，真数以闸链为准）`],
  ]
  // L7 是按估的台账长度算的提示项，不参与 verdict —— 权威门槛是闸链的 no-gain（真台账、真字符数）。
  // 让它拖住 verdict 会出现「形状检查说差一层、闸说全绿」的自相矛盾，工具反而添乱。
  const SOFT = new Set(['L7 长度净省（估）', 'L8 起念的处置（提示）'])
  const bad = layers.filter(([n, ok]) => !ok && !SOFT.has(n))
  return { id, draftFile: path.relative(ROOT, draftFile), rawChars: raw.length, draftChars: draft.length, layers, verdict: bad.length ? 'needs-work' : 'silver-ok', missing: bad.map(([n]) => n),
    hint: layers.filter(([n, ok]) => !ok && SOFT.has(n)).map(([n]) => n) }
}

function die(msg) { console.log('✗ ' + msg); process.exit(2) }

const jobs = []
if (argv.includes('--all')) {
  const dd = path.join(HOME, 'drafts')
  if (!fs.existsSync(dd)) die(`没有稿目录：${path.relative(ROOT, dd)}`)
  for (const file of fs.readdirSync(dd).filter((x) => x.endsWith('.md')).sort()) jobs.push([path.join(dd, file), file.replace(/\.md$/, '')])
} else {
  const draftFile = argv[0] && !argv[0].startsWith('--') ? path.resolve(ROOT, argv[0]) : null
  if (!draftFile || !fs.existsSync(draftFile)) die('用法：silver-shape <draft.md> --id <id> [--plan t90] | --all')
  jobs.push([draftFile, f('id') || path.basename(draftFile).replace(/\.md$/, '')])
}
const out = jobs.map(([file, id]) => { try { return auditOne(file, id) } catch (e) { return { id, error: e.message } } })
if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(out.some((r) => r.error || r.verdict === 'needs-work') ? 1 : 0) }
let bad = 0
for (const r of out) {
  if (r.error) { console.log(`${r.id}: ✗ ${r.error}`); bad++; continue }
  console.log(`\n${r.id}  [${r.draftChars} 字 / raw ${r.rawChars}]  ⇒ ${r.verdict === 'silver-ok' ? '✓ 形状齐（够格当银标，不等于金标）' : '✗ 还差 ' + r.missing.length + ' 层'}`)
  for (const [name, ok, detail] of r.layers) console.log(`  ${ok ? '✓' : (r.hint && r.hint.includes(name) ? '⚠' : '✗')} ${name.padEnd(28)} ${detail}`)
  if (r.verdict !== 'silver-ok') bad++
}
console.log(`\n${out.length - bad}/${out.length} 份形状齐。\n`
  + '  这只够格进**银标**训练池（喂副模型/微模型学写法）。金标的唯一评判标准是真机 outcome：\n'
  + '  进注册表必须跑 `node tools/cfb-cycle.mjs traj-run` 真机单元、按真机结果改稿重跑直到挣到，\n'
  + '  全绿不构成金标证据，红也不构成否决（它只看形状）。')
process.exit(bad ? 1 : 0)
