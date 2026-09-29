# v4 真机测试报告

模型：deepseek-v4.1-flash（主模型 thinking enabled；副模型同一模型关思考）· 生成时间：2026-09-29T14:27:37.059Z

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
| v4 | 6 | 5 | 3 | 0.6 | distill-timeout×2 condensed×3 below-floor×1 | 0.304 | 1651 | 10970 / 13505 |

## 逐块

| 任务 | 模式 | 结局 | 原文 | 产物 | 比例 | block-end→finish ms | finish 多扣 ms | 副模型 ms | 分段 | v4 拒绝 |
|---|---|---|---|---|---|---|---|---|---|---|
| eacces-config | v4 | distill-timeout | 10074 | 10074 | 1 | 676 | 13505 |  |  |  |
| flaky-timeout | v4 | distill-timeout | 9053 | 9053 | 1 | 1184 | 12012 |  |  |  |
| wrong-model | v4 | condensed | 3414 | 1885 | 0.552 | 929 | 10970 | 11897 |  |  |
| sse-truncated | v4 | condensed | 5424 | 1651 | 0.304 | 1356 | 4907 | 6261 |  |  |
| perf-regression | v4 | condensed | 11322 | 1312 | 0.116 | 2977 | 2310 | 5286 |  |  |
| session-mixup | v4 | below-floor | 1897 | 1897 | 1 | 2279 | 1 |  |  |  |

## 产物全文（替换成功的块）

### wrong-model · v4 · condensed（3414 → 1885）

```
我们需要解释压缩插件为什么用了上次会话的模型。trace 里当前会话的流是 `[llm-stream] {"n":12,"model":"deepseek-v3.2"}` 和 n13 也是 v3.2，中间却插了一条 `[compiler-transport-started] {"model":"deepseek-v3.1"}`，v3.1 就是上一次会话的模型，说明压缩 transport 启动时拿到的 cfg.model 被改过。read_file src/host-follow.js（逐字）：
`let lastModel = null`
`observe(options) { if (options && options.model) lastModel = options.model }`
`callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }`
以及 read_file src/plugin.js（逐字）：`host.observe(options, n)`、`const callCfg = host.callConfig(options)`。

看起来 lastModel 是模块级变量、跨会话不重置，observe 只认第一个参数上的 options.model，plugin 却把当前模型可能放在第二个参数 n 里，于是这次会话的 model 根本没写进 lastModel，callConfig 里 `lastModel || cfg.model` 就继续返回上一次会话留下的 v3.1，压缩 transport 用的正是这个 callCfg，这就是 compiler-transport-started 显示 v3.1 而 llm-stream 显示 v3.2 的原因。trace 里 n12、n13 都是 v3.2，与「当前会话模型是 v3.2」一致，不改变落点。

prewarm 那条线看过但排除：transport.js 里 `return (why) => { ... fetch(prewarmTargetUrl(cfg)) ... }` 用的还是传进来的 cfg，改它属于治症状、且要动 transport 一处没读的代码，不选；把 observe 签名改成读 n 属于动调用约定、要连 plugin 一起改，也不选。改法只落一个：改 src/host-follow.js 的 `observe(options) { if (options && options.model) lastModel = options.model }` 这一行，让它从第二个参数取 model，落点已经在手。

所以下一步工具调用是 bash grep -n -C 8 "host.observe\|callConfig" src/plugin.js。如果输出里 `host.observe(options, n)` 附近的 n 带 model 字段、而 options 没有 model，那么假设坐实，看到这一点就够了，不用再读 host-follow.js、也不用再展开 transport.js 的 prewarm：直接 edit_file src/host-follow.js，old_text 是 `observe(options) { if (options && options.model) lastModel = options.model }`（上一轮 read_file src/host-follow.js 的原样行，这次 grep 输出里没有它，照用；不带行首缩进也能匹配），new_text 是 `observe(options, n) { if (n && n.model) lastModel = n.model }`。如果输出里 n 不带 model、model 明明就在 options 上，那么假设不成立：是 lastModel 的更新时机问题、callConfig 先于 observe 取值，此时不要改 host-follow.js 的 observe；最具体的一条取证是 bash grep -n -B 4 -A 4 "birthTransform" src/plugin.js，分辨 callCfg 到底是在 observe 之前还是之后算出来的。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```

### sse-truncated · v4 · condensed（5424 → 1651）

