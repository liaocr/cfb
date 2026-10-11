# 分叉轨迹计划 t95（digest 5b80d89852958fce，未发请求）

目的：模式 1 天花板：hand 臂 = 助手代替副模型手写稿（同一提示词、同一闸链 + G2 决策不变闸）vs raw；量 f(主模型 | 稿) 的上界与「稿该写什么」；hand 永远不采纳为 champion，过闸且修好的稿进金标注册表（gold add）作模式 2 标准

臂：raw vs hand；场景：perf-regression × 1 样本；≤9 轮；起始轮共用、各臂分叉；**有界续跑**：每组后算 e 值，hand vs raw 任一方向 e ≥ 10（≥4 对）或估算花费 ≥ $0.3 即停
请求：主调用 ≤7 + 压缩 ≤0（上界：每轮都压、第 1 轮就分歧）；期望主 7 + 压缩 0（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4；raw 复用 .cfb-runtime/traj/t15/results.jsonl 的前 7 轮、只付续跑的 2 轮；跟随臂第 4 轮分歧、付之后的 5 轮）；**期望实付 ≈ $0.088，上界 ≈ $0.245**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 1、L2 对 1、效度对 ≈16、飞轮对 ≈0、子状态 ≈14

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t95/plan.json --store-text --fork-from .cfb-runtime/traj/t15/results.jsonl --variants raw,hand --only perf-regression --samples 1 --max-rounds 9 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t95
```

回灌：node tools/cfb-cycle.mjs ceiling --plan 95   # 模式 1 不走 confirm：hand 不是候选，只量天花板 + 进金标

家族覆盖（轨迹数）：eacces-config=7 flaky-timeout=14 perf-regression=18 wrong-model=0 sse-truncated=4；本计划 只跑 perf-regression，跑完先 `review --plan 95` 再决定下一个家族

**按回执校准**（7 张：divergeRound 4 / floorShare 0.2）：期望主 7 + 压缩 0 ≈ $0.088；上界不变。

**延长**：.cfb-runtime/traj/t15/results.jsonl 里的 raw 被 7 轮上限截断（最后一轮还在发调用）⇒ raw 从第 8 轮续跑（前 7 轮零主调用、仓库由重放恢复）；跟随臂最早在第 4 轮（旧轨迹第一次过地板）分歧，之前影子。

**非同期对照**：raw 臂复用 .cfb-runtime/traj/t15/results.jsonl（4 条，最早 2026-10-05T04:19:38.478Z）。平台试验里的 non-concurrent control：主模型若有时间漂移会偏；只在同一模型 id、短窗口内用，review 时把两次的日期并排看；多个候选共用同一 raw ⇒ 候选之间的比较相关，别把 k 个候选里挑最好的那个当独立证据。

**模式 1 步进**：hand 臂每到要压缩的那一轮会暂停（results.jsonl 记 awaiting-draft），把副模型本该拿到的 prompt / 原文 / ctx / 协议写进 `.cfb-runtime/traj/t95/pending/<id>.json`；助手写 `drafts/<id>.md` 后**再跑同一条命令**自动续（G2 + 生产闸不过 ⇒ 继续暂停并把违规写回 pending）。压缩调用 0 次（hand 不花钱）。跑完：`ceiling --plan 95`（不是 confirm）→ `gold add --plan 95`。
