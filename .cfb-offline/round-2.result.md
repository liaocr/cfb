# 第 2 轮回灌：policy=p-56e56fcd9c@bbb939e0

来源：ledger；账本完整：是；本轮预占 USD 0.7131

| 任务 | 切分 | candidate 结构分 | control 结构分 | 结果 |
| --- | --- | --- | --- | --- |
| eacces-config | holdout | 2 | 2 | tie |
| flaky-timeout | dev | 2 | 2 | tie |
| wrong-model | holdout | 2 | 1 | win |
| perf-regression | dev | 2 | 1 | win |
| sse-truncated | dev | 2 | 1 | win |

留出题：2 对（胜 1 / 负 0 / 平 1，P(p>0.5)=0.7122），不同留出题 2；dev：3 对，P=0.8395；有效 n（ICC 折算）5；判据：还缺：留出 e 值 1.5 < 10（还需连胜 ≈ 4 场留出）；全部 e 值 3.75 < 10

e 值（任意停时有效，v4）：留出 1.5 / 全部 3.75 / 「更差」0.25；采纳阈 ≥ 10（α=0.1），否决阈 ≥ 10
泛化差距（v4.3，Ladder 视角）：dev 净胜率 0.667 − 留出 0.5 = 0.167 ⇒ ok；ICC=0.3（默认值，`ruler --write-design` 可换成实测）

飞轮：追加 3 个偏好对到 .cfb-offline/train/pairs.jsonl

累计 5 对：胜 3 / 负 0 / 平 2；p 后验均值 0.7143，95% 0.3588–0.9567，P(p>0.5)=0.8906；已买到 0.502 bit，再买一对期望 0.0365 bit

**判定：continue**  ⇒ 证据不够：下一轮 `plan` 会继续同一假设
