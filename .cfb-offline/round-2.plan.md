# 本轮无法成稿：offline-unsafe

override（--lever policy=…）；⚠ 离线裁决不安全：{"usable":5,"harm":["eacces-config"],"meanDelta":-0.0429}

## 各臂离线裁决

| 臂 | 可用题 | 退化 | 不过闸 | 平均 Δ真值 | 可预见伤害 | 安全 |
| --- | --- | --- | --- | --- | --- | --- |
| policy=p-56e56fcd9c | 5/5 | 0 | 0 | -0.0429 | eacces-config | 否 |
| closing=off | 5/5 | 0 | 0 | 0 | — | 是 |
| deadEnd=shelved | 5/5 | 0 | 0 | 0 | — | 是 |
| deadEnd=none | 5/5 | 0 | 0 | -0.0057 | — | 是 |
| selection=balanced | 4/5 | 1 | 0 | 0 | — | 是 |
| selection=strict | 4/5 | 1 | 0 | 0 | — | 是 |
| layout=conclusion-first | 5/5 | 0 | 0 | 0 | — | 是 |
| kItems=off | 5/5 | 0 | 0 | 0 | — | 是 |
| bind=off | 0/5 | 5 | 0 | — | — | 否 |
