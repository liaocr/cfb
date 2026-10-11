# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 29 | 0.345 | 6.1 | 0 | 6 | 7 |
| hand | 26 | 0.385 | 6.2 | 0 | 7 | 8 |

配对 24（flaky-timeout:loss sse-truncated:decoy:tie perf-regression:tie flaky-timeout:loss perf-regression:tie perf-regression:tie perf-regression:tie perf-regression:win perf-regression:tie flaky-timeout:loss eacces-config:win sse-truncated:loss eacces-config:tie sse-truncated:decoy:loss eacces-config:tie perf-regression:tie eacces-config:win flaky-timeout:tie flaky-timeout:loss perf-regression:tie wrong-model:loss sse-truncated:win wrong-model:win sse-truncated:loss）；e=0.193，「更差」e=0.717，阈 10；修好率差（余量点估计）0.04
手写稿闸：尝试 33、过闸 33、被拒 0、低于地板不压 137；影子省下主调用 112、**未分歧组 2**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 5418.788 字 → 稿 812.182 字 → 拼接后 1998.522 字（压缩比 NaN）

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-13.json；效度账本 +45；飞轮偏好对 +5；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 127   # 过闸且修好的稿进金标注册表（transfer/gold）
