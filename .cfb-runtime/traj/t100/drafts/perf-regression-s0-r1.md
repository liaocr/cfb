原文落定「the compare output seems fixed to those 5 columns. Let me try to find raw data files.」。
落点：`config.js`。
验收只有一条：跑 `analyze-trace --compare v11.9 v11.10 --steps birth --last 10` 拉出 finishWaitMs——
若 p50 回到 900ms 量级 ⇒ 说明收网等待确实回落；若仍停在 2400 ⇒ 说明改动没落在等待参数上，先按原文找原始 trace 数据文件再判。
