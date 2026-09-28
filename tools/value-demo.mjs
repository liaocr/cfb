// 演示 src/value.js 在 SPEC 算例（EACCES 调试块）上的完整流水线。不是评测，只是跑通理论。
import { compileBirth, updateLambda, recencyCompiledShare, neededLabels } from '../src/value.js'
import { estimateTokens } from '../src/tokens.js'

const toolText = `read_file#3: /etc/app/conf.yaml (template)\nstrace: open("/srv/app/conf.yaml") = -1 EACCES\nlog A 12:00:01.221 log B 12:00:01.221 log C 12:00:01.221`
const raw = [
  '服务启动报 EACCES。先看权限吧，也许是 /srv/app 目录权限不对。试试 chmod 777 /srv/app/conf.yaml。',
  '执行后仍然 EACCES。嗯，也许还是权限，要不试试 chown？或者是 SELinux？',
  '让我再检查一下 2+2=4 确认没算错。会不会是网络问题？不太像，没有任何网络调用。',
  '回头看 chmod 777 那步，还是想再试一次权限……不对，已经证明不是权限。',
  '换个思路：strace 显示 open("/srv/app/conf.yaml") 失败，而 read_file 读的是 /etc/app/conf.yaml，两个路径不一样！',
  '三处日志 log A、log B、log C 时间戳一致 12:00:01.221，所以不是竞态。',
  '现在的问题是 /srv/app/conf.yaml 是不是 symlink，下一步 ls -l /srv/app/conf.yaml。',
].join('\n').repeat(1)

const ops = [
  { id: 'o1', k: 'FACT', key: 'config.path', text: '进程实际读取 /srv/app/conf.yaml', ev: 'tool', src: 'tool:strace', kind2: 'pivot',
    anchor: '换个思路：strace 显示', supersedes: '/etc/app/conf.yaml' },
  { id: 'o2', k: 'COMPUTED', text: 'log A、log B、log C 时间戳一致，竞态已排除', ev: 'derived', src: 'self', kind2: 'compute',
    anchor: '三处日志', deps: ['o5'] },
  { id: 'o3', k: 'REFUTED', text: '改权限类方案', alt: '是路径错配', why: 'chmod 777 后仍 EACCES', ev: 'tool', src: 'tool:shell', kind2: 'hypothesize',
    anchor: '先看权限吧' },
  { id: 'o4', k: 'REFUTED', text: '网络问题', alt: '（无）', why: '没有网络调用', ev: 'derived', src: 'self', kind2: 'hypothesize',
    anchor: '会不会是网络问题' },
  { id: 'o5', k: 'FACT', text: '2+2=4', ev: 'derived', src: 'self', kind2: 'verify', anchor: '让我再检查一下' },
  { id: 'o6', k: 'OPEN', text: '/srv/app/conf.yaml 是不是 symlink', ev: 'guess', src: 'self', kind2: 'plan', anchor: '现在的问题是' },
  { id: 'o7', k: 'FACT', text: '捏造的 /opt/fake/path', ev: 'tool', src: 'tool:x', kind2: 'restate', anchor: '不存在的锚' },
]

const ctx = { raw, toolText, contextText: toolText, nextToolArgs: 'ls -l /srv/app/conf.yaml' }
const r = compileBirth(ops, ctx, { handle: 'art://h3' })

console.log('── 原文 token≈', estimateTokens(raw), ' 出生文本 token≈', estimateTokens(r.text || ''))
console.log('── 选中（按贪心顺序）')
for (const c of r.chosen) console.log(`  ${c.op.id} ${c.op.k.padEnd(9)} v=${c.v.toFixed(3)} gain=${c.gain.toFixed(3)} tok=${c.tok}`, JSON.stringify(Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, +v.toFixed(3)]))))
console.log('── 落选')
for (const c of r.rejected) console.log(`  ${c.op.id} ${c.op.k.padEnd(9)} v=${c.v.toFixed(3)}`)
console.log('── 校验丢弃'); for (const d of r.dropped) console.log('  ', d.op.id, d.why.join(','))
console.log('── 出生文本\n' + r.text)

console.log('\n── 控制器')
let st = { lambda: 0.004 }
const seq = [
  { loopRising: true, sw: 0.3, difficulty: 0.4 },
  { loopRising: true, sw: 0.35, difficulty: 0.4 },
  { readbackExcess: true, sw: 0.4, difficulty: 0.7 },
  { loopRising: true, sw: 0.8, difficulty: 0.7 },
]
for (const s of seq) { st = updateLambda(st, s); console.log('  ', JSON.stringify(s), '→', st.action, 'λ=' + st.lambda.toFixed(4), st.forceRawNear ? 'forceRawNear' : '') }
console.log('  s_w 示例:', recencyCompiledShare([{ tok: 5000, compiled: true }, { tok: 800, compiled: true }, { tok: 900, compiled: false }], 900).toFixed(2))
console.log('  自监督标签:', JSON.stringify(neededLabels(ops.slice(0, 6), ['ls -l /srv/app/conf.yaml -> lrwxrwxrwx'])))
