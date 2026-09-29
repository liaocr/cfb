## wrong-model

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
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
| oG | 0 | 2 | reread-known | bash {"command":"sed -n '180,245p' src/transport.js"} | 只再取证 sed 读文件，未按参考直接给出 edit_file 修改 transport.js，且属于「再 grep/取证一轮」死路，未有效利用 trace f |
| oG | 1 | 7 | edit | edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish \|\| (done ? ' | 改对了transport.js的核心位置（不再把[DONE]回退成stop），方向正确可直接执行，但ok/返回值的真实finish判定与trace ok字段一致 |
| oH | 0 | 3 | reread-known | bash {"command":"grep -n \"rawFinish\" src/transport.js; sed -n '200,245p' src/transport.j | 根因判断方向对，但下一步只是再 grep 一轮取证，未落到改 src/transport.js，且命中‘再 grep 一轮’死路。 |
| oH | 1 | 6 | edit | edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish \|\| (done ? ' | 方向正确，锚定了 assembleSseFrames 的 [DONE]→stop 回退这一根因点并直接改该行，但把哨兵值改成 'incomplete' 并不能阻 |

- **oG** Δ=+2.3（n=2 vs raw n=4）；压好 1 例
  - 压好 #1：edit ← edit_file {"path":"src/transport.js","old_text":"return { out, finish: finish || (done ? 'stop' : null) }","new_text":"r

- **oH** Δ=+2.3（n=2 vs raw n=4）

## perf-regression

| 变体 | 样本 | 综合 | 动作 | 首个调用 | 盲评 |
|---|---|---|---|---|---|
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
| oG | 6 | 50% | 50% | 0% | 0% |
| oH | 6 | 50% | 50% | 0% | 0% |
