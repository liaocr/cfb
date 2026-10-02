// tools/traj-fixtures.mjs —— 2c「假仓库全轨迹」的题目（理论 S10.6）：把题目的文件真的落成文件，read_file / edit_file 真改，
//   grep / sed / cat / ls / head / tail / wc 真跑；测试 / trace / CI 这类命令按**文件状态**查表给 canned 输出（fixed 谓词也在这里）。
//   每题：{ id, prompt（给 Agent 的裸任务，不预先喂工具结果）, files{path: content}, canned(cmd, repo) → string|null, fixed(repo) → bool, verifyRe（什么命令算验收）}
import fs from 'node:fs'
import path from 'node:path'
import { TRAJ_TASKS_V2 } from './traj-fixtures-v2.mjs'

const read = (repo, p) => { try { return fs.readFileSync(path.join(repo, p), 'utf8') } catch { return '' } }

// v1 三题（正则 fixed）；v4.3 起追加 traj-fixtures-v2 的两题（隐藏语义 oracle fixed）
const TRAJ_TASKS_V1 = [
  {
    id: 'eacces-config',
    prompt: '仓库里 `npm test` 在 test/birth.selftest.mjs 上报 EACCES: permission denied, open \'/home/u/.dsh/storages/cot-form-b/trace.log\'。本地是普通用户 u（uid 1000），没有 sudo。请找出原因并修好，修好后说明依据。',
    files: {
      'package.json': '{\n  "name": "dsh-cot-form-b",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node verify.mjs" }\n}\n',
      'verify.mjs': "import { spawnSync } from 'node:child_process'\nimport fs from 'node:fs'\nimport os from 'node:os'\nimport path from 'node:path'\n\nconst suites = fs.readdirSync('test').filter((f) => f.endsWith('.selftest.mjs')).map((f) => path.join('test', f))\nlet failed = 0\nfor (const file of suites) {\n  // 每个套件在独立的临时 DSH_HOME 里跑\n  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-'))\n  const env = { ...process.env, DSH_HOME: tmp }\n  const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8' })\n  if (r.status !== 0) { failed++; console.log(`  FAIL ${file}  ${String(r.stderr).split('\\n').find((l) => /Error/.test(l)) || ''}`) }\n  else console.log(`  PASS ${file}`)\n  fs.rmSync(tmp, { recursive: true, force: true })\n}\nconsole.log(`  合计: ${suites.length - failed} 通过 / ${failed} 失败`)\nprocess.exit(failed ? 1 : 0)\n",
      'test/birth.selftest.mjs': "import assert from 'node:assert/strict'\nimport { makeTraceWriter } from '../src/trace.js'\nconst w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })\nw.write('birth-fired', { n: 1 })\nassert.ok(w.path.endsWith('trace.log'))\nconsole.log('birth.selftest ok')\n",
      'test/hedge.selftest.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\nconsole.log('hedge.selftest ok')\n",
      'src/trace.js': "import fs from 'node:fs'\nimport path from 'node:path'\n\nexport function makeTraceWriter(opts = {}) {\n  const home = opts.home || process.env.DSH_HOME\n  const dir = path.join(home, 'storages', 'cot-form-b')\n  fs.mkdirSync(dir, { recursive: true })\n  const p = path.join(dir, 'trace.log')\n  return { path: p, write(tag, data) { fs.appendFileSync(p, `[${tag}] ${JSON.stringify(data)}\\n`) } }\n}\n",
      'README.md': '# dsh-cot-form-b\n\n`npm test` 跑 verify.mjs：每个 selftest 套件在独立的临时 DSH_HOME 下运行。\n',
    },
    verifyRe: /npm test|node verify\.mjs|node test\/birth\.selftest/,
    fixed(repo) {
      const v = read(repo, 'verify.mjs'), t = read(repo, 'test/birth.selftest.mjs')
      const envFixed = /const env = \{[^}]*DSH_HOME: tmp[^}]*CFB_REAL_DSH_HOME: tmp/.test(v) || /const env = \{[^}]*CFB_REAL_DSH_HOME: tmp[^}]*DSH_HOME: tmp/.test(v) || /delete env\.CFB_REAL_DSH_HOME|CFB_REAL_DSH_HOME: undefined/.test(v)
      const testFixed = !/CFB_REAL_DSH_HOME/.test(t)
      return envFixed || testFixed
    },
    canned(cmd, repo) {
      const c = cmd.trim()
      if (/^(npm test|node verify\.mjs)/.test(c)) {
        return this.fixed(repo)
          ? '\n> dsh-cot-form-b@0.1.0 test\n> node verify.mjs\n  PASS test/birth.selftest.mjs\n  PASS test/hedge.selftest.mjs\n  合计: 2 通过 / 0 失败'
          : "\n> dsh-cot-form-b@0.1.0 test\n> node verify.mjs\n  FAIL test/birth.selftest.mjs  Error: EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'\n  PASS test/hedge.selftest.mjs\n  合计: 1 通过 / 1 失败"
      }
      if (/^node test\/birth\.selftest\.mjs/.test(c)) return this.fixed(repo) && !/CFB_REAL_DSH_HOME/.test(read(repo, 'test/birth.selftest.mjs')) ? 'birth.selftest ok' : "node:internal/fs:... Error: EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'"
      if (/^echo \$DSH_HOME/.test(c)) return '/home/u/.dsh'
      if (/^echo \$CFB_REAL_DSH_HOME|^printenv CFB_REAL|^env \|/.test(c)) return 'CFB_REAL_DSH_HOME=/home/u/.dsh'
      if (/^id\b/.test(c)) return 'uid=1000(u) gid=1000(u) groups=1000(u)'
      if (/^ls -la? \/home\/u\/\.dsh/.test(c)) return 'drwxr-xr-x 2 root root 4096 Sep 20 10:11 .\n-rw-r--r-- 1 root root 88213 Sep 20 10:11 trace.log'
      if (/^(sudo|chown|chmod|rm) /.test(c)) return /^sudo/.test(c) ? 'sudo: a password is required' : 'Operation not permitted'
      if (/~\/\.bashrc|\.bashrc/.test(c)) return '14:export CFB_REAL_DSH_HOME=/home/u/.dsh   # 手动调试真实目录时用'
      return null
    },
  },
  {
    id: 'flaky-timeout',
    prompt: 'CI 里 test/hedge.selftest.mjs 大约每 5 次失败 1 次，本地从不失败。CI 机器 2 核，本地 16 核。最近 5 次 CI 日志在 ci/last5.log。请找出原因并修好，修好后说明依据。',
    files: {
      'ci/last5.log': 'run 1: PASS  17 passed  (hedge 3.1s)\nrun 2: FAIL  §4 对冲在主请求 200 之后不得再发  expected hedgeStartedAt=null, got 1712\nrun 3: PASS\nrun 4: PASS\nrun 5: FAIL  §4 同上 got 1698\n',
      'test/hedge.selftest.mjs': "import assert from 'node:assert/strict'\nimport { hedgedDistill } from '../src/distill.js'\nimport { fakeServer } from './helpers.mjs'\n\n// §4 对冲在主请求 200 之后不得再发\n{\n  // server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600\n  const server = fakeServer({ primaryDelayMs: 1500, status: 200 })\n  const meta = await hedgedDistill(server.url, { hedgeAfterMs: 1600 })\n  assert.equal(meta.hedgeStartedAt, null)\n  server.close()\n}\nconsole.log('hedge.selftest ok')\n",
      'test/helpers.mjs': "import http from 'node:http'\n\n/** 起一个本地 HTTP 服务：主请求延迟 primaryDelayMs 后回 status；返回 { url, close } */\nexport function fakeServer({ primaryDelayMs, status = 200 }) {\n  const server = http.createServer((req, res) => {\n    setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })) }, primaryDelayMs)\n  })\n  server.listen(0)\n  const port = server.address().port\n  return { url: `http://127.0.0.1:${port}/distill`, close: () => server.close() }\n}\n",
      'package.json': '{\n  "name": "dsh-cot-form-b",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node verify.mjs" }\n}\n',
      'src/distill.js': "export async function hedgedDistill(url, cfg) {\n  const t0 = Date.now()\n  const meta = { hedgeStartedAt: null }\n  let primarySettled = false\n  const startHedge = () => { meta.hedgeStartedAt = Date.now() - t0 }\n  const primary = fetch(url)\n  const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)\n  primary.then(() => { primarySettled = true })\n  await primary.catch(() => {})\n  clearTimeout(timer)\n  return meta\n}\n",
    },
    verifyRe: /node test\/hedge\.selftest|taskset|npm test/,
    fixed(repo) {
      const t = read(repo, 'test/hedge.selftest.mjs')
      const m = /hedgedDistill\([^)]*hedgeAfterMs:\s*(\d+)/.exec(t)   // 看代码行，不看上面的注释行
      const margin = m ? Number(m[1]) - (Number((/primaryDelayMs:\s*(\d+)/.exec(t) || [])[1]) || 1500) : 100
      return margin >= 800 || /fake ?timers|useFakeTimers|mock.*timers/i.test(t)
    },
    canned(cmd, repo) {
      const c = cmd.trim()
      if (/^nproc/.test(c)) return '16'
      if (/^node (-v|--version)/.test(c)) return 'v20.20.2'
      if (/^cat ci\/last5\.log/.test(c)) return null   // 真文件
      if (/hedge\.selftest\.mjs|npm test/.test(c)) {
        const limited = /taskset|--cpus|cpulimit|stress/.test(c)
        const loops = /seq 1 (\d+)/.exec(c); const list = /\bin ((?:\d+\s+)+\d+)\s*;?\s*do/.exec(c); const n = loops ? Number(loops[1]) : list ? list[1].trim().split(/\s+/).length : 1
        if (!limited || this.fixed(repo)) return n > 1 ? `run 1\n…\nrun ${n}\n（${n}/${n} PASS）` : 'hedge.selftest ok'
        const failAt = Math.min(7, n)
        return n > 1 ? `run 1\n…\nrun ${failAt}\n§4 对冲在主请求 200 之后不得再发  expected hedgeStartedAt=null, got ${1690 + failAt * 3}\nFAIL test/hedge.selftest.mjs` : 'hedge.selftest ok'
      }
      return null
    },
  },
  {
    id: 'perf-regression',
    prompt: '从 v11.9 升级到 v11.10 之后，birth 收网的平均等待从 900ms 涨到 2400ms。可用 `analyze-trace`（支持 --compare v11.9 v11.10 --steps birth --fields …，以及 --last N）。请找出原因并修好，修好后说明依据。',
    files: {
      'src/config.js': "export const DEFAULTS = {\n  mode: 'birth',\n  maxOutputTokens: 4096,\n  compressTargetMin: 250,\n  compressTargetMax: 1800,\n  birthFinishWaitMs: 1500,\n}\n",
      'README.md': '# 回滚开关\n\n| 键 | 作用 |\n|---|---|\n| `compressTargetMax` | 只影响 v3 的长度目标（提示词里的目标字数上限） |\n| `maxOutputTokens` | 副模型单次输出上限 |\n',
      'CHANGELOG.md': '## v11.10\n- maxOutputTokens 850 → 4096\n- compressTargetMax 450 → 1800\n',
    },
    verifyRe: /analyze-trace/,
    fixed(repo) { const m = /compressTargetMax:\s*(\d+)/.exec(read(repo, 'src/config.js')); return !!m && Number(m[1]) <= 600 },
    canned(cmd, repo) {
      const c = cmd.trim()
      if (/^analyze-trace (--help|-h)/.test(c)) return 'analyze-trace [--compare A B] [--last N] [--steps birth|llm] [--fields f1,f2,…]\n  fields: finishReason outputTokens outputChars contentSpanMs ttfbMs promptVersion finishWaitMs'
      if (/^git diff/.test(c)) return "diff --git a/src/config.js b/src/config.js\n@@ -2,4 +2,4 @@\n-  maxOutputTokens: 850,\n+  maxOutputTokens: 4096,\n-  compressTargetMax: 450,\n+  compressTargetMax: 1800,"
      if (/^git log/.test(c)) return 'v11.10 配置调整：放宽输出上限与长度目标\nv11.9 …'
      if (/^analyze-trace/.test(c)) {
        if (/--compare/.test(c)) return '            finishReason        outputTokens p50   contentSpanMs p50   ttfbMs p50   outputChars p50   promptVersion\nv11.9       stop 100%           260                280                 610          390               compress-v3h:250-450\nv11.10      stop 100%           1150               1650                640          1720              compress-v3h:250-450'
        const fixed = this.fixed(repo)
        return fixed ? 'contentSpanMs p50: 295\noutputChars p50: 402\nttfbMs p50: 615\npromptVersion: compress-v3h:250-450\nfinishWaitMs p50: 910' : 'contentSpanMs p50: 1650\noutputChars p50: 1720\nttfbMs p50: 640\npromptVersion: compress-v3h:250-450\nfinishWaitMs p50: 2400'
      }
      return null
    },
  },
]

export const TRAJ_TASKS = [...TRAJ_TASKS_V1, ...TRAJ_TASKS_V2]

export function materialize(task, dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [p, content] of Object.entries(task.files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), content) }
}