```
我们要找的是截断被当成成功写进会话的原因。trace 里 compiler-transport-settled 是 {"ok":true,"finish":null,"stream":true,"outputChars":212,"eventCount":9}，birth-condensed 里 rawChars 8123 到 outChars 212，压到 212 字符而 finish 是 null 却 ok 为 true，网关文档说部分上游在连接被代理切断时只补发 data: [DONE]。read_file src/transport.js assembleSseFrames（逐字）：
`const j = JSON.parse(f); out += j.choices?.[0]?.delta?.content || ''`
`if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason`
`return { out, finish: finish || (done ? 'stop' : null) }`
看起来 finish 只在真实 finish_reason 到达时才被赋值，其余情况靠 done 推断 stop；trace 里 finish 仍是 null，说明 done 这条路径在这条 trace 上没走成，而 settle 的 ok 判定并不要求 finish 非空，于是 212 字符的截断结果照样 ok:true 落进会话，这就是截断被当成功的原因；212 与 8123、eventCount 9 之间的落差是量，不是判据，不改变落点。去查写会话的条件不选，settle 逻辑没读过，落点不在手；把 [DONE] 当 incomplete 是症状层面的补救，真正定义 ok/finish 约定的那处还没看过，也不选。改法只落一个：改 src/transport.js 的 `return { out, finish: finish || (done ? 'stop' : null) }` 这一行，让它不再把只有 [DONE]、没有 finish_reason 的结束算成 stop，落点已经在手。

所以下一步工具调用是 bash `grep -RIn --exclude-dir=node_modules -E "compiler-transport-settled|assembleSseFrames|birth-condensed" src`。如果输出里出现 compiler-transport-settled 那行的 ok 只由流结束决定、和 finish 无关，那么假设坐实，看到这一点就够了，不用再读调用链、也不用再核 eventCount：直接 edit_file src/transport.js，old_text 是 `return { out, finish: finish || (done ? 'stop' : null) }`（上一轮 read_file src/transport.js 的原样行，这次输出里没有它，照用；不带行首缩进也能匹配），new_text 是 `return { out, finish: finish || null }`。如果 grep 出来的是 [DONE] 根本没进 done、frames 里带的是 data: [DONE] 前缀，那么假设不成立：是 [DONE] 判定分支没命中，此时不要改 transport.js；先看 src/transport.js 里 `if (f === '[DONE]') { done = true; continue }` 这一处，确认 frames 里存的到底是 [DONE] 还是 data: [DONE]，去掉前缀再判。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```

### perf-regression · v4 · condensed（11322 → 1312）

```
等待涨了 1500ms，其中 contentSpanMs p50 从 280 涨到 1650（+1370ms），ttfbMs 只从 610 到 640，所以几乎全是解码时长，不是首字变慢。outputChars p50 从 390 到 1720，而升级前 compressTargetMax 是 450、升级后是 1800，390≈450、1720≈1800，量比 4.4 对 4.0 基本对上。git diff v11.9..v11.10 -- src/config.js 里在手的是（加号是 diff 标记，文件里没有）：`maxOutputTokens: 4096,`、`compressTargetMax: 1800,`。promptVersion 前后都是 compress-v3h:250-450，看着像是没跟着 config 走的旧标签，不能拿它当"改动没生效"的证据；README 只说 compressTargetMax 只影响 v3 的长度目标，而这条路径正是 compress-v3h，所以这个旋钮是接上的。看起来就是长度目标 450→1800 让收网产物按新目标长出来，输出字符数同步放大，解码时间线性跟着涨，这就是平均等待 900→2400 的原因；吞吐 1.39→1.04 chars/ms 只是同量级的轻微下降，不改变落点。maxOutputTokens 850→4096 只是个上限，上限抬高本身不逼模型写长，不选它当主因；回滚 compressTargetMax 再测一遍要重跑全量，太慢，也不选。改法只落一个：改 src/config.js 的 `compressTargetMax: 1800,` 这一行，让它回到 450，落点已经在手。

所以下一步工具调用是 bash analyze-trace --compare v11.9 v11.10 --steps birth --fields finishReason,outputTokens。如果输出里升级前的 birth 记录 finishReason 是 stop、outputTokens 明显低于 850，那么假设坐实，看到这一点就够了，不用再读 src/config.js、也不用再核 README 的开关表：直接 edit_file src/config.js，old_text 是 `compressTargetMax: 1800,`（上一轮 git diff 的加号行，去掉加号就是文件里的样子；拨测输出里没有它，照用；不带行首缩进也能匹配），new_text 是 `compressTargetMax: 450,`。如果输出里升级前 finishReason 是 length、outputTokens 贴着 850，那么假设不成立：是旧版一直在 850 上限被截断，抬高上限后生成跑到自然停止，此时不要改 compressTargetMax；能改的另一处在手，就是 `maxOutputTokens: 4096,` 这一行，改回 850 压回原来的截断点。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
```
