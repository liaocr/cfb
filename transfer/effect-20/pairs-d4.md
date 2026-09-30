## eacces-config

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | reread-known | read_file {"path":"verify.mjs"} | 已定位 CFB_REAL_DSH_HOME 与 trace.js 优先级，但仍停在读 verify.mjs 继续取证，未给出修复测试或 verify.mjs e |
| raw | 1 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 正确识别 CFB_REAL_DSH_HOME 绕过隔离，直接改 verify.mjs 子进程 env 指向 tmp，未走 sudo/chmod/bashrc 等 |
| raw | 2 | 9 | edit | edit_file {"path":"verify.mjs","old_text":" // 每个套件在独立的临时 DSH_HOME 里跑\n const env = { ...p | 正确定位隔离失效根因（CFB_REAL_DSH_HOME 绕过临时 DSH_HOME），改 verify.mjs 子进程 env 把 CFB_REAL_DSH_ |
| raw | 3 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 准确锁定 CFB_REAL_DSH_HOME 绕过隔离的根因，并通过在 verify.mjs 子进程 env 中将其指向 tmp 一并修复，改对文件与位置，无死 |
| d4 | 0 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 直接编辑 verify.mjs，把子进程 env 中的 CFB_REAL_DSH_HOME 也指向 tmp，从根因上堵住绕过隔离的路径，正确且可执行；唯一小瑕疵 |
| d4 | 1 | 3 | reread-known | bash {"command":"grep -n \"DSH_HOME\\\|env\\\|spawn\\\|exec\" verify.mjs"} | 根因已明（CFB_REAL_DSH_HOME 绕过临时 DSH_HOME），却仍去 grep verify.mjs 继续取证，未给出修改测试/环境的 edit_ |

- **d4** Δ=-1.3（n=2 vs raw n=4）；压坏 1 例（变体 ≤4 而原文有 ≥7）；压好 1 例
  - d4 稿收尾：所以下一步工具调用是 bash 执行 `grep -R "CFB_REAL_DSH_HOME" -n verify.mjs test src` 并顺带 echo "CFB_REAL_DSH_HOME=${CFB_REAL_DSH_HOME:-unset}"。如果 grep 出来 verify.mjs 里确实没有 `CFB_REAL_DSH_HOME`、而该变量当前是 `/home/u/.dsh` 或 unset，那么假设坐实、看到这一点就直接动手 edit_file verify.mjs，old_text 是 `const env = { ...process.env, DSH_HOME: tmp }`（read_file 里原样的一整行，不带行首缩进也能匹配），new_text 是 `const env = { ...process.env, DSH_HOME: tmp, CFB_REAL_DSH_HOME: tmp }`，让测试拿到临时 home；改完立刻重跑，严禁再 read_file 或 sed 看 verify.mjs 上下文。如果 grep 出来 verify.mjs 里本来就有 CFB_REAL_DSH_HOME 却没生效，那么问题在 env 没传给子进程，改 verify.mjs 里把 env 传给 spawn/exec 的那一处调用，此时不要动测试文件、也不要动权限——落点 `const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 的逐字原文已给出，可以直接当 edit_file 
  - 压坏 #1：reread-known ← bash {"command":"grep -n \"DSH_HOME\\|env\\|spawn\\|exec\" verify.mjs"}；盲评：根因已明（CFB_REAL_DSH_HOME 绕过临时 DSH_HOME），却仍去 grep verify.mjs 继续取证，未给出修改测试/环境的 edit_file，方向偏但非死路。
  - 压好 #0：edit ← edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }","new_text":"const env = { ...p

## flaky-timeout

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 3 | reread-known | bash {"command":"grep -n -C 6 -e hedgeAfterMs -e hedgeStartedAt -e 1500 test/hedge.selftes | 复现已确认是 2 核时序竞态后仍继续 grep 取证而非直接改测试余量/假定时器，方向不算错但停在取证阶段，未使用 primarySettled 晚于定时器置位 |
| raw | 1 | 2 | reread-known | read_file {"path":"test/hedge.selftest.mjs"} | 复现已确认是 2 核下定时器余量仅 100ms 的竞态，回答却再次读同一份测试文件继续取证，属于参考中明确禁止的『继续复现/取证』死路，未给出任何修改动作。 |
| raw | 2 | 2 | edit | edit_file {"path":"src/distill.js","old_text":" const timer = setTimeout(() => { if (!prim | 改的是 distill.js 里加 setImmediate，并未修正竞态根因（.then 置位晚于定时器、100ms 余量不足），也未按参考修测试或改用响应头 |
| raw | 3 | 4 | edit | edit_file {"path":"src/distill.js","old_text":" const timer = setTimeout(() => { if (!prim | 复现已证实是 2 核时序竞态，但下一步改的是业务源码而非测试，且用 setImmediate 只是把竞态窗口后移、并未解决 primarySettled 在 . |
| d4 | 0 | 9 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 准确用上100ms余量、1698-1720定时器延迟、primarySettled微任务晚于定时器等关键事实，下一步把 hedgeAfterMs 从1600改为 |
| d4 | 1 | 9 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 直接改测试把 hedgeAfterMs 从 1600 拉到 3000 修复时序竞态，文件与位置正确，只是未同时调整主请求延迟或考虑假定时器方案，略欠完整。 |

- **d4** Δ=+6.3（n=2 vs raw n=4）；压好 2 例
  - d4 稿收尾：所以下一步工具调用是 bash 限制双核并循环复现： `taskset -c 0,1 bash -lc 'for i in $(seq 1 50); do echo "run $i"; node test/hedge.selftest.mjs || break; done'` 如果输出里出现 run N 后跟 got 1xxx 或 `expected hedgeStartedAt=null` 的 FAIL，那么就坐实了调度抖动，看到这一行就直接动手 edit_file test/hedge.selftest.mjs，old_text 是 `hedgeAfterMs: 1600`（文件里原样的一整行，不带行首缩进也能匹配），new_text 是 `hedgeAfterMs: 3000`，把余量从 100ms 拉到 1500ms，改完即停、严禁再用 read_file 或 sed 去确认那行上下文。如果循环 50 次全部 PASS（本地 16 核压不到 2 核的程度），那么说明瓶颈只出在 CI 的核数与负载，此时不要改 test/hedge.selftest.mjs 的 hedgeAfterMs，改去 CI 侧复现或直接给该测试加固定时钟注入。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
  - 压好 #0：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}
  - 压好 #1：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}

## wrong-model

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":"observe(options) { if (options && optio | 准确定位 observe 只取 options.model 而忽略第二参数 n，直接 edit_file 改读 n.model，未再查 prewarm/tran |
| raw | 1 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接改 host-follow.js 的 observe 读取 n.model，方向与位置正确且可执行；未走死路，未编造，仅未同时建议移除全局 lastMode |
| raw | 2 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接改 host-follow.js 的 observe 读取当前会话模型，方向与落点正确，唯参考更稳妥的改法是 callConfig 不依赖全局 lastMo |
| raw | 3 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接定位并修改 host-follow.js 的 observe 读取当前会话模型（n.model 优先），与参考答案一致且可执行；未陷 prewarm/tra |
| d4 | 0 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":"observe(options) { if (options && optio | 直接改 host-follow.js 的 observe，正确读取第二参数 n 的模型，与参考方案一致，未进死路；略欠的是未同时提防全局 lastModel 残 |
| d4 | 1 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":"observe(options) { if (options && optio | 直接改 host-follow.js 的 observe，让其读取第二参数 n.model 作为回退，与参考答案的修法一致且可执行；未走进任何死路，关键事实（模 |

- **d4** Δ=+0.0（n=2 vs raw n=4）

## sse-truncated

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | reread-known | bash {"command":"sed -n '150,240p' src/transport.js"} | 只做了一次 sed 取证、未定位根因也未给出正确修复（应改 transport.js 使 finish 不再将 [DONE] 回退为 stop），属于无效的再一 |
| raw | 1 | 2 | reread-known | bash {"command":"grep -nE \"rawFinish\|assembleSseFrames\" src/transport.js; sed -n '200,24 | 仍停留在 grep/sed 再取证一轮，未按参考直接改 transport.js 的 finish 回退，属于死路中的“再 grep 一轮”。 |
| raw | 2 | 2 | reread-known | read_file {"path":"src/transport.js"} | 只再读一遍 src/transport.js 属于‘再取证一轮’的死路，未直接改 finish 回退逻辑，方向未落地。 |
| raw | 3 | 3 | reread-known | bash {"command":"sed -n '200,245p' src/transport.js; echo '----- birth.js -----'; sed -n ' | 只再读一遍源码取证，未直接给出修复 finish 回退为 'stop' 的 edit_file，属于再 grep 一轮的死路。 |
| d4 | 0 | 9 | edit | edit_file {"path":"src/transport.js","old_text":" return { out, finish: finish \|\| (done ?  | 正确定位 assembleSseFrames 的 [DONE] 回退为 stop 是根因，并直接改 finish 只取真实值；方向与参考一致，但未同步修正 tr |
| d4 | 1 | 8 | edit | edit_file {"path":"src/transport.js","old_text":" return { out, finish: finish \|\| (done ?  | 改对了 assembleSseFrames 的核心回退逻辑且一条 edit_file 可执行，但未同步修正 transport 的 ok 判定与 trace 的 |

- **d4** Δ=+6.3（n=2 vs raw n=4）；压好 2 例
  - d4 稿收尾：所以下一步工具调用是 bash `grep -RIn --exclude-dir=node_modules -E "compiler-transport-settled|assembleSseFrames|birth-condensed" src`。 如果 grep 出来 `compiler-transport-settled` 附近有 ok: true 只依赖 !err 或 `stream` 结束，那么直接改这里：看到这一行就够了，不用再 read_file 确认上下文，edit_file 把 ok 的条件改成必须拿到真实 finish_reason 或内容完整标志，finish: null 且只有 `[DONE]` 时按 incomplete 处理，不写会话；old_text 用 grep 输出里该文件原样的那一整行，不带行号和 grep 前缀也能匹配，diff 里的 `+` 是标记不是文件内容，看到结果就必须直接动手，严禁再 sed 或 read_file 查看周边。如果 grep 出来 ok 已经依赖 finish，但 assembleSseFrames 的返回处被调用方覆盖成 `'stop'`，那么改 src/transport.js 里 ` return { out, finish: finish || (done ? 'stop' : null) }` 这一行，new_text 是 ` return { out, finish: finish || null }`，让仅 `[DONE]` 不再冒充 stop，此时不要改调用方——落点 `return { out, 
  - 压好 #0：edit ← edit_file {"path":"src/transport.js","old_text":" return { out, finish: finish || (done ? 'stop' : null) }","new_text":"
  - 压好 #1：edit ← edit_file {"path":"src/transport.js","old_text":" return { out, finish: finish || (done ? 'stop' : null) }","new_text":"

## perf-regression

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\" src/ \| head -50"} | 方向应为直接改回 compressTargetMax 450，此轮仅继续 grep 取证属死路，且未利用 finishReason/outputTokens 等 |
| raw | 1 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\\\|promptVersion\" src/ \| head  | 证据已充分指向 compressTargetMax 是主因（ttfb 不变、outputChars 贴合目标、finishReason 全 stop 证明 ma |
| raw | 2 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\" src/ --include=*.js"} | 仍在 grep 取证而未执行已知的 compressTargetMax 回滚，且未指出 maxOutputTokens 无害，属继续取证不动手的死路。 |
| raw | 3 | 9 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compre | 直接改回 compressTargetMax 450，方向与执行均正确；但未在判断中显式引用 ttfb 不变、outputTokens 260 远小于旧 cap |
| d4 | 0 | 10 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compre | 直接执行正确回滚 compressTargetMax 450→1800 的根因修复，保留 maxOutputTokens 4096，避开死路且无多余取证。 |
| d4 | 1 | 10 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compre | 直接把 compressTargetMax 从 1800 改回 450，其余配置与取证均未越界，一步到位。 |

