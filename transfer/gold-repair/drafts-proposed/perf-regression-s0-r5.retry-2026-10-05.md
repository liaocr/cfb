第 5 轮定了原因，代码一行没动。

已观察到的事实：`CHANGELOG.md` v11.10 那节把 `compressTargetMax` 从 450 放宽到 1800；`analyze-trace --steps birth --fields ...` 打出 contentSpanMs p50: 1650；ttfbMs 640 + contentSpanMs 1650 = 2290，与 2400 对得上。链条：长度目标放宽 ⇒ 输出 390→1720 chars ⇒ contentSpanMs 280→1650 ⇒ 收网等待 900→2400。

当前决定：`compressTargetMax` 回到 450（原话 the fix is to revert compressTargetMax to 450），`src/config.js` 里那行仍是 1800。

已排除：`maxOutputTokens` 不是这一跳的元凶——README 写它是副模型单次输出上限，"只影响 v3 的长度目标"写的是 `compressTargetMax`。
已排除：第 1–2 轮那 4 条 bash（ls、find、cat、which）与 --compare 都跑过，不重走。

还没定：`birthFinishWaitMs` 1500 对不上 2400（若 1500 是超时上限，2400 不该出现）；没查，所以只调回长度目标够不够没底。两条 bash（cat /usr/local/bin/analyze-trace；--compare 加 `--last 5`）回显未到手：先读它们，别急着动 `src/config.js`。

验收：改完跑 `analyze-trace` 看 birth，contentSpanMs p50 与 finishWaitMs p50 要回落（现 1650 与 2400）。
