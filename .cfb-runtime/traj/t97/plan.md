# 分叉轨迹计划 t97（digest 66a5a79170f65af1，未发请求）

目的：模式 1 天花板：hand 臂 = 助手代替副模型手写稿（同一提示词、同一闸链 + G2 决策不变闸）vs raw；量 f(主模型 | 稿) 的上界与「稿该写什么」；hand 永远不采纳为 champion，过闸且修好的稿进金标注册表（gold add）作模式 2 标准

臂：raw vs hand；场景：flaky-timeout × 1 样本；≤8 轮；起始轮共用、各臂分叉
请求：主调用 ≤15 + 压缩 ≤0（上界：每轮都压、第 1 轮就分歧）；期望主 13 + 压缩 0（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $0.163，上界 ≈ $0.525**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 1、L2 对 1、效度对 ≈14、飞轮对 ≈0、子状态 ≈12

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t97/plan.json --store-text --variants raw,hand --only flaky-timeout --samples 1 --max-rounds 8 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t97
```

回灌：node tools/cfb-cycle.mjs ceiling --plan 97   # 模式 1 不走 confirm：hand 不是候选，只量天花板 + 进金标

家族覆盖（轨迹数）：eacces-config=7 flaky-timeout=14 perf-regression=22 wrong-model=0 sse-truncated=4；本计划 只跑 flaky-timeout，跑完先 `review --plan 97` 再决定下一个家族

**按回执校准**（9 张：divergeRound 5 / floorShare 0.2）：期望主 11 + 压缩 0 ≈ $0.138；上界不变。

**模式 1 步进**：hand 臂每到要压缩的那一轮会暂停（results.jsonl 记 awaiting-draft），把副模型本该拿到的 prompt / 原文 / ctx / 协议写进 `.cfb-runtime/traj/t97/pending/<id>.json`；助手写 `drafts/<id>.md` 后**再跑同一条命令**自动续（G2 + 生产闸不过 ⇒ 继续暂停并把违规写回 pending）。压缩调用 0 次（hand 不花钱）。跑完：`ceiling --plan 97`（不是 confirm）→ `gold add --plan 97`。
