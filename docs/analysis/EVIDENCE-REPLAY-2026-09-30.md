# 证据程序离线回放（零调用）

判据先于实现预注册于 [架构文档](../EVIDENCE-PROGRAM.md)。命令：`node tools/replay-evidence.mjs`。

| 资产 | 行数 | 可解析 | 四字段齐全 | 宿主授权可执行 | 实时通过 |
|---|---:|---|---|---|---|
| auto-d2*.json | 33 | 31/33（93.94%） | 25/33（75.76%） | 0/33（0%） | 0/33（0%） |
| run4/results.jsonl | 79 | 32/79（40.51%） | 不适用（模型下一动作，不是轮制品） | 0/79（0%） | 0/79（0%） |

旧编译结果逐字相等：33/33（100%）。

## 历史观察（独立机检，非实时回执）

run4 的 canned 观察逐行核对：pass **8**、fail **16**、unknown **55**；可判分母里的通过 8/24（33.33%）。日志无 run provenance、限核回退不算证据；不读取评委或参考答案，也不把历史成功推广为真实效果。保持所有 79 行，绝不按 task/variant/sample 丢掉不同观察。

- 可执行率 0 是没有宿主授权，并非执行器不能执行。
- 历史 pass 不是实时通过率或模型涨分。
- 未运行历史命令；无新环境回执的实时通过率为 0，unknown 单列。
- 解析率只反映公开旧协议的覆盖，不能评价语义正确性。

模型调用 **0**，网络调用 **0**，费用 **0**。本地执行器/完整控制链的通过数字见自测，不与历史回放混算。

## 输入指纹

- `transfer/mr/auto-d2.json`：`a35a02710211729c7c9ecdb11e9624183c13e26f16ec4351c7f9456f130ff3eb`
- `transfer/mr/auto-d2b.json`：`ba7241d45729ca93a22ff8d7b5cf690450ac21ca796c6c95f0627bde8e31c699`
- `transfer/mr/auto-d2c-r.json`：`59c01c8860bfafdc93176e66744c67c062b798147f008251fae215ee52461858`
- `transfer/mr/auto-d2c.json`：`ecadff14af9528649631cc2a9c3877291362c224d96f83d03f43005d05540572`
- `transfer/mr/auto-d2d-part-r.json`：`4d3dc8acd73dab40d71225d75c0da950798e390a294d90ead787bf30b34d02a3`
- `transfer/mr/auto-d2d-part.json`：`f062eef81ef4134fc30c2774f8867b968ef5aeb902ca4948c37244cb211d9e79`
- `transfer/mr/auto-d2d.json`：`6520c460c0d805c3aad85c7984f9e45005f1900dd85079232a57d6176fba8e7e`
- `transfer/mr/auto-d2e-probe-final.json`：`34ed2b8db7260786cecb0c94ab79f43af7fa58c959bad9ccd1e16d7769b34565`
- `transfer/mr/auto-d2e-probe.json`：`4e231bb760683905ce7664d6f08922ef4e14c1d59206cff46bb224c37010d247`
- `transfer/mr/run4/results.jsonl`：`e095c3093f26e5c242869a43b9618f73e9800203a36f3c460c2a2158a913ebe0`
- `tools/effect-mr-specs.json`：`8eff8156455c20b265c7de48023c93071371c1d08a983ae51ca6a53f3cfb9919`