- **d4** Δ=+6.3（n=2 vs raw n=4）；压好 2 例
  - d4 稿收尾：所以下一步工具调用是 bash analyze-trace --compare v11.9 v11.10 --steps birth --fields finishReason,outputTokens。如果升级前那侧出现 finishReason=length（或 outputTokens 卡在 850），那么 850 确实一直在截断、maxOutputTokens 是主因，此时不要动 compressTargetMax：edit_file src/config.js，old_text 是 `maxOutputTokens: 4096,`（read_file 里原样的一整行，不带行首缩进也能匹配），new_text 是 `maxOutputTokens: 850,`（diff 的 `-` 行是旧值，只能当 new_text 的材料），回到 850 一处即可，看到 finishReason=length 就直接改，不用再读 config.js 上下文；如果升级前那侧是 finishReason=stop（outputTokens 明显低于 850，说明上限从未生效），那么责任落在长度目标上，此时不要改 maxOutputTokens：edit_file src/config.js，old_text 是 `compressTargetMax: 1800,`（同样是文件里原样的一行，可直接当 old_text），new_text 是 `compressTargetMax: 450,`，把 v3 长度目标回滚到旧值、birth 输出随之回到 ~390 chars；标签 250-450
  - 压好 #0：edit ← edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compressTargetMax: 450,"}
  - 压好 #1：edit ← edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compressTargetMax: 450,"}

