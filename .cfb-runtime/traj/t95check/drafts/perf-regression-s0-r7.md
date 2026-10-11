已观察：v11.9 → v11.10 的读数是 outputTokens 260→1150、outputChars 390→1720、contentSpanMs 280→1650、finishWaitMs 900→2400，同时 promptVersion 从 `compress-v3h:250-450` 变成 `compress-v3h:250-1800`；`cat src/config.js` 见 `compressTargetMax: 1800,`。

归因：`compressTargetMax` 抬到 1800 ⇒ 提示词里的目标把输出顶到 1720 ⇒ contentSpanMs 1650 ⇒ 收网等到 2400。`maxOutputTokens` 850→4096 不是因：v11.9 的 260 远低于旧上限 850，上限从没咬过人，抬高只是"允许"、不是"驱动"。

本轮只欠一个动作：改文件。改法只落一处，在 `src/config.js`，把 `compressTargetMax: 1800,` 改为 `compressTargetMax: 450,`（第 7 轮自己写的就是 So the fix: revert compressTargetMax to 450）。

下一步就在这一轮内发出 `edit_file` 改这一行，然后 `bash` 跑一次 `analyze-trace --steps birth --fields finishReason,outputTokens,outputChars,contentSpanMs,ttfbMs,finishWaitMs,promptVersion --last 10` 验收：outputChars p50 回到 390 上下、finishWaitMs p50 回到 900 上下即收工，写出根因与依据即可交付。

已排除：改 `maxOutputTokens` 或 `birthFinishWaitMs`——README 写 `maxOutputTokens` 是副模型输出上限、"只影响 v3 的长度目标"说的是 `compressTargetMax`；`birthFinishWaitMs` 与 2400 的矛盾没有依据支撑，动它是猜。
已排除：再取证——第 5 轮 `cat /usr/local/bin/analyze-trace` 已回显「bash: /usr/local/bin/analyze-trace: No such file or directory」，字段口径核不了；第 1–6 轮的 ls、find、--help、--compare、--steps llm、readlink 都记在台账里、结果就是上面那几个数，再跑同样几条拿不到新东西。
已排除：读完更多 trace 再改——台账写着「这些不再重跑，除非中间改过东西」，而改这个文件正是唯一没做过的动作。

未解（不阻断本轮）：`birthFinishWaitMs` 1500 与 2400 为什么并存，第 7 轮也没查。若验收读数没回落，把 450 保持住并在结论里写明这一条未解，不要再回到 bash 取证。
