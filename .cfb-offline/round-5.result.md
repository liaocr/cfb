# 第 5 轮回灌：policy=p-56e56fcd9c@bbb939e0

来源：ledger；账本完整：否（有样本缺失 / 被拒，按已有配对计）；本轮预占 USD 0.7131

| 任务 | 切分 | candidate 结构分 | control 结构分 | 结果 |
| --- | --- | --- | --- | --- |
| eacces-config | holdout | 2 | 2 | tie |
| wrong-model | holdout | 1 | 2 | loss |
| perf-regression | dev | 2 | 2 | tie |
| sse-truncated | dev | 2 | 2 | tie |

留出题：7 对（胜 2 / 负 1 / 平 4，P(p>0.5)=0.6367），不同留出题 2；dev：11 对，P=0.5；有效 n（ICC 折算）10.11；判据：还缺：留出 e 值 0.917 < 10（还需连胜 ≈ 6 场留出）；全部 e 值 0.506 < 10

e 值（任意停时有效，v4）：留出 0.917 / 全部 0.506 / 「更差」0.306；采纳阈 ≥ 10（α=0.1），否决阈 ≥ 10
泛化差距（v4.3，Ladder 视角）：dev 净胜率 0 − 留出 0.143 = -0.143 ⇒ ok；ICC=0.3（默认值，`ruler --write-design` 可换成实测）

飞轮：追加 1 个偏好对到 .cfb-offline/train/pairs.jsonl

累计 18 对：胜 5 / 负 4 / 平 9；p 后验均值 0.525，95% 0.3115–0.7337，P(p>0.5)=0.5903；已买到 0.0237 bit，再买一对期望 0.0221 bit

**判定：continue**  ⇒ 证据不够：下一轮 `plan` 会继续同一假设
