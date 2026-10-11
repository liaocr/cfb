# 分叉轨迹计划 t130（digest 892ecf26d815d58c，未发请求）

目的：第一次用真实数据检验尺子有效性：在线效度配对（执行器代理 ↔ 修好）+ raw vs 压缩稿的 L2 对 + 用真实回执校准单价常数。若效度仍 suspect / unvalidated，接受本机目前只能当记录仪，不开始按分搜索。

臂：raw vs policy:base；场景：flaky-timeout, sse-truncated, wrong-model × 3 样本；≤6 轮；起始轮共用、各臂分叉
请求：主调用 ≤99 + 压缩 ≤54（上界：每轮都压、第 1 轮就分歧）；期望主 81 + 压缩 22（影子分叉：跟随臂到第 3 轮才分歧、原文过地板的轮占 0.4）；**期望实付 ≈ $1.177，上界 ≈ $4.081**（max_tokens 8000；常数见 TRAJ_UNIT，首张回执后更新）
产出（估）：L1 对 9、L2 对 9、效度对 ≈90、飞轮对 ≈45、子状态 ≈72

场景 = traj-fixtures 假仓库，与 v9 冻结 5 题不同分布；留出家族 < 4 之前这些结果只用于效度与校准，不用于按分搜索

批准后执行（traj-run 会核对参数与计划一致，跑完写 receipt.json）：
```
node tools/traj-run.mjs --plan .cfb-runtime/traj/t130/plan.json --store-text --variants raw --policy base --only flaky-timeout,sse-truncated,wrong-model --samples 3 --max-rounds 6 --fork --max-tokens 8000 --require-fp --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/traj/t130
```

回灌：node tools/cfb-cycle.mjs confirm --plan 130 --map champion=policy:base,previous=raw   # 或 --parity（auto vs policy:base）

家族覆盖（轨迹数）：eacces-config=24 flaky-timeout=74 perf-regression=33 wrong-model=12 sse-truncated=15；本计划 批量 3 个家族

**按回执校准**（41 张：divergeRound 4 / floorShare 0.22）：期望主 72 + 压缩 12 ≈ $0.99；上界不变。
