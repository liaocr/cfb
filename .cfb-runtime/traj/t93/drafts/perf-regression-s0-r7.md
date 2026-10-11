已观察：v11.9 → v11.10 的读数是 outputTokens 260→1150、outputChars 390→1720、contentSpanMs 280→1650、finishWaitMs 900→2400，同时 promptVersion 从 `compress-v3h:250-450` 变成 `compress-v3h:250-1800`；`cat src/config.js` 见 `compressTargetMax: 1800,`。

归因：`compressTargetMax` 抬到 1800 ⇒ 提示词里的长度目标把输出顶到 1720 ⇒ contentSpanMs 1650 ⇒ 收网等到 2400。所以 `maxOutputTokens` 850→4096 不是因：v11.9 的 260 本来就远低于 850，上限没咬过人，抬高只是"允许"、不是"驱动"。

改法只落一处，在 `src/config.js`：把 `compressTargetMax: 1800,` 改为 `compressTargetMax: 450,`（第 7 轮自己写的就是 So the fix: revert compressTargetMax to 450）。

下一步在同一轮内发出：`edit_file` 改这一行，同轮 `bash` 跑 `analyze-trace --steps birth --fields finishReason,outputTokens,outputChars,contentSpanMs,ttfbMs,finishWaitMs,promptVersion --last 10`；outputChars p50 回到 390 上下、finishWaitMs p50 回到 900 上下就算好，直接写根因与依据收工。

已排除：`maxOutputTokens` 与 `birthFinishWaitMs` 一起不动——前者理由如上，后者与 2400 的矛盾还没查，动它没有依据。
已排除：再核 analyze-trace 的数据源这条路走不通——第 5 轮 `cat /usr/local/bin/analyze-trace` 的回显是「bash: /usr/local/bin/analyze-trace: No such file or directory」，脚本读不到，就没法从它核 contentSpanMs 的口径，继续找它拿不到东西。
已排除：第 1–6 轮那几条 bash（ls、find、--help、--compare、--steps llm、readlink）都记在台账里、结果就是上面那几个数，再跑拿不到新东西；台账写着「这些不再重跑，除非中间改过东西」⇒ 改完 config.js 才重跑那一条验收。

还没定：`birthFinishWaitMs` 1500 对不上 2400（若 1500 是收网超时上限，2400 不该出现）。验收读数到手后分两种：finishWaitMs p50 落在 900 上下，就说明 1500 与这一跳无关，收工；仍停在 2400 左右，就查 `birthFinishWaitMs` 有没有第二处设定，那时再谈动它。
