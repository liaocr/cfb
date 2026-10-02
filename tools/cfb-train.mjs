// tools/cfb-train.mjs —— 离线训练驱动：一条命令跑完一轮迭代，并把「接上 API 之后要做什么」
// 变成一份可执行的分阶段方案。
//
// 设计前提（用户 2026-10-02）：通道随时可切、可能没有思维链。所以：
//   · 阶段 0–3（语料 / 判据 / 候选 / 规划）**永远可跑，零 API**；
//   · 阶段 4（真实运行）只在通道检查通过时执行，且失败不污染前四阶段；
//   · 每个阶段都有**门禁**，不绿就停，不带着坏地基往下走。
//
// 用法：
//   node tools/cfb-train.mjs             跑离线全流程，出一份 plan.json + plan.md
//   node tools/cfb-train.mjs --check     只跑门禁，0/1 退出码（可进 CI / verify）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { writeJson, readJson, ensureDir, similarity } from './helpers/offline-core.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OFFLINE = path.join(ROOT, '.cfb-offline')
const node = process.execPath
const run = (script, args = []) => spawnSync(node, [path.join(ROOT, 'tools', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 600000 })

export function stages() {
  return [
    { id: '0-corpus', name: '语料编译', offline: true, cmd: ['cfb-corpus.mjs', []],
      desc: '把生产 trace + 历史实跑记录编译成候选/轨迹语料', gate: (r) => /候选行: [1-9]/.test(r.out) },
    { id: '1-criteria', name: '判据回归', offline: true, cmd: ['cfb-criteria.mjs', ['--regress']],
      desc: '黄金集上的 P/R/F1；判据不绿则后面全部无效', gate: (r) => r.code === 0 },
    { id: '2-judge', name: '判断层自检', offline: true, cmd: ['cfb-judge.mjs', ['capacity']],
      desc: '判断层维度表可加载；v14.2 起选择信号只用代码维（含任务真值维），评委维只做诊断', gate: (r) => /selectionSignal=code/.test(r.out) && /代码 9 \/ 评委 6/.test(r.out) },
    { id: '3-design', name: '候选生成', offline: true, cmd: ['cfb-lab.mjs', ['all']],
      desc: '确定性候选组 + 权重 + 下一步命令', gate: (r) => /已写入 \.cfb-offline\/lab\.md/.test(r.out) },
    { id: '4-quote', name: '出价', offline: true, cmd: ['cfb-lab.mjs', ['quote']],
      desc: '按价表算「验 top-k」的预留上限', gate: (r) => /预留 ≈ \$/.test(r.out) },
    { id: '5-cycle', name: '闭环编排', offline: true, cmd: ['cfb-cycle.mjs', ['doctor']],
      desc: '闭环 v2 预检：冻结任务 / 生产闸门 / 真值维方向 / 可测杠杆 / 退化臂 / 实验算术（live 运行时项在 Node 20 上只报不拦）', gate: (r) => r.code === 0 },
    { id: '6-live', name: '真实运行', offline: false, cmd: ['effect-ready.mjs', ['run', '--live', '--v9', '--round', 'N']],
      desc: '需要通道与钥匙；只有前五阶段全绿、且 `cfb-cycle plan` 已冻结第 N 轮计划并经人批准才允许进入',
      requires: ['通道检查通过（有思维链 + 历史 reasoning 进上下文）', '环境变量中已设置模型钥匙', '上一轮私有仓与公开收据成套'] },
  ]
}

/** 只跑离线阶段，收集证据；不触碰网络。 */
export function runOffline({ stopOnFail = false } = {}) {
  const out = { schema: 'cfb.offline-plan/1', at: new Date().toISOString(), stages: [], offlineOk: true }
  for (const s of stages()) {
    if (!s.offline) { out.stages.push({ id: s.id, name: s.name, offline: false, status: 'deferred', requires: s.requires, cmd: 'node tools/' + s.cmd[0] + ' ' + s.cmd[1].join(' ') }); continue }
    const r = run(s.cmd[0], s.cmd[1])
    const rec = { id: s.id, name: s.name, offline: true, desc: s.desc, code: r.status, ok: false,
      cmd: 'node tools/' + s.cmd[0] + ' ' + s.cmd[1].join(' '), out: (r.stdout || '').trim().split('\n').slice(0, 14).join('\n') }
    try { rec.ok = !!s.gate({ out: r.stdout || '', code: r.status }) } catch { rec.ok = false }
    if (!rec.ok) { out.offlineOk = false; rec.stderr = (r.stderr || '').trim().split('\n').slice(0, 6).join('\n') }
    out.stages.push(rec)
    if (!rec.ok && stopOnFail) break
  }
  return out
}

/** 排线：把「通道一好就要跑的东西」固定下来，避免临场再设计。 */
export function planNext({ topK = 4, samples = 2 } = {}) {
  return {
    preflight: ['node tools/channel-check.mjs --base-url <url> --model <model>', 'node tools/cfb-cycle.mjs plan --pricing <价表>   # 零 API；印出预占/实付/每 bit 价后停，等批准'],
    live: 'node tools/effect-ready.mjs run --live --v9 --round <N>   # 唯一花钱的命令；跑完 node tools/cfb-cycle.mjs ingest --round <N>',
    rule: '通道检查不通过（无思维链 / 历史 reasoning 不进上下文）就停；不要在会漂的池子上开 A/B；plan 没经人批准不开 live',
    topK, samples,
  }
}

function md(out, plan) {
  const L = ['# 离线训练方案（零 API）', '', '生成: ' + out.at, '',
    '门禁总览: ' + (out.offlineOk ? '**全绿** —— 通道一好即可进入阶段 4' : '**未全绿** —— 先修红项，不要进入阶段 4'), '',
    '| 阶段 | 性质 | 状态 | 命令 |', '| --- | --- | --- | --- |']
  for (const s of out.stages) L.push('| ' + s.id + ' ' + s.name + ' | ' + (s.offline ? '离线' : '需要通道') + ' | ' + (s.offline ? (s.ok ? '通过' : '**失败**') : '待通道') + ' | \`' + s.cmd + '\` |')
  L.push('', '## 阶段 4 的前置条件（人工确认）', '')
  for (const r of (out.stages.find((s) => !s.offline) || {}).requires || []) L.push('- ' + r)
  L.push('', '## 通道一好就执行', '', '\`\`\`', ...plan.preflight, plan.live, '\`\`\`', '',
    '规则: ' + plan.rule, '')
  L.push('## 各阶段实测输出（节选）', '')
  for (const s of out.stages) if (s.offline && s.out) L.push('### ' + s.id + ' ' + s.name, '', '\`\`\`', s.out, '\`\`\`', '')
  return L.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const out = runOffline({ stopOnFail: args.includes('--stop') })
  const plan = planNext()
  ensureDir(OFFLINE)
  writeJson(path.join(OFFLINE, 'plan.json'), { ...out, plan })
  fs.writeFileSync(path.join(OFFLINE, 'plan.md'), md(out, plan))
  if (args.includes('--check')) {
    for (const s of out.stages) if (s.offline) console.log((s.ok ? 'PASS ' : 'FAIL ') + s.id + ' ' + s.name)
    process.exitCode = out.offlineOk ? 0 : 1
    return
  }
  console.log(md(out, plan))
  process.exitCode = out.offlineOk ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
