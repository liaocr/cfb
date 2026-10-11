# 分叉轨迹计划 t128（digest 7d37245ada946f05，未发请求）

目的：路线v2 计划B：raw vs 生产 auto（预注册 transfer/route-2026-10-11/PREREG-v2.md）

臂：raw vs policy:base；场景：eacces-config, flaky-timeout, perf-regression, wrong-model, sse-truncated × 2 样本；≤6 轮；起始轮共用、各臂分叉
请求：主调用 ≤110 + 压缩 ≤60（上界：每轮都压、第 1 轮就分歧）；期望主 90 + 压缩 24（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $1.305，上界 ≈ $4.534**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 10、L2 对 10、效度对 ≈100、飞轮对 ≈50、子状态 ≈80

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t128/plan.json --store-text --variants raw --policy base --only eacces-config,flaky-timeout,perf-regression,wrong-model,sse-truncated --samples 2 --max-rounds 6 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t128
```

回灌：node tools/cfb-cycle.mjs confirm --plan 128 --map champion=policy:base,previous=raw   # 或 --parity（auto vs policy:base）

家族覆盖（轨迹数）：eacces-config=16 flaky-timeout=66 perf-regression=24 wrong-model=5 sse-truncated=9；本计划 批量 5 个家族

**按回执校准**（40 张：divergeRound 4 / floorShare 0.22）：期望主 80 + 压缩 13 ≈ $1.097；上界不变。
