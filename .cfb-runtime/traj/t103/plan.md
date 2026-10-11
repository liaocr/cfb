# 分叉轨迹计划 t103（digest 797a2c2b69d77b61，未发请求）

目的：极简省钱微基准（--lite）：自动挑 $0 预筛 #1 策略（p-1490eefcdf）与最高 Fisher 信息量场景（flaky-timeout），4 轮上限 + 影子分叉 + $0.08 硬顶早停

臂：raw vs policy:p-1490eefcdf；场景：flaky-timeout × 1 样本；≤4 轮；起始轮共用、各臂分叉；**有界续跑**：每组后算 e 值，policy:p-1490eefcdf vs raw 任一方向 e ≥ 10（≥2 对）或估算花费 ≥ $0.08 即停
请求：主调用 ≤7 + 压缩 ≤4（上界：每轮都压、第 1 轮就分歧）；期望主 7 + 压缩 4（制度臂 policy:p-1490eefcdf 第 1 轮就压、第 2 轮起分歧、每轮都压；其余跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $0.118，上界 ≈ $0.291**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 1、L2 对 1、效度对 ≈6、飞轮对 ≈3、子状态 ≈4

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t103/plan.json --store-text --variants raw --policy p-1490eefcdf --only flaky-timeout --samples 1 --max-rounds 4 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t103
```

回灌：node tools/cfb-cycle.mjs confirm --plan 103 --map champion=policy:base,previous=raw   # 或 --parity（auto vs policy:base）

家族覆盖（轨迹数）：eacces-config=21 flaky-timeout=28 perf-regression=30 wrong-model=10 sse-truncated=18；本计划 只跑 flaky-timeout，跑完先 `review --plan 103` 再决定下一个家族

**制度臂**：policy:p-1490eefcdf 改了 birthAdaptiveFloor —— 这是**换制度**（什么时候压、什么稿放行），不是调稿：第 1 轮就压、第 2 轮起分歧、每轮都压（计费已按此算，不享受影子省钱）；结论只对「制度 vs 制度」成立，稿的内容规格另量。

**按回执校准**（15 张：divergeRound 5 / floorShare 0.21）：期望主 7 + 压缩 4 ≈ $0.118；上界不变。
