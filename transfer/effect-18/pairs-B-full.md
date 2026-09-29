## eacces-config

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | reread-known | read_file {"path":"verify.mjs"} | 已定位 CFB_REAL_DSH_HOME 与 trace.js 优先级，但仍停在读 verify.mjs 继续取证，未给出修复测试或 verify.mjs e |
| raw | 1 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 正确识别 CFB_REAL_DSH_HOME 绕过隔离，直接改 verify.mjs 子进程 env 指向 tmp，未走 sudo/chmod/bashrc 等 |
| raw | 2 | 9 | edit | edit_file {"path":"verify.mjs","old_text":" // 每个套件在独立的临时 DSH_HOME 里跑\n const env = { ...p | 正确定位隔离失效根因（CFB_REAL_DSH_HOME 绕过临时 DSH_HOME），改 verify.mjs 子进程 env 把 CFB_REAL_DSH_ |
| raw | 3 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 准确锁定 CFB_REAL_DSH_HOME 绕过隔离的根因，并通过在 verify.mjs 子进程 env 中将其指向 tmp 一并修复，改对文件与位置，无死 |
| oG | 0 | 10 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 根因判断准确，直接在 verify.mjs 子进程 env 中把 CFB_REAL_DSH_HOME 也指向 tmp，堵住绕过路径，edit_file 可直接执 |
| oG | 1 | 3 | reread-known | bash {"command":"grep -n \"birth.selftest\\\|CFB_REAL\\\|DSH_HOME\\\|env\" verify.mjs"} | 根因已由参考事实充分暴露，此轮仍去 grep verify.mjs 取证（方向对但应直接改测试/子进程 env），属反复取证而非给出 edit_file 修复。 |
| oH | 0 | 9 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 精准定位隔离失效根因（CFB_REAL_DSH_HOME 绕过临时 DSH_HOME），一步 edit_file 在 verify.mjs 子进程 env 中把 |
| oH | 1 | 8 | edit | edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }", | 下一步直接改 verify.mjs 的子进程 env 让 CFB_REAL_DSH_HOME 也指向 tmp，方向正确且可执行，未走 sudo/chmod/删日 |

- **oG** Δ=-0.8（n=2 vs raw n=4）；压坏 1 例（变体 ≤4 而原文有 ≥7）；压好 1 例
  - 压坏 #1：reread-known ← bash {"command":"grep -n \"birth.selftest\\|CFB_REAL\\|DSH_HOME\\|env\" verify.mjs"}；盲评：根因已由参考事实充分暴露，此轮仍去 grep verify.mjs 取证（方向对但应直接改测试/子进程 env），属反复取证而非给出 edit_file 修复。
  - 压好 #0：edit ← edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }","new_text":"const env = { ...p

