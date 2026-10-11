本轮增量：ttfbMs 640 + contentSpanMs 1650 = 2290 已贴住 finishWaitMs p50 2400，多出来的等待全在生成段。链条：`compressTargetMax` 从 450 抬到 1800、输出 390 涨到 1720 字。原文结论是那句 "the fix is to revert compressTargetMax to 450"。

改法：`src/config.js` 里 `DEFAULTS` 的 `compressTargetMax` 回 450，`maxOutputTokens` 与 `birthFinishWaitMs: 1500` 不动。已排除把 `birthFinishWaitMs: 1500` 当超时元凶——原文只写到 "Perhaps … is a timeout"。本轮已发出 `cat /usr/local/bin/analyze-trace` 与 `--compare v11.9 v11.10 --steps birth … --last 5`，等输出。未解：原文还留着 "is that the intended fix?"。

验收：跑 `--steps birth --fields finishReason,outputTokens,outputChars,contentSpanMs,ttfbMs,finishWaitMs,promptVersion --last 5`，看 finishWaitMs 回 900 左右、contentSpanMs 回 280 左右；如果没回，先看清 `promptVersion` 那列再说。
