# 第 4 轮回灌：policy=p-56e56fcd9c@bbb939e0

来源：ledger；账本完整：否（有样本缺失 / 被拒，按已有配对计）；本轮预占 USD 0.7131

| 任务 | 切分 | candidate 结构分 | control 结构分 | 结果 |
| --- | --- | --- | --- | --- |
| flaky-timeout | dev | 1 | 2 | loss |
| wrong-model | holdout | 2 | 2 | tie |
| perf-regression | dev | 1 | 2 | loss |
| sse-truncated | dev | 2 | 2 | tie |

留出题：5 对（胜 2 / 负 0 / 平 3，P(p>0.5)=0.791），不同留出题 2；dev：9 对，P=0.5；有效 n（ICC 折算）9.09；判据：还缺：留出 e 值 2.333 < 10（还需连胜 ≈ 3 场留出）；全部 e 值 0.758 < 10

e 值（任意停时有效，v4）：留出 2.333 / 全部 0.758 / 「更差」0.258；采纳阈 ≥ 10（α=0.1），否决阈 ≥ 10
泛化差距（v4.3，Ladder 视角）：dev 净胜率 0 − 留出 0.4 = -0.4 ⇒ ok；ICC=0.3（默认值，`ruler --write-design` 可换成实测）

飞轮：追加 2 个偏好对到 .cfb-offline/train/pairs.jsonl

累计 14 对：胜 5 / 负 3 / 平 6；p 后验均值 0.5625，95% 0.3229–0.7873，P(p>0.5)=0.6964；已买到 0.1143 bit，再买一对期望 0.0255 bit

**判定：continue**  ⇒ 证据不够：下一轮 `plan` 会继续同一假设
