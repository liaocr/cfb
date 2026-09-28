// v12.0 自测：① compress-x1 退役后的配置兼容（旧配置不抛、不静默）；② src/value.js（v4 参考实现，未接入 birth）的理论不变量。
import { normalizeConfig, compressPromptVersion } from '../index.js'
import { validateOps, compileBirth, updateLambda, recencyCompiledShare, neededLabels } from '../src/value.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (note !== undefined ? '  ' + note : '')) } }

// ── ① x1 退役 ──────────────────────────────────────────────────────────────
{
  const c = normalizeConfig({ compressPrompt: 'x1', extractiveTailChars: 400, extractiveGuideline: 'g' })
  ok('x1 ⇒ compressPrompt 回到 v2', c.compressPrompt === 'v2', c.compressPrompt)
  ok('x1 ⇒ configAdjusted 留痕', c.configAdjusted && c.configAdjusted.compressPrompt && c.configAdjusted.compressPrompt.from === 'x1')
  ok('extractive* 键进 retiredOptions', c.retiredOptions.includes('extractiveTailChars') && c.retiredOptions.includes('extractiveGuideline'))
  ok('extractive* 键从生效配置删除', !('extractiveTailChars' in c) && !('extractiveGuideline' in c))
  ok('extractive* 键不误报为 unknownOptions', !(c.unknownOptions || []).some((k) => k.startsWith('extractive')), JSON.stringify(c.unknownOptions))
  ok('promptVersion 为 compress-v2', compressPromptVersion(c) === 'compress-v2', compressPromptVersion(c))
  const d = normalizeConfig({})
  ok('缺省配置不含 extractive* 键', !Object.keys(d).some((k) => k.startsWith('extractive')))
}

// ── ② value.js 不变量 ────────────────────────────────────────────────────
const toolText = 'strace: open("/srv/app/conf.yaml") = -1 EACCES\nread_file#3: /etc/app/conf.yaml (template)'
const raw = [
  '服务启动报 EACCES。先看权限吧，也许是 /srv/app 目录权限不对。试试 chmod 777 /srv/app/conf.yaml。',
  '执行后仍然 EACCES。嗯，也许还是权限，要不试试 chown？',
  '让我再检查一下 2+2=4 确认没算错。会不会是网络问题？不太像。',
  '回头看 chmod 777 那步……不对，已经证明不是权限。',
  '换个思路：strace 显示 open("/srv/app/conf.yaml") 失败，而 read_file 读的是 /etc/app/conf.yaml！',
  '现在的问题是 /srv/app/conf.yaml 是不是 symlink。',
].join('\n')
const ctx = { raw, toolText, contextText: toolText, nextToolArgs: 'ls -l /srv/app/conf.yaml' }
const ops = [
  { id: 'o1', k: 'FACT', key: 'config.path', text: '进程实际读取 /srv/app/conf.yaml', ev: 'tool', src: 'tool:strace', kind2: 'pivot', anchor: '换个思路', supersedes: '/etc/app/conf.yaml' },
  { id: 'o3', k: 'REFUTED', text: '改权限类方案', alt: '是路径错配', why: 'chmod 777 后仍 EACCES', ev: 'tool', src: 'tool:shell', kind2: 'hypothesize', anchor: '先看权限吧' },
  { id: 'o4', k: 'REFUTED', text: '网络问题', alt: '（无）', why: '不太像', ev: 'derived', src: 'self', kind2: 'hypothesize', anchor: '会不会是网络问题' },
  { id: 'o5', k: 'FACT', text: '2+2=4', ev: 'derived', src: 'self', kind2: 'verify', anchor: '让我再检查一下' },
  { id: 'o6', k: 'OPEN', text: '/srv/app/conf.yaml 是不是 symlink', ev: 'guess', src: 'self', kind2: 'plan', anchor: '现在的问题是' },
]
{
  const v = validateOps([...ops,
    { id: 'bad1', k: 'FACT', text: '/opt/fake/path 存在', ev: 'tool', anchor: '换个思路' },
    { id: 'bad2', k: 'REFUTED', text: 'x', ev: 'tool', anchor: '先看权限吧' },
    { id: 'bad3', k: 'FACT', text: 'y', ev: 'tool', anchor: '原文里没有这句' }], ctx)
  const dropped = Object.fromEntries(v.dropped.map((d) => [d.op.id, d.why.join(',')]))
  ok('I2 无出处标识符被拦截', /I2/.test(dropped.bad1 || ''), dropped.bad1)
  ok('I3 无替代方案的 REFUTED 被拦截', /I3/.test(dropped.bad2 || ''), dropped.bad2)
  ok('I1 非逐字 anchor 被拦截', /I1/.test(dropped.bad3 || ''), dropped.bad3)
  ok('I4 非工具证据的否定降为 SHELVED', v.kept.find((o) => o.id === 'o4').k === 'SHELVED')
}
{
  const r = compileBirth(ops, ctx, { handle: 'art://h' })
  const ids = r.chosen.map((c) => c.op.id)
  ok('中和项：取代行入选', ids.includes('o1'))
  ok('工具证伪 + 配对：入选', ids.includes('o3'))
  ok('自检（可重导）落选', !ids.includes('o5'), ids.join(','))
  ok('浅尝且无触发条件的搁置落选', !ids.includes('o4'), ids.join(','))
  ok('OPEN 入选', ids.includes('o6'))
  ok('替代先行渲染', /- 是路径错配（已排除：改权限类方案/.test(r.text), r.text)
  ok('被否定对象只出现一次', (r.text.match(/改权限类方案/g) || []).length === 1)
  ok('OPEN 渲染为问句', /symlink？/.test(r.text))
  ok('工具来源内容不写成「我决定/我应该」（I5）', !/我决定|我应该/.test(r.text))
  const hi = compileBirth(ops, ctx, { lambda: 0.05 })
  ok('λ 升高 ⇒ 入选条目不增', hi.chosen.length <= r.chosen.length, hi.chosen.length + ' vs ' + r.chosen.length)
  ok('全部 op 非法 ⇒ 回退原文', compileBirth([{ id: 'z', k: 'FACT', text: 'q', ev: 'tool', anchor: 'nope' }], ctx).fallback === 'raw')
}
{
  let st = { lambda: 0.004 }
  st = updateLambda(st, { readbackExcess: true, sw: 0.3 })
  ok('丢失信号 ⇒ λ 乘性下降', Math.abs(st.lambda - 0.0024) < 1e-9, st.lambda)
  const a = updateLambda({ lambda: 0.004 }, { loopRising: true, sw: 0.3 })
  ok('噪声信号需连续 2 轮才升', a.lambda === 0.004 && a.noiseRun === 1)
  const b = updateLambda(a, { loopRising: true, sw: 0.3 })
  ok('连续 2 轮噪声 ⇒ λ 加性上升', b.lambda > 0.004, b.lambda)
  const c = updateLambda({ lambda: 0.004 }, { loopRising: true, sw: 0.8 })
  ok('打转 + s_w 高 ⇒ 判为饱和：降 λ 并强制 raw-near', c.lambda < 0.004 && c.forceRawNear === true)
  ok('s_w 近因加权：近处原文拉低占比', recencyCompiledShare([{ tok: 5000, compiled: true }, { tok: 900, compiled: false }], 900) < 0.5)
  const lab = neededLabels(ops, ['ls -l /srv/app/conf.yaml'])
  ok('自监督标签：后续复现 ⇒ needed=1', lab.find((x) => x.id === 'o6').needed === 1 && lab.find((x) => x.id === 'o5').needed === 0)
}

console.log('v12 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)
