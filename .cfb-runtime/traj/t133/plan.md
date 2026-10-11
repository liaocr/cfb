# 分叉轨迹计划 t133（digest a810203cef6cf4ff，未发请求）

目的：PREREG-v6 运行：sse-truncated、wrong-model；hand 臂用 v6 闸门（G-v6-1/2/3）；raw 复用 t130；flaky-timeout 已移出 dev 尺子。预算不设上限（用户指示），本计划仅记录期望与参考上界。

臂：raw vs hand；场景：sse-truncated, wrong-model × 3 样本；≤6 轮；起始轮共用、各臂分叉
请求：主调用 ≤30 + 压缩 ≤0（上界：每轮都压、第 1 轮就分歧）；期望主 18 + 压缩 0（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4；raw 复用自 .cfb-runtime/traj/t130/results.jsonl，不付）；**期望实付 ≈ $0.225，上界 ≈ $1.05**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 6、L2 对 6、效度对 ≈60、飞轮对 ≈0、子状态 ≈48

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t133/plan.json --store-text --fork-from .cfb-runtime/traj/t130/results.jsonl --variants raw,hand --only sse-truncated,wrong-model --samples 3 --max-rounds 6 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t133
```

回灌：node tools/cfb-cycle.mjs ceiling --plan 133   # 模式 1 不走 confirm：hand 不是候选，只量天花板 + 进金标

家族覆盖（轨迹数）：eacces-config=24 flaky-timeout=93 perf-regression=33 wrong-model=30 sse-truncated=33；本计划 批量 2 个家族

**按回执校准**（44 张：divergeRound 4 / floorShare 0.22）：期望主 12 + 压缩 0 ≈ $0.15；上界不变。

**非同期对照**：raw 臂复用 .cfb-runtime/traj/t130/results.jsonl（9 条，最早 2026-10-11T11:26:16.699Z）。平台试验里的 non-concurrent control：主模型若有时间漂移会偏；只在同一模型 id、短窗口内用，review 时把两次的日期并排看；多个候选共用同一 raw ⇒ 候选之间的比较相关，别把 k 个候选里挑最好的那个当独立证据。

**模式 1 步进**：hand 臂每到要压缩的那一轮会暂停（results.jsonl 记 awaiting-draft），把副模型本该拿到的 prompt / 原文 / ctx / 协议写进 `.cfb-runtime/traj/t133/pending/<id>.json`；助手写 `drafts/<id>.md` 后**再跑同一条命令**自动续（G2 + 生产闸不过 ⇒ 继续暂停并把违规写回 pending）。压缩调用 0 次（hand 不花钱）。跑完：`ceiling --plan 133`（不是 confirm）→ `gold add --plan 133`。
