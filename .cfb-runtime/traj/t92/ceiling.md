# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 9 | 0.333 | 5.67 | 0 | 3 | 0 |
| hand | 9 | 0.333 | 6 | 0 | 3 | 1 |

配对 9（flaky-timeout:long-horizon:tie flaky-timeout:tie perf-regression:tie sse-truncated:decoy:win flaky-timeout:win sse-truncated:decoy:tie perf-regression:tie flaky-timeout:tie perf-regression:tie）；e=2.333，「更差」e=0.333，阈 10；修好率差（余量点估计）0
手写稿闸：尝试 6、过闸 9、被拒 0、低于地板不压 52；影子省下主调用 40、**未分歧组 0**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 4220.556 字 → 稿 1045.333 字 → 拼接后 1781.333 字（压缩比 0.422）

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-4.json；效度账本 +14；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 92   # 过闸且修好的稿进金标注册表（transfer/gold）
