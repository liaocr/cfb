# 第 5 轮计划（已冻结，未发任何请求）

**假设**：`policy=p-56e56fcd9c` vs champion `{"bind":"on","kItems":"on","closing":"on","deadEnd":"paired","selection":"keepAll","layout":"state-first"}`（prompt；帕累托极限合成策略：bounded 延续段（带台账标识符溯源与去重）+ compact 极简工程状态部件（消除双倍叠加与冗长说教）+ modular 按轮次动态提示词裁剪（节省 ~260 input tok/轮）+ birthAdaptiveFloor 动态水位触发器 + 飞轮偏好对蒸馏正反对比示范（In-Context DPO））

选它的理由：override（--lever policy=…）；⚠ 离线裁决不安全：{"usable":5,"harm":["eacces-config"],"meanDelta":-0.0429}

任务池 `ea7512a4e43a`（5 题；留出 eacces-config,wrong-model）；本轮轮换 eacces-config,flaky-timeout,wrong-model,perf-regression,sse-truncated；champion 策略 `base`

## 配对（每题 1 对，两臂只有第 2 轮 reasoning 不同）

| 任务 | 切分 | control 字数 | candidate 字数 |
| --- | --- | --- | --- |
| eacces-config | holdout | 1921 | 2349 |
| flaky-timeout | dev | 3076 | 2733 |
| wrong-model | holdout | 2621 | 2913 |
| perf-regression | dev | 2396 | 2588 |
| sse-truncated | dev | 3204 | 2933 |

## 离线真值维度（零 API；只做安全过滤与方向校验，不做排序）

| 任务 | raw 综合 | control 综合 | candidate 综合 | Δ（candidate−control） |
| --- | --- | --- | --- | --- |
| eacces-config | 0.8333 | 0.9191 | 0.7048 | -0.2143 |
| flaky-timeout | 0.6548 | 0.9167 | 0.9405 | 0.0238 |
| wrong-model | 0.5238 | 0.9167 | 0.9167 | 0 |
| perf-regression | 0.5952 | 0.9405 | 0.9167 | -0.0238 |
| sse-truncated | 0.6071 | 0.8214 | 0.8214 | 0 |

离线裁决：可用 5/5 题，平均 Δ -0.0429，可预见伤害 eacces-config ⇒ ⚠ 不安全（--force 才会成稿）

## 钱与信息

- 请求：13（主 10 + 探针 3）；scope `cfb.candidate-replay.2026-10-02.r5`；每轮上限 USD 1 / 13 请求
- 预占（账本锁定上限）：USD 0.7704；预计实付：USD 0.387
- 这个假设到目前：14 对（胜 5 / 负 3 / 平 6），P(p>0.5)=0.6964
- 本轮 5 对期望买到 0.1131 bit，≈ USD 3.4218/bit
- 判定规则（v3）：全部对 Beta(1,1) 序贯 + **留出题闸门**（≥2 个不同留出题、≥4 对留出、留出 P(p>0.5) ≥ 0.95 才采纳）；同题重复按 ICC=0.3 折算有效 n；dev 题只用来否决 / 提议，不用来采纳
- 若真实胜率 0.7，中位 12 对判定；0.8 ⇒ 8 对（不含留出闸门的额外要求）

## 预检

状态：live-preflight-ready

## 需要你批准后才会花钱

```
# 批准范围：scope cfb.candidate-replay.2026-10-02.r5，≤ 13 请求，预占 ≤ USD 0.7704，计划摘要 16590d920414fcec
node tools/effect-ready.mjs doctor --v9 --round 5
node tools/effect-ready.mjs run --live --v9 --round 5      # 在有网络许可、设了 DEEPSEEK_API_KEY 的环境
node tools/cfb-cycle.mjs ingest --round 5                   # 跑完回来：配对 → 后验 → adopt/reject/continue
```
排序器预判（CPU，93 对飞轮，留一 CV 0.763）：candidate − control 平均 0.000（只是预判，不替代评委；为负时考虑换假设省这一轮）
