# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 10 | 0.4 | 7 | 0 | 4 | 0 |
| hand | 10 | 0.3 | 6 | 0 | 3 | 2 |

配对 10（flaky-timeout:long-horizon:tie flaky-timeout:tie perf-regression:tie sse-truncated:decoy:win flaky-timeout:win sse-truncated:decoy:tie perf-regression:tie flaky-timeout:tie perf-regression:tie perf-regression:tie）；e=2.333，「更差」e=0.333，阈 10；修好率差（余量点估计）-0.1
手写稿闸：尝试 6、过闸 10、被拒 0、低于地板不压 60；影子省下主调用 47、**未分歧组 0**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 4209.7 字 → 稿 1077.1 字 → 拼接后 1902.7 字（压缩比 0.452）

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-5.json；效度账本 +15；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 93   # 过闸且修好的稿进金标注册表（transfer/gold）
