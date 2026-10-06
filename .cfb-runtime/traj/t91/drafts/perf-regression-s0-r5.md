已观察到：`CHANGELOG.md` v11.10 那节把 `compressTargetMax` 从 450 放宽到 1800；`analyze-trace --steps birth --fields ...` 打出 contentSpanMs p50: 1650；ttfbMs 640 + contentSpanMs 1650 = 2290，对上 2400。链条：长度目标放宽 ⇒ 输出 390→1720 chars ⇒ contentSpanMs 280→1650 ⇒ 收网等待 900→2400。

当前决定：`compressTargetMax` 回到 450（原话 the fix is to revert compressTargetMax to 450），`src/config.js` 里那行仍是 1800。

已排除：`maxOutputTokens` 不是这一跳的元凶——README 写它是副模型单次输出上限，"只影响 v3 的长度目标"写的是 `compressTargetMax`。
已排除：第 1–2 轮的 bash 与 --compare 都记在台账里，再跑拿不到新东西。

还没定：`birthFinishWaitMs` 1500 对不上 2400，没查 ⇒ 只调回长度目标够不够没底。两条 bash 的回显也没到手（cat /usr/local/bin/analyze-trace；--compare 加 `--last 5`）：脚本若显示 contentSpanMs 是 trace 里实测的时间差，就说明 1650 算独立读数，照 450 落地；若它是从 outputChars 推算的，它就跟着长度一起涨、不能当独立证据，那时够不够仍未定。

验收：改完再跑 `analyze-trace`，contentSpanMs p50 与 finishWaitMs p50 要回落。
