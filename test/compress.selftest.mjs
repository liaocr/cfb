// compress.selftest.mjs —— 单一编译路径（birth + compress）的主线回归（v12.1）。
//   §1 提示词：v2 中性、v3 绝对目标、版本号唯一裁决、v3 为缺省
//   §2 传输：退避、4MiB 硬上限、终止闸（截断输出一律失败，含请求指纹）
//   §3 trace：promptVersion 贯通、inputAmplificationRatio 命名
//   §4 发明标识符闸：判据（fidelity.inventedIdentifiers）+ birthFinish 端到端 + 关闭开关 + analyze-efficiency 分布
//   §5 deploy/onboard：部署一致性与漂移检测
// 来源：v12.0 的 coverage-provenance / optimization 套件中与主线相关的用例（其余随 checkpoint / memory 删除）。
// 全部本机执行，零外网、零 API 调用。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as I from '../index.js'
import { inventedIdentifiers } from '../src/fidelity.js'
import { analyzeEfficiency } from '../tools/analyze-efficiency.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-compress-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)) } }

try {
  // ═══ §1 提示词 ═════════════════════════════════════════════════════════════
  await test('§1a compress-v2：中性（保留不确定性，无「不可重开」裁决）', () => {
    const p2 = I.buildCompressPrompt('COT')
    assert.ok(p2.includes('保留') && p2.includes('尚未确定') && !p2.includes('不可重开') && !p2.includes('自我怀疑'))
    assert.ok(p2.endsWith('COT'))
  })
  await test('§1b compress-v3：v2 的保真规则逐字共享 + 绝对长度目标 + 对冲条款', () => {
    const v2 = I.buildCompressPrompt('COT')
    const v3 = I.buildCompressPromptV3('COT', 250, 450)
    const head = (s) => s.slice(0, s.indexOf('7. '))
    assert.equal(head(v3), head(v2), '保真规则 1~6 必须逐字节共享（这是 v3 存在的全部理由）')
    assert.ok(v2.includes('20%~35%') && !v2.includes('绝对长度'))
    assert.ok(v3.includes('250~450 字符') && v3.includes('绝对长度') && !v3.includes('20%~35%'))
    assert.ok(v3.includes('宁可超出目标，不得删除'))
    assert.ok(v3.includes('尚未确定') && !v3.includes('不可重开') && !v3.includes('自我怀疑'))
    assert.ok(v3.endsWith('COT'))
  })
  await test('§1c 版本号唯一裁决：缺省 v3、只有显式 v2 走 v2、退役值一律 v3；携带目标以便分桶', () => {
    assert.equal(I.DEFAULTS.compressPrompt, 'v3')
    assert.equal(I.compressPromptVersion({}), 'compress-v3h:250-450')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v2' }), 'compress-v2')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v1' }), 'compress-v3h:250-450')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'x1' }), 'compress-v3h:250-450')
    assert.equal(I.compressPromptVersion({ compressPrompt: 'v3', compressTargetMin: 300, compressTargetMax: 600 }), 'compress-v3h:300-600')
    assert.equal(I.compressPromptVersion({ compressSystemPrompt: true }), 'compress-v3h:250-450:sys')
  })
  await test('§1d compressPromptFor 与版本号一致', () => {
    assert.equal(I.compressPromptFor({}, 'COT'), I.buildCompressPromptV3('COT', 250, 450))
    assert.equal(I.compressPromptFor({ compressPrompt: 'v2' }, 'COT'), I.buildCompressPrompt('COT'))
    assert.equal(I.compressPromptFor({ compressTargetMin: 300, compressTargetMax: 600 }, 'COT'), I.buildCompressPromptV3('COT', 300, 600))
  })
  await test('§1e compressTargets：缺省与非法值绝不抛错，且 min<max 恒成立', () => {
    assert.deepEqual(I.compressTargets({}), { min: 250, max: 450 })
    assert.deepEqual(I.compressTargets({ compressTargetMin: 0, compressTargetMax: -5 }), { min: 250, max: 450 })
    const inv = I.compressTargets({ compressTargetMin: 900, compressTargetMax: 100 })
    assert.ok(inv.min < inv.max)
  })

  // ═══ §2 传输 ═══════════════════════════════════════════════════════════════
  await test('§2a retryDelayMs：401/403/404/400 不重试；429/5xx/网络类带抖动退避', () => {
    for (const s of [400, 401, 403, 404, 422]) assert.equal(I.retryDelayMs(new Error('http ' + s + ' x'), 1), null, String(s))
    assert.equal(I.retryDelayMs(Object.assign(new Error('cancelled'), { cancelled: true }), 1), null)
    assert.equal(I.retryDelayMs(new Error('http 429'), 1, () => 0.5), 1200)
    assert.equal(I.retryDelayMs(new Error('http 503'), 2, () => 1), 3120)
    assert.equal(I.retryDelayMs(new Error('socket hang up'), 1, () => 0), 840)
  })
  await test('§2b requestOnce 4MiB 硬上限：超大 HTTP 响应拒绝，不无限缓冲', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = Buffer.alloc(256 * 1024, 0x61)
      let n = 0
      const pump = () => { while (n < 17) { n++; if (!res.write(chunk)) { res.once('drain', pump); return } } res.end() }
      pump()
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    try { await assert.rejects(I.requestOnce('http://127.0.0.1:' + srv.address().port + '/', { timeoutMs: 5000 }), /4MB/) }
    finally { await new Promise((r) => srv.close(r)) }
  })
  {
    // 终止闸：所有协议变体（JSON / SSE × 流式开关）遵守同一规则 —— 没有 stop 就是失败，且带请求指纹
    let response = 'json-length'
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => {
        if (response.startsWith('sse')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const finish = response === 'sse-length' ? 'length' : response === 'sse-stop' ? 'stop' : null
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial-or-complete' }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n')
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'partial-or-complete' }, finish_reason: response === 'json-stop' ? 'stop' : 'length' }] }))
        }
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const cred = path.join(home, 'credentials.yaml'); fs.writeFileSync(cred, 'TEST_KEY: local-only\n')
    const cfg = I.normalizeConfig({ model: 'local-test', baseUrl: 'http://127.0.0.1:' + server.address().port,
      credentialsPath: cred, credentialRef: 'TEST_KEY', maxAttempts: 1, timeoutMs: 1000, keepAlive: false, followHostProvider: false })
    try {
      for (const stream of [false, true]) {
        for (const mode of ['json-length', 'sse-length', 'sse-missing']) {
          await test(`§2c 终止闸 stream=${stream} ${mode} ⇒ 拒绝截断输出且带请求指纹`, async () => {
            response = mode
            await assert.rejects(I.generateDistillation('x', { ...cfg, distillStream: stream }), (e) => {
              assert.ok(e.meta.promptChars > 0); assert.notEqual(e.meta.finish, 'stop'); return true
            })
          })
        }
        for (const mode of ['json-stop', 'sse-stop']) {
          await test(`§2d 终止闸 stream=${stream} ${mode} ⇒ 完整输出接受`, async () => {
            response = mode
            assert.equal((await I.generateDistillation('x', { ...cfg, distillStream: stream })).text, 'partial-or-complete')
          })
        }
      }
    } finally { await new Promise((r) => server.close(r)) }
  }

  // ═══ §3 trace ═════════════════════════════════════════════════════════════
  await test('§3a promptVersion 贯通 settled 行；inputAmplificationRatio 命名准确、compressRatio 仅作兼容别名', () => {
    assert.equal(I.settledTraceData(0, 1, { ok: true, text: 'x', meta: { promptVersion: 'compress-v3h:250-450' } }).promptVersion, 'compress-v3h:250-450')
    const d = I.settledTraceData(0, 1, { ok: true, text: 'x', meta: { inputChars: 100, promptChars: 150, promptVersion: 'compress-v2' } })
    assert.equal(d.inputAmplificationRatio, 1.5); assert.equal(d.compressRatio, 1.5); assert.equal(d.promptVersion, 'compress-v2')
  })

  // ═══ §4 发明标识符闸 ═══════════════════════════════════════════════════════
  const RAW = [
    '服务启动报 EACCES。先看权限，试了 chmod 777 /srv/app/conf.yaml 仍然失败。',
    'strace 显示 open("/srv/app/conf.yaml") 失败，而 read_file 读的是 /etc/app/conf.yaml。',
    '检查 loadConfig 与 config_loader.py，发现 `APP_CONF` 环境变量指向旧路径。参见 https://example.com/docs/cfg 。',
    'A/B 两个方案都看过，v2/v3 行为一致。',
  ].join('\n').repeat(3)
  await test('§4a 判据：忠实摘要（含截尾、斜杠互换、A/B、v2/v3、中文与数字）⇒ 不报', () => {
    const faithful = '进程实际读 /srv/app/conf.yaml，read_file 读 /etc/app/conf.yaml（路径错配，非权限问题；chmod 777 无效）。' +
      '根因在 loadConfig / config_loader.py：`APP_CONF` 指向旧路径。A/B、v2/v3 无差异。文件 conf.yaml 需核对，共 3 处。'
    assert.deepEqual(inventedIdentifiers(RAW, faithful), [])
    assert.deepEqual(inventedIdentifiers(RAW, '路径 \\srv\\app\\conf.yaml 已确认'), [], '反斜杠 / 正斜杠互换视为同一路径')
    assert.deepEqual(inventedIdentifiers(RAW, '纯中文摘要，没有任何标识符。'), [])
  })
  await test('§4b 判据：编造的路径 / 函数名 / snake_case / 反引号代码 / URL / file.ext ⇒ 报出（最多 8 个样本）', () => {
    const cases = [
      ['/opt/fake/conf.yaml', '根因是 /opt/fake/conf.yaml 不存在'],
      ['parseSettings', '问题在 parseSettings 里'],
      ['settings_reader', '改 settings_reader 即可'],
      ['APP_HOME', '设置 `APP_HOME` 即可'],
      ['https://evil.example/x', '见 https://evil.example/x'],
      ['main.rs', '看 main.rs'],
    ]
    for (const [tok, out] of cases) assert.ok(inventedIdentifiers(RAW, out).includes(tok), tok + ' ⇒ ' + JSON.stringify(inventedIdentifiers(RAW, out)))
    const many = Array.from({ length: 20 }, (_, i) => 'fakeIdent' + i + 'X').join(' ')
    assert.equal(inventedIdentifiers(RAW, many).length, 8)
  })
  const LONG_RAW = RAW.repeat(4)
  const runFinish = async (summary, cfgOver = {}) => {
    const traces = []
    const deps = {
      cfg: { birthMinChars: 100, birthArchive: true, birthArchiveTimeoutMs: 3000, birthFinishWaitMs: 1500, birthMinSavedChars: 50, birthTokenGate: false, ...cfgOver },
      trace: (tag, data) => traces.push([tag, data]), sessionId: 's-gate',
      archive: async () => 'art://gate', distill: async () => ({ text: summary, meta: {} }),
    }
    const task = I.birthStart({ index: 0, text: LONG_RAW }, deps)
    await task.distillP
    const r = await I.birthFinish(task, deps)
    return { r, traces }
  }
  await test('§4c birthFinish：摘要含编造路径 ⇒ 原文放行（why=invented-identifier），trace 带样本', async () => {
    const { r, traces } = await runFinish('根因：进程读的是 /opt/fake/conf.yaml，改 parseSettings 即可。')
    assert.equal(r.why, 'invented-identifier'); assert.equal(r.text, LONG_RAW)
    const pt = traces.find(([t]) => t === 'birth-passthrough')
    assert.ok(pt && pt[1].why === 'invented-identifier' && pt[1].invented.includes('/opt/fake/conf.yaml') && pt[1].invented.includes('parseSettings'), JSON.stringify(pt))
  })
  await test('§4b2 v12.7：模板的工具接口词（edit_file / old_text）不算发明；观察（opts.extra = compressCtx）里的行不算发明', () => {
    assert.deepEqual(inventedIdentifiers(RAW, '`APP_CONF` 这一行的逐字原文已给出，可以直接当 edit_file 的 old_text，不用 read_file。'), [])
    assert.deepEqual(inventedIdentifiers(RAW, '落点 `hedgeAfterMs: 1600` 的逐字原文已给出'), ['hedgeAfterMs: 1600', 'hedgeAfterMs'], '没有观察时照旧报')
    assert.deepEqual(inventedIdentifiers(RAW, '落点 `hedgeAfterMs: 1600` 的逐字原文已给出', { extra: '[tool: read_file] test/hedge.selftest.mjs\nserver 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600' }), [])
  })
  await test('§4c2 birthFinish：compressCtx 里的行 + 可用句 ⇒ condensed（此前被 invented-identifier 误放行）', async () => {
    const ctx = '[tool: read_file] test/hedge.selftest.mjs\nserver 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600'
    const draft = '进程读 /srv/app/conf.yaml：路径错配。如果复现，那么改 `hedgeAfterMs: 1600`——这一行的逐字原文已给出，可以直接当 edit_file 的 old_text。'
    const { r } = await runFinish(draft, { compressCtx: ctx })
    assert.equal(r.why, 'condensed', JSON.stringify(r))
    const { r: r2 } = await runFinish(draft)
    assert.equal(r2.why, 'invented-identifier', '没有观察 ⇒ 仍当编造')
  })
  await test('§4d birthFinish：忠实摘要 ⇒ 照常 condensed', async () => {
    const { r } = await runFinish('进程读 /srv/app/conf.yaml 而 read_file 读 /etc/app/conf.yaml：路径错配，非权限。根因 `APP_CONF` 指向旧路径（loadConfig / config_loader.py）。')
    assert.equal(r.why, 'condensed')
  })
  await test('§4e birthIdentifierGate:false ⇒ 关闭（编造摘要照常替换；供 A/B 对照）', async () => {
    const { r } = await runFinish('根因：进程读的是 /opt/fake/conf.yaml。', { birthIdentifierGate: false })
    assert.equal(r.why, 'condensed')
    const c = I.normalizeConfig({ birth: { identifierGate: false } })
    assert.equal(c.birthIdentifierGate, false); assert.deepEqual(c.unknownOptions, [])
  })
  await test('§4f analyze-efficiency：outcomes 统计放行原因分布（含 invented-identifier 样本）', () => {
    const p = '[2026-09-28T00:00:00.000Z] '
    const trace = [
      p + '[BOOT] {"selfId":"g"}',
      p + '[birth-condensed] {"taskId":"a"}',
      p + '[birth-passthrough] {"why":"invented-identifier","invented":["/opt/x/y.z"]}',
      p + '[birth-passthrough] {"why":"distill-timeout"}',
      p + '[birth-distill-settled] {"taskId":"a","ok":true,"chars":300,"promptVersion":"compress-v3h:250-450"}',
    ].join('\n')
    const b = analyzeEfficiency(trace).boots[0]
    assert.equal(b.outcomes.condensed, 1)
    assert.deepEqual(b.outcomes.passthrough, { 'invented-identifier': 1, 'distill-timeout': 1 })
    assert.deepEqual(b.outcomes.inventedSamples, [['/opt/x/y.z']])
    assert.equal(b.outcomes.promptVersions['compress-v3h:250-450'].ok, 1)
    assert.equal('claimFunnel' in b, false)
  })

  // ═══ §5 deploy/onboard ═══════════════════════════════════════════════════
  await test('§5 onboard：部署与源树一致 ⇒ 0；安装副本漂移 ⇒ 4', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const profile = path.join(home, 'profiles', 'web')
    const installed = path.join(profile, 'node_modules', '@dsh-external', 'dsh-cot-form-b')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@dsh-external/dsh-cot-form-b'] } },
      dependencies: { '@dsh-external/dsh-cot-form-b': 'file:' + root },
    }))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: cot-form-b\n')
    fs.cpSync(root, installed, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') })
    const run = () => spawnSync(process.execPath, [path.join(root, 'deploy/onboard.mjs')], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    const clean = run(); assert.equal(clean.status, 0, clean.stdout + clean.stderr)
    assert.match(clean.stdout, /与源树一致/)
    fs.appendFileSync(path.join(installed, 'index.js'), '\n// drift')
    const drift = run(); assert.equal(drift.status, 4, drift.stdout + drift.stderr)
    assert.match(drift.stdout, /内容不同 1/)
  })
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`PASS=${pass} FAIL=${fail}`)
process.exitCode = fail ? 1 : 0
