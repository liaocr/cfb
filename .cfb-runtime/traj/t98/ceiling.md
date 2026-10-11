# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 15 | 0.267 | 7 | 0 | 4 | 2 |
| hand | 15 | 0.333 | 6.6 | 0 | 3 | 4 |

配对 15（flaky-timeout:long-horizon:tie flaky-timeout:tie perf-regression:tie sse-truncated:decoy:win flaky-timeout:win sse-truncated:decoy:tie perf-regression:tie flaky-timeout:tie perf-regression:tie perf-regression:tie perf-regression:tie perf-regression:win perf-regression:tie flaky-timeout:tie eacces-config:win）；e=6.2，「更差」e=0.2，阈 10；修好率差（余量点估计）0.066
手写稿闸：尝试 16、过闸 24、被拒 0、低于地板不压 88；影子省下主调用 76、**未分歧组 0**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 5153.333 字 → 稿 898.5 字 → 拼接后 2263.375 字（压缩比 NaN）

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-9.json；效度账本 +22；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 98   # 过闸且修好的稿进金标注册表（transfer/gold）
