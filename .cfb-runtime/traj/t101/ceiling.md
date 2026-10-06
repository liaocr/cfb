# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 37 | 0.514 | 6.21 | 0 | 15 | 7 |
| hand | 27 | 0.444 | 6.17 | 0 | 8 | 7 |

配对 27（flaky-timeout:long-horizon:tie flaky-timeout:tie perf-regression:tie sse-truncated:decoy:win flaky-timeout:win sse-truncated:decoy:tie perf-regression:tie flaky-timeout:tie perf-regression:tie perf-regression:tie perf-regression:tie perf-regression:win perf-regression:tie flaky-timeout:tie eacces-config:win sse-truncated:loss eacces-config:tie eacces-config:decoy:loss eacces-config:long-horizon:tie flaky-timeout:long-horizon:tie sse-truncated:win flaky-timeout:win sse-truncated:decoy:loss wrong-model:long-horizon:loss sse-truncated:long-horizon:loss wrong-model:decoy:win perf-regression:tie）；e=0.564，「更差」e=0.231，阈 10；修好率差（余量点估计）-0.07
手写稿闸：尝试 20、过闸 46、被拒 0、低于地板不压 151；影子省下主调用 131、**未分歧组 0**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 6356.109 字 → 稿 670.87 字 → 拼接后 1801.25 字（压缩比 NaN）

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-12.json；效度账本 +56；飞轮偏好对 +7；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 101   # 过闸且修好的稿进金标注册表（transfer/gold）
