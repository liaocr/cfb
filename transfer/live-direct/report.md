# v4 真机测试报告

模型：deepseek-v4.1-flash（主模型 thinking enabled；副模型同一模型关思考）· 生成时间：2026-09-29T10:29:52.411Z

## 录音

| 任务 | 推理字符 | 正文字符 | 主模型总耗时 ms |
|---|---|---|---|
| eacces-config | 10074 | 345 | 22090 |
| flaky-timeout | 9053 | 478 | 24162 |
| wrong-model | 3414 | 472 | 8717 |
| sse-truncated | 5424 | 644 | 13513 |
| perf-regression | 11322 | 1446 | 18919 |
| session-mixup | 1897 | 1118 | 8739 |

## 汇总（按模式）

| 模式 | 块 | 够门槛 | 替换成功 | 命中率 | 结局分布 | 产物/原文 p50 | 产物字符 p50 | finish 多扣 ms p50 / max |
|---|---|---|---|---|---|---|---|---|
| v4 | 6 | 5 | 4 | 0.8 | condensed×4 distill-timeout×1 below-floor×1 | 0.29 | 1575 | 6009 / 7122 |

## 逐块

| 任务 | 模式 | 结局 | 原文 | 产物 | 比例 | block-end→finish ms | finish 多扣 ms | 副模型 ms | 分段 | v4 拒绝 |
|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | v4 | condensed | 10074 | 1493 | 0.148 | 678 | 7122 | 7793 |  |  |
| flaky-timeout | v4 | condensed | 9053 | 1652 | 0.182 | 1183 | 7065 | 8245 |  |  |
| wrong-model | v4 | condensed | 3414 | 1507 | 0.441 | 928 | 3000 | 3926 |  |  |
| sse-truncated | v4 | condensed | 5424 | 1575 | 0.29 | 1355 | 3002 | 4355 |  |  |
| perf-regression | v4 | distill-timeout | 11322 | 11322 | 1 | 2969 | 6009 |  |  |  |
| session-mixup | v4 | below-floor | 1897 | 1897 | 1 | 2280 | 0 |  |  |  |

## 产物全文（替换成功的块）

### eacces-config · v4 · condensed（10074 → 1493）

```
我们需要先确认测试为什么写到真实 DSH_HOME。错误是 `FAIL test/birth.selftest.mjs  Error: EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'`，而 `ls -la /home/u/.dsh/storages/cot-form-b/` 显示 `drwxr-xr-x 2 root root`、`-rw-r--r-- 1 root root 88213`，当前 `uid=1000(u) gid=1000(u)`，所以真实 home 下这个 trace.log 属 root，u 写不进去。verify.mjs 节选逐字是 `  const env = { ...process.env, DSH_HOME: tmp }`，本意是每个套件在独立临时 DSH_HOME 里跑；但 test/birth.selftest.mjs 第 1-12 行逐字是 `  const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`，它读的是 CFB_REAL_DSH_HOME 而不是 DSH_HOME。看起来隔离变量没对齐，测试绕过了临时 DSH_HOME，落回真实 `/home/u/.dsh`。所以下一步工具调用是 bash `grep -R "CFB_REAL_DSH_HOME" -n verify.mjs test src; echo "CFB_REAL_DSH_HOME=${CFB_REAL_DSH_HOME:-<unset>}"`。如果输出里 verify.mjs 完全没有 CFB_REAL_DSH_HOME、且环境里它是空或 `/home/u/.dsh`，那么看到这一点就够了，直接 edit_file verify.mjs，old_text 是 `  const env = { ...process.env, DSH_HOME: tmp }`（read_file 里原样的一整行，不带行首缩进也能匹配），new_text 是 `  const env = { ...process.env, DSH_HOME: tmp, CFB_REAL_DSH_HOME: tmp }`，让 birth.selftest 的 `makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 读到临时 home；看到结果就必须直接动手 edit_file，严禁再用 read_file 或 sed 查看上下文或确认。如果输出显示 verify.mjs 已经设置了 `CFB_REAL_DSH_HOME: tmp`，那么问题在别处，此时不要改 verify.mjs，改 test/birth.selftest.mjs 里那一行 `  const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`（同样是文件里原样的一整行，可直接当 old_text），new_text 是 `  const w = makeTraceWriter({ home: process.env.DSH_HOME })`，让它跟随临时 DSH_HOME；看到结果就必须直接 edit_file，不要回头读同一文件。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```