- **oH** Δ=+1.3（n=2 vs raw n=4）；压好 2 例
  - oH 稿收尾：所以下一步工具调用是 bash `grep -R "CFB_REAL_DSH_HOME" -n verify.mjs test src; echo "CFB_REAL_DSH_HOME=${CFB_REAL_DSH_HOME:-<unset>}"`。如果结果显示 verify.mjs 中完全没有该变量、且环境里 CFB_REAL_DSH_HOME 未设或指向 /home/u/.dsh，那么是测试继承父进程变量绕过隔离，最小改动是在 verify.mjs 那一行 env 里补上隔离——把 `const env = { ...process.env, DSH_HOME: tmp }` 改成同时带 `CFB_REAL_DSH_HOME: tmp`，这一行的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件、不再复现。如果 verify.mjs 里已经设置了 `CFB_REAL_DSH_HOME`，那么根因在赋值来源而不是遗漏，改测试用 DSH_HOME 这条先不动，需另找那一行的落点再定——落点 `const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件。
  - 压好 #0：edit ← edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }","new_text":"const env = { ...p
  - 压好 #1：edit ← edit_file {"path":"verify.mjs","old_text":"const env = { ...process.env, DSH_HOME: tmp }","new_text":"const env = { ...p

## flaky-timeout

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 3 | reread-known | bash {"command":"grep -n -C 6 -e hedgeAfterMs -e hedgeStartedAt -e 1500 test/hedge.selftes | 复现已确认是 2 核时序竞态后仍继续 grep 取证而非直接改测试余量/假定时器，方向不算错但停在取证阶段，未使用 primarySettled 晚于定时器置位 |
| raw | 1 | 2 | reread-known | read_file {"path":"test/hedge.selftest.mjs"} | 复现已确认是 2 核下定时器余量仅 100ms 的竞态，回答却再次读同一份测试文件继续取证，属于参考中明确禁止的『继续复现/取证』死路，未给出任何修改动作。 |
| raw | 2 | 2 | edit | edit_file {"path":"src/distill.js","old_text":" const timer = setTimeout(() => { if (!prim | 改的是 distill.js 里加 setImmediate，并未修正竞态根因（.then 置位晚于定时器、100ms 余量不足），也未按参考修测试或改用响应头 |
| raw | 3 | 4 | edit | edit_file {"path":"src/distill.js","old_text":" const timer = setTimeout(() => { if (!prim | 复现已证实是 2 核时序竞态，但下一步改的是业务源码而非测试，且用 setImmediate 只是把竞态窗口后移、并未解决 primarySettled 在 . |
| oG | 0 | 7 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 改测试把 hedgeAfterMs 从 1600 拉到 2500、与 1500ms 主请求拉开余量，方向正确且可直接执行，但仅调大定时器余量、未提假定时器或改用 |
| oG | 1 | 7 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 编辑确实把 hedgeAfterMs 从 1600 拉到 3000、改对了文件与位置且可直接执行，方向正确，但只单侧放宽定时器而未同步缩小主请求 1500ms  |
| oH | 0 | 8 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 直接改测试把 hedgeAfterMs 拉到 3000、与主请求 1500ms 拉开余量，方向正确且可执行，只是未同步调整主请求延迟或说明另一种修法，略欠完整。 |
| oH | 1 | 9 | edit | edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"he | 直接改测试中 hedgeAfterMs 到 3000，正确复现了 100ms 余量导致的时序竞态，但未说明为何选 3000 而非同时调整主请求延迟或改用假定时器 |

- **oG** Δ=+4.3（n=2 vs raw n=4）；压好 2 例
  - 压好 #0：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 2500"}
  - 压好 #1：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}

- **oH** Δ=+5.8（n=2 vs raw n=4）；压好 2 例
  - oH 稿收尾：所以下一步工具调用是 bash：`taskset -c 0,1 bash -lc 'for i in $(seq 1 50); do echo "run $i"; node test/hedge.selftest.mjs || break; done'`，用 2 核循环复现。如果失败，说明是调度抖动/时序边界，那么 edit_file test/hedge.selftest.mjs，把 `hedgeAfterMs: 1600` 改成 hedgeAfterMs: 3000——这一行的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件、不再复现。如果 50 次全 PASS，那么 2 核还不够贴合 CI 负载，改走 `docker run --cpus=2` 那条复现路径（原文提过、但当时不确定，现在作为唯一备选），不动 src/distill.js。
  - 压好 #0：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}
  - 压好 #1：edit ← edit_file {"path":"test/hedge.selftest.mjs","old_text":"hedgeAfterMs: 1600","new_text":"hedgeAfterMs: 3000"}

## wrong-model

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":"observe(options) { if (options && optio | 准确定位 observe 只取 options.model 而忽略第二参数 n，直接 edit_file 改读 n.model，未再查 prewarm/tran |
| raw | 1 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接改 host-follow.js 的 observe 读取 n.model，方向与位置正确且可执行；未走死路，未编造，仅未同时建议移除全局 lastMode |
| raw | 2 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接改 host-follow.js 的 observe 读取当前会话模型，方向与落点正确，唯参考更稳妥的改法是 callConfig 不依赖全局 lastMo |
| raw | 3 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接定位并修改 host-follow.js 的 observe 读取当前会话模型（n.model 优先），与参考答案一致且可执行；未陷 prewarm/tra |
| oG | 0 | 9 | edit | edit_file {"path":"src/host-follow.js","old_text":" observe(options) { if (options && opti | 直接改 host-follow.js 的 observe 接收第二参数 n 并以 n.model 优先,与参考答案方向一致且可执行,未走死路; |
| oG | 1 | 2 | reread-known | read_file {"path":"src/plugin.js"} | 已拿到决定性证据（options.model 恒为 undefined、observe 忽略第二参数 n），却仍去重读 plugin.js 取证，未按参考直接  |
| oH | 0 | 2 | reread-known | bash {"command":"grep -n -C 10 \"normalizeRequest\" src/plugin.js"} | 证据已足够定案（observe 只接一个参数、options.model 恒 undefined），却继续 grep 取证而非直接 edit_file 修 ho |
| oH | 1 | 2 | edit | edit_file {"path":"src/plugin.js","old_text":"host.observe(options, n)","new_text":"host.o | 改错了文件：observe 在 host-follow.js 且需读取 n?.model；改成 host.observe(n) 反而丢弃 options，无法修 |

- **oG** Δ=-3.5（n=2 vs raw n=4）；压坏 1 例（变体 ≤4 而原文有 ≥7）
  - 压坏 #1：reread-known ← read_file {"path":"src/plugin.js"}；盲评：已拿到决定性证据（options.model 恒为 undefined、observe 忽略第二参数 n），却仍去重读 plugin.js 取证，未按参考直接 edit_file 修复 host-follow.js，属于重复取证/拖延死路。

- **oH** Δ=-7.0（n=2 vs raw n=4）；压坏 2 例（变体 ≤4 而原文有 ≥7）
  - oH 稿收尾：所以下一步工具调用是 bash grep -n -C 8 "host.observe\|callConfig" src/plugin.js。如果实际当前模型在 n 中（例如 n 是 request 对象或包含 model），那么根因就是 observe 没读，改 src/plugin.js，把 `host.observe(options, n)` 改成把含 model 的那个对象传进去，看到新代码里 options/n 的字段后再定这一行的替换文本，不用再复现 trace——落点 `host.observe(options, n)` 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件。如果 options 里根本没有 model 字段，那么问题在调用方没透传，得改上游构造 options 的地方补上 model——落点 `callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }` 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件。
  - 压坏 #0：reread-known ← bash {"command":"grep -n -C 10 \"normalizeRequest\" src/plugin.js"}；盲评：证据已足够定案（observe 只接一个参数、options.model 恒 undefined），却继续 grep 取证而非直接 edit_file 修 host-follow.js，且探查方向仍在 plugin 链路上绕圈，未落到修复点。
  - 压坏 #1：edit ← edit_file {"path":"src/plugin.js","old_text":"host.observe(options, n)","new_text":"host.observe(n)"}；盲评：改错了文件：observe 在 host-follow.js 且需读取 n?.model；改成 host.observe(n) 反而丢弃 options，无法修复 lastModel 残留，方向偏离。

## sse-truncated

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | reread-known | bash {"command":"sed -n '150,240p' src/transport.js"} | 只做了一次 sed 取证、未定位根因也未给出正确修复（应改 transport.js 使 finish 不再将 [DONE] 回退为 stop），属于无效的再一 |
| raw | 1 | 2 | reread-known | bash {"command":"grep -nE \"rawFinish\|assembleSseFrames\" src/transport.js; sed -n '200,24 | 仍停留在 grep/sed 再取证一轮，未按参考直接改 transport.js 的 finish 回退，属于死路中的“再 grep 一轮”。 |
| raw | 2 | 2 | reread-known | read_file {"path":"src/transport.js"} | 只再读一遍 src/transport.js 属于‘再取证一轮’的死路，未直接改 finish 回退逻辑，方向未落地。 |
| raw | 3 | 3 | reread-known | bash {"command":"sed -n '200,245p' src/transport.js; echo '----- birth.js -----'; sed -n ' | 只再读一遍源码取证，未直接给出修复 finish 回退为 'stop' 的 edit_file，属于再 grep 一轮的死路。 |
| oG | 0 | 2 | reread-known | bash {"command":"sed -n '180,245p' src/transport.js"} | 只再取证 sed 读文件，未按参考直接给出 edit_file 修改 transport.js，且属于「再 grep/取证一轮」死路，未有效利用 trace f |
| oG | 1 | 7 | edit | edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish \|\| (done ? ' | 改对了transport.js的核心位置（不再把[DONE]回退成stop），方向正确可直接执行，但ok/返回值的真实finish判定与trace ok字段一致 |
| oH | 0 | 3 | reread-known | bash {"command":"grep -n \"rawFinish\" src/transport.js; sed -n '200,245p' src/transport.j | 根因判断方向对，但下一步只是再 grep 一轮取证，未落到改 src/transport.js，且命中‘再 grep 一轮’死路。 |
| oH | 1 | 6 | edit | edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish \|\| (done ? ' | 方向正确，锚定了 assembleSseFrames 的 [DONE]→stop 回退这一根因点并直接改该行，但把哨兵值改成 'incomplete' 并不能阻 |

- **oG** Δ=+2.3（n=2 vs raw n=4）；压好 1 例
  - 压好 #1：edit ← edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish || (done ? 'stop' : null) }","new_text":"r

- **oH** Δ=+2.3（n=2 vs raw n=4）
  - oH 稿收尾：所以下一步工具调用是 bash： `grep -RIn --exclude-dir=node_modules -E "compiler-transport-settled|assembleSseFrames|birth-condensed" src` 如果搜出 settle 处 ok 只由流结束、不看 finish，那么 edit_file src/transport.js，把 `return { out, finish: finish || (done ? 'stop' : null) }` 这行改成仅在有 finish_reason 时才算 stop、`[DONE]` 兜底一律标 incomplete——这一行的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件、不再复现。如果搜出 ok 的赋值另有一处、与 assembled finish 无关，那就先落定那一处，把它的成功条件补上 finish 校验再谈本文件——落点 `return { out, finish: finish || (done ? 'stop' : null) }` 的逐字原文已给出，可以直接当 edit_file 的 old_text，看到结果后不用再读文件。

## perf-regression

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
| raw | 0 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\" src/ \| head -50"} | 方向应为直接改回 compressTargetMax 450，此轮仅继续 grep 取证属死路，且未利用 finishReason/outputTokens 等 |
| raw | 1 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\\\|promptVersion\" src/ \| head  | 证据已充分指向 compressTargetMax 是主因（ttfb 不变、outputChars 贴合目标、finishReason 全 stop 证明 ma |
| raw | 2 | 2 | probe | bash {"command":"grep -rn \"compressTargetMax\\\|compress-v3\" src/ --include=*.js"} | 仍在 grep 取证而未执行已知的 compressTargetMax 回滚，且未指出 maxOutputTokens 无害，属继续取证不动手的死路。 |
| raw | 3 | 9 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compre | 直接改回 compressTargetMax 450，方向与执行均正确；但未在判断中显式引用 ttfb 不变、outputTokens 260 远小于旧 cap |
| oG | 0 | 0 | reread-known | read_file {"path":"src/config.js"} | 该轮只是再读一遍 src/config.js 继续取证，未执行参考要求的 edit_file 回滚 compressTargetMax，且未反驳 maxOutp |
| oG | 1 | 10 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800","new_text":"compres | 直接编辑 src/config.js 将 compressTargetMax 改回 450，方向与位置均正确；仅未显式陈述 ttfb 不变、outputChar |
| oH | 0 | 2 | reread-known | bash {"command":"grep -n \"compressTargetMax\\\|maxOutputTokens\" src/config.js"} | 已能定位到 compressTargetMax 是主因方向，但本轮仍只做 grep 取证未动手修改配置，属于「继续取证不动手」，可执行性不足。 |
| oH | 1 | 9 | edit | edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compre | 直接编辑 src/config.js 把 compressTargetMax 从 1800 改回 450，方向正确且可执行；未回滚 maxOutputToken |

- **oG** Δ=+1.3（n=2 vs raw n=4）；压坏 1 例（变体 ≤4 而原文有 ≥7）；压好 1 例
  - 压坏 #0：reread-known ← read_file {"path":"src/config.js"}；盲评：该轮只是再读一遍 src/config.js 继续取证，未执行参考要求的 edit_file 回滚 compressTargetMax，且未反驳 maxOutputTokens 这一死路，属于「继续取证不动手」死路。
  - 压好 #1：edit ← edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800","new_text":"compressTargetMax: 450"}

- **oH** Δ=+1.8（n=2 vs raw n=4）；压坏 1 例（变体 ≤4 而原文有 ≥7）；压好 1 例
  - oH 稿收尾：所以下一步工具调用是 bash analyze-trace --compare v11.9 v11.10 --steps birth --fields finishReason,outputTokens,contentSpanMs。如果升级前 p50 的 finishReason 是 length / 输出 tokens 贴着 850，那么主因是 maxOutputTokens 解除截断，改法落在 src/config.js 把 `+ maxOutputTokens: 4096,` 降回一档（同一文件的 `- maxOutputTokens: 850,` 是旧值逐字原文，可直接当 edit_file 的 old_text，看到结果后不用再读文件、不再复现）；如果升级前是 stop、tokens 明显低于 850，那么上限从来没绑住，主因是压缩目标变长，改法落在 src/config.js 把 `+ compressTargetMax: 1800,` 改回 450（同样是逐字原文，可直接当 edit_file 的 old_text，不再复现），maxOutputTokens 保留不动。
  - 压坏 #0：reread-known ← bash {"command":"grep -n \"compressTargetMax\\|maxOutputTokens\" src/config.js"}；盲评：已能定位到 compressTargetMax 是主因方向，但本轮仍只做 grep 取证未动手修改配置，属于「继续取证不动手」，可执行性不足。
  - 压好 #1：edit ← edit_file {"path":"src/config.js","old_text":"compressTargetMax: 1800,","new_text":"compressTargetMax: 450,"}

## 动作类别分布

| 变体 | n | edit | reread-known | probe | none |
|---|---|---|---|---|---|
| raw | 20 | 50% | 35% | 15% | 0% |
| oG | 10 | 60% | 40% | 0% | 0% |
| oH | 10 | 70% | 30% | 0% | 0% |
