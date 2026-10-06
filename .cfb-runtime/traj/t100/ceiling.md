# 模式 1 天花板（undetermined）

| 臂 | n | 修好率 | 到修好轮数 | 假宣称 | 修好后验收 | 重复 |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 27 | 0.407 | 6.27 | 0 | 10 | 6 |
| hand | 17 | 0.294 | 6.6 | 0 | 3 | 6 |

配对 17（flaky-timeout:long-horizon:tie flaky-timeout:tie perf-regression:tie sse-truncated:decoy:win flaky-timeout:win sse-truncated:decoy:tie perf-regression:tie flaky-timeout:tie perf-regression:tie perf-regression:tie perf-regression:tie perf-regression:win perf-regression:tie flaky-timeout:tie eacces-config:win sse-truncated:loss eacces-config:tie）；e=1.9，「更差」e=0.233，阈 10；修好率差（余量点估计）-0.113
手写稿闸：尝试 18、过闸 26、被拒 0、低于地板不压 97；影子省下主调用 85、**未分歧组 0**（整条没触发 ⇒ 与 raw 同、计平手）；原文均 4952.692 字 → 稿 857.923 字 → 拼接后 2126.167 字（压缩比 NaN）
⚠ 还有 6 条 hand 轨迹在等手写稿（未计入）：eacces-config#1 r5 sse-truncated#1 r3 perf-regression#1 r7 flaky-timeout#1 r4 wrong-model#0 r6 wrong-model#1 r5

**分不出**：余量不显著，别把它当天花板用；看 review 里的分歧轮再决定

写入 .cfb-offline/ruler/ceiling-11.json；效度账本 +36；飞轮偏好对 +1；hand 臂永远不能当 champion：这里量的是 f(主模型 | 稿) 的上界（修好率差 = 余量点估计）与稿的内容规格；≥4 对、≥2 家族且 e ≥ 阈才算分得出
下一步: node tools/cfb-cycle.mjs gold add --plan 100   # 过闸且修好的稿进金标注册表（transfer/gold）