### flaky-timeout · v4 · condensed（9053 → 1652）

```
我们需要判断 CI 里 test/hedge.selftest.mjs 约每 5 次失败 1 次、本地从不失败的原因。失败输出逐字：`expected hedgeStartedAt=null, got 1712`，另一条 `got 1698`。测试 §4 逐字：`server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600`，`assert.equal(meta.hedgeStartedAt, null)`。源码 hedgedDistill 节选逐字：`const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)` 和 `primary.then(() => { primarySettled = true })`。nproc CI 是 2，本地 16。

看起来本地 16 核时，1500ms 的 server 定时器先执行，主请求响应在 poll 阶段 resolve，`primary.then` 微任务把 `primarySettled` 置 true，到 1600ms 对冲定时器触发时检查为 false 的条件不成立。CI 只有 2 核，事件循环在 1500-1600ms 窗口被阻塞，两个 setTimeout 积压到同一 timers 阶段：先执行 1500ms 的 server 回调发 200，再执行 1600ms 的对冲回调；此时主请求的 HTTP 响应还没在 poll 阶段被客户端处理，`primary.then` 微任务尚未设置 `primarySettled`，所以 `startHedge()` 被调用，got 1712/1698 正是定时器被延迟后的实际触发时间。已排除逻辑必然错误：本地从不失败说明代码路径本身能走通。用 fake timers 的改法没在原文工具结果里看到落点，不选；把 `primarySettled` 改成在 `primary.finally` 中设置也解决不了同一 timers 阶段先执行对冲回调的问题，搁置。落定改法：增大测试时间差，让主请求 1500ms 与 hedgeAfterMs 1600 的 100ms 余量变大，这是改动最小且落点在手的候选。

所以下一步工具调用是 bash `taskset -c 0,1 bash -lc 'for i in $(seq 1 50); do echo "run $i"; node test/hedge.selftest.mjs || break; done'`。如果输出里出现 `expected hedgeStartedAt=null, got` 且数字大于 1600，那么坐实 2 核调度抖动导致两个定时器积压；直接动手 edit_file test/hedge.selftest.mjs，old_text 是 `  server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 1600`（read_file 里原样的一整行，不带行首缩进也能匹配），new_text 是 `  server 延迟：主请求 1500ms 后回 200；hedgeAfterMs: 3000`，只改这一个值把余量从 100ms 拉到 1500ms；看到失败输出就必须直接 edit_file，严禁再 read_file 或 sed 查看上下文确认。如果 50 次全部 PASS、没有出现 `got` 大于 1600，那么本地 16 核无法复现，问题只在 CI 的 2 核环境，此时不要改 test/hedge.selftest.mjs；下一步应看 CI 配置里 test/hedge.selftest.mjs 是否与其它测试并行、是否限制 CPU，把该测试串行化或单独跑。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```

### wrong-model · v4 · condensed（3414 → 1507）

