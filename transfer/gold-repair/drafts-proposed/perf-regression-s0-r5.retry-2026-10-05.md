已观察：`CHANGELOG.md` v11.10 写 `compressTargetMax 450 → 1800`；`cat src/config.js` 见 `compressTargetMax: 1800,`；640 + 1650 = 2290，对上 2400。链条：长度目标放宽 ⇒ 输出 390→1720 ⇒ contentSpanMs 280→1650 ⇒ 等待 900→2400。

改法只落一处，在 `src/config.js`：把 `compressTargetMax: 1800,` 改为 `compressTargetMax: 450,`（原文 the fix is to revert compressTargetMax to 450）。

下一步同一轮内发出：`edit_file` 改这一行，同轮 `bash` 跑 `analyze-trace --steps birth --fields ...`，看 contentSpanMs 与 finishWaitMs 的 p50 是否回落到 280 与 900；回落即收工，别重跑台账里的。

已排除：`maxOutputTokens` 不是元凶——README 写它是副模型输出上限，"只影响 v3 的长度目标"说的是 `compressTargetMax`。
已排除：第 1–2 轮的 bash 与 --compare 已记台账，再跑拿不到新东西。

还没定：`birthFinishWaitMs` 1500 对不上 2400，没查 ⇒ 够不够没底。两条未回显的 bash（cat /usr/local/bin/analyze-trace；--compare 加 `--last 5`）到手后分两种：脚本若显示 contentSpanMs 是从 outputChars 推算的，就不能当独立证据——但这一行先落地。
