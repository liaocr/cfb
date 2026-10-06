# 分叉轨迹计划 t126（digest 3c00ba75c6d84269，未发请求）

目的：第一次用真实数据检验尺子有效性：在线效度配对（执行器代理 ↔ 修好）+ raw vs 压缩稿的 L2 对 + 用真实回执校准单价常数。若效度仍 suspect / unvalidated，接受本机目前只能当记录仪，不开始按分搜索。

臂：raw vs policy:base；场景：flaky-timeout × 1 样本；≤5 轮；起始轮共用、各臂分叉
请求：主调用 ≤9 + 压缩 ≤5（上界：每轮都压、第 1 轮就分歧）；期望主 7 + 压缩 2（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $0.103，上界 ≈ $0.372**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 1、L2 对 1、效度对 ≈8、飞轮对 ≈4、子状态 ≈6

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t126/plan.json --store-text --variants raw --policy base --only flaky-timeout --samples 1 --max-rounds 5 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t126
```

回灌：node tools/cfb-cycle.mjs confirm --plan 126 --map champion=policy:base,previous=raw   # 或 --parity（auto vs policy:base）

家族覆盖（轨迹数）：eacces-config=22 flaky-timeout=74 perf-regression=30 wrong-model=11 sse-truncated=19；本计划 只跑 flaky-timeout，跑完先 `review --plan 126` 再决定下一个家族

**按回执校准**（38 张：divergeRound 4 / floorShare 0.22）：期望主 6 + 压缩 1 ≈ $0.083；上界不变。