```
trace 里 `[llm-stream] {"n":12,"model":"deepseek-v3.2"}` 与 `[llm-stream] {"n":13,"model":"deepseek-v3.2"}` 之间夹着 `[compiler-transport-started] {"model":"deepseek-v3.1"}`，当前会话是 v3.2，压缩那条却用了 v3.1。看 src/host-follow.js（逐字）：
`let lastModel = null`
`observe(options) { if (options && options.model) lastModel = options.model }`
`callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }`
再看 src/plugin.js（逐字）：
`host.observe(options, n)`
`const callCfg = host.callConfig(options)`
`return birthTransform(inner, { cfg: callCfg, ... })`
看起来 lastModel 是模块级变量，跨会话保留；observe 的签名只读第一个参数的 model，而调用处传了 `(options, n)`，第二参数被忽略。所以如果当前模型挂在 n 上、options 里没有 model，lastModel 就不会更新，callConfig 继续用上一次会话的 v3.1 覆盖 cfg.model。prewarm 那条 grep 只说明 transport 里存在 `makePrewarmer(cfg, trace)`，跟这个覆盖没有直接关系，先搁置；把 observe 改成读 n.model 的改法虽然可能，但落点还没看过，不选；当前最小确认是看 plugin 里 options 与 n 的真实字段。所以下一步工具调用是 bash grep -n -C 10 "observe\|callConfig" src/plugin.js。
如果 grep 出来 n 带 model 字段、或 options 里根本没有 model，那么坐实 observe 没读到当前模型：看到这一行就够了，不用再读 plugin.js，直接 edit_file src/host-follow.js，old_text 是 `observe(options) { if (options && options.model) lastModel = options.model }`（read_file 里原样的一整行，不带行首缩进也能匹配，可以直接当 old_text），逻辑改法意图是让 observe 读到 n 上的 model、options.model 兜底，改完 callConfig 就能拿到当前会话模型；看到结果就必须直接动手 edit_file，严禁再用 read_file 或 sed 查看上下文或确认。如果 grep 出来 options 里确实有 model、observe 调用顺序也在 callConfig 之前，那么 lastModel 本应被更新，问题不在 observe 的入参，此时不要改 host-follow.js，去看 src/plugin.js 里 callConfig 之后 cfg 是否又被别处覆盖。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```

### sse-truncated · v4 · condensed（5424 → 1575）

```
我们需要的关键证据是 trace 里 `[compiler-transport-settled] {"ok":true,"finish":null,"stream":true,"outputChars":212,"eventCount":9}` 和 `[birth-condensed] {"rawChars":8123,"outChars":212}`，截断输出 212 字符却 ok:true。read_file src/transport.js assembleSseFrames 节选（逐字）：
`if (f === '[DONE]') { done = true; continue }`
`const j = JSON.parse(f); out += j.choices?.[0]?.delta?.content || ''`
`if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason`
`return { out, finish: finish || (done ? 'stop' : null) }`
网关文档说部分上游在连接被代理切断时只补发 `data: [DONE]`。看起来：没有真实 finish_reason 时，代码仅凭 `[DONE]` 就把 finish 兜成 `stop`；如果 frames 里拿到的是 `data: [DONE]` 而不是裸 `[DONE]`，done 甚至不会置位，但 settle 仍可能因流结束把 ok 判真。所以截断被当成功写会话。trace 的 finish:null 与 ok:true 并存，说明 settle 的 ok 判定没有要求 finish 非空，或者它记录的是原始 finish_reason 而非 assembleSseFrames 的兜底值。调大超时/重试的改法已排除：这是结束语义问题，不是网络重试能解决；只改 `[DONE]` 判断也不够，因为 ok:true 的源头还没看到。原文提过把仅 `[DONE]` 当 `incomplete`/`unknown`，但落点未定，先搁置；先找 settle 与写会话调用处。
所以下一步工具调用是 `[tool: bash] grep -RIn --exclude-dir=node_modules -E "compiler-transport-settled|assembleSseFrames|birth-condensed" src`。如果输出里出现 `compiler-transport-settled` 所在行，且同一段里 ok 由 `finish` 或 `done` 直接赋值、没有要求 finish_reason，那么看到这一行就够了，不用再读 transport.js：edit_file 该文件，old_text 是 grep 输出里那一整行去掉「文件名:行号:」后的文件原文（文件里原样的一行，不带行首缩进也能匹配），new_text 是让 ok 只在 `finish_reason` 存在时才为 true、仅 `[DONE]` 视为 incomplete 的那一行；看到结果就必须直接动手 edit_file，严禁再用 read_file 或 sed 查看上下文或确认。如果输出只找到 `assembleSseFrames` 定义、没有 settle 或写会话处，那么问题在调用方，此时不要改 transport.js 的 `[DONE]` 行；下一条命令查 `birth-condensed` 的写入点，看它是否把 `outChars` 当完整结果。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```
