# 分叉轨迹计划 t134（digest e0b37007667f4f63，未发请求）

目的：PREREG-v7 运行 t134：sse-truncated、wrong-model 各 6 样本；raw 同窗新跑（不复用 t130）；hand 草稿用 v6+v7 闸门；主指标=修好所需轮数（配对 bootstrap CI）

臂：raw vs hand；场景：sse-truncated, wrong-model × 6 样本；≤6 轮；起始轮共用、各臂分叉
请求：主调用 ≤132 + 压缩 ≤0（上界：每轮都压、第 1 轮就分歧）；期望主 108 + 压缩 0（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $1.35，上界 ≈ $4.62**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 12、L2 对 12、效度对 ≈120、飞轮对 ≈0、子状态 ≈96

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t134/plan.json --store-text --variants raw,hand --only sse-truncated,wrong-model --samples 6 --max-rounds 6 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t134
```

回灌：node tools/cfb-cycle.mjs ceiling --plan 134   # 模式 1 不走 confirm：hand 不是候选，只量天花板 + 进金标

家族覆盖（轨迹数）：eacces-config=24 flaky-timeout=93 perf-regression=33 wrong-model=36 sse-truncated=39；本计划 批量 2 个家族

**按回执校准**（45 张：divergeRound 4 / floorShare 0.22）：期望主 96 + 压缩 0 ≈ $1.2；上界不变。

**模式 1 步进**：hand 臂每到要压缩的那一轮会暂停（results.jsonl 记 awaiting-draft），把副模型本该拿到的 prompt / 原文 / ctx / 协议写进 `.cfb-runtime/traj/t134/pending/<id>.json`；助手写 `drafts/<id>.md` 后**再跑同一条命令**自动续（G2 + 生产闸不过 ⇒ 继续暂停并把违规写回 pending）。压缩调用 0 次（hand 不花钱）。跑完：`ceiling --plan 134`（不是 confirm）→ `gold add --plan 134`。