## perf-regression~refute

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 4 | probe | bash {"command":"analyze-trace --compare v11.9 v11.10 --steps birth --fields promptTokens, | 方向仍停留在继续取证（再跑 analyze-trace 分桶），而现有证据已足够判定应改回 maxOutputTokens，未直接动手修改。 |
| raw | 1 | 6 | probe | bash {"command":"grep -rn \"maxOutputTokens\" src/ \| head -50"} | 仅给出 grep 定位 maxOutputTokens 的位置，方向对（转向 cap 而非 compressTargetMax）但仍在取证未动手改回 850，属 |
| d4 | 0 | 9 | edit | edit_file {"path":"src/config.js","old_text":"maxOutputTokens: 4096,","new_text":"maxOutpu | 正确识别 maxOutputTokens 850→4096 解除截断为主因，直接将 4096 改回 850，未动 compressTargetMax，无死路；仅 |
| d4 | 1 | 10 | edit | edit_file {"path":"src/config.js","old_text":"maxOutputTokens: 4096,","new_text":"maxOutpu | 直接编辑 src/config.js 将 maxOutputTokens 从 4096 改回 850，命中参考答案的核心修复，未动 compressTarget |

- **d4** Δ=+4.5（n=2 vs raw n=2）；压好 2 例
  - 压好 #0：edit ← edit_file {"path":"src/config.js","old_text":"maxOutputTokens: 4096,","new_text":"maxOutputTokens: 850,"}
  - 压好 #1：edit ← edit_file {"path":"src/config.js","old_text":"maxOutputTokens: 4096,","new_text":"maxOutputTokens: 850,"}

## wrong-model~refute

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 5 | probe | bash {"command":"grep -rn \"makeBirthCompiler\" src/"} | 未直接改 plugin.js 第122行的 compilerCache 缓存键控，仅取证 grep makeBirthCompiler，方向对但未给出修复。 |
| raw | 1 | 7 | probe | bash {"command":"grep -R -n -C 10 \"makeBirthCompiler\" src"} | 定位到 makeBirthCompiler/compilerCache 方向正确、未入死路，但只 grep 取证未直接给出按 model 键控或重建缓存的修改， |
| d4 | 0 | 6 | probe | bash {"command":"grep -rn -C 8 \"makeBirthCompiler\\\|birthTransform\" src/"} | 正确推翻 observe 假设并锁定 122 行缓存，但下一步仅做 grep 取证而未给出修复动作，方向对但未到位。 |
| d4 | 1 | 6 | probe | bash {"command":"grep -n -C 20 \"makeBirthCompiler\" src/plugin.js"} | 已定位到 makeBirthCompiler 并取证，方向正确但尚未直接指出 compilerCache ??= 的缓存根因或给出改法，属于取证阶段。 |

- **d4** Δ=+0.0（n=2 vs raw n=2）

## flaky-timeout~refute

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 7 | probe | bash {"command":"taskset -c 0,1 bash -lc 'yes > /dev/null & p1=$!; yes > /dev/null & p2=$! | 用 taskset 限核并加负载复现，方向正确且未改余量或逻辑，但未体现 50/50 PASS 后换用 docker --cpus=2 或查 CI 失败时负载日 |
| raw | 1 | 1 | probe | bash {"command":"bash -lc 'grep -RIn --exclude-dir=node_modules -E \"hedge\\.selftest\|self | 上一轮已硬核证伪 2 核复现假设（50/50 PASS），却退回 grep 测试脚本配置这种无关取证，既未转换复现路径（docker --cpus=2/加负载） |
| d4 | 0 | 6 | probe | bash {"command":"taskset -c 0,1 bash -lc 'yes > /dev/null & p1=$!; yes > /dev/null & p2=$! | 方向正确，在2核本地环境中施加CPU负载以尝试复现，而非直接改代码；但工具调用并未真正使用taskset -c 0,1，且用yes占满CPU可能过于极端，不如d |
| d4 | 1 | 2 | probe | read_file {"path":"test/hedge.selftest.mjs"} [tool_call read_file] {"path":"src/distill.js | 50/50 未复现后应换更贴近 CI 的复现或看失败时的负载/耗时证据，而它仅重复读取已看过的两个文件，既无新信息也无取证推进。 |

- **d4** Δ=+0.0（n=2 vs raw n=2）；压坏 1 例（变体 ≤4 而原文有 ≥7）
  - 压坏 #1：probe ← read_file {"path":"test/hedge.selftest.mjs"} [tool_call read_file] {"path":"src/distill.js"}；盲评：50/50 未复现后应换更贴近 CI 的复现或看失败时的负载/耗时证据，而它仅重复读取已看过的两个文件，既无新信息也无取证推进。

## 动作类别分布

| 变体 | n | edit | reread-known | probe | none |
|---|---|---|---|---|---|
| raw | 26 | 38% | 27% | 35% | 0% |
| d4 | 16 | 69% | 6% | 25% | 0% |
