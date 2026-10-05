# 后续路线（v14.24.0 之后）——按依赖排序，每段都带判据、成本、回退

写于 2026-10-06。前置事实（全部实测，非计划）：
- 尺子已落地：`cfb.gold-standard/1`，12 轴；`node tools/gold-score.mjs` 复算。
- 水位：24 条中 **gold 4**（`sse-truncated-s0-r4`、`sse-truncated-s1-r3`、`wrong-model-s0-r6`、`wrong-model-s1-r5`），not-gold 20；轴通过率 M8 8/24 · E1 7/24 · R1 8/24 · R2 15/24。
- 定律一（改稿即失分）⇒ 差额**不能靠改稿补**，只能重跑那一格。
- 通道现状：`upstream-no-reasoning`（连续 3 次）会让 `traj-run` 停机（t102 已实测，2 行错误记录）。
- 模式 2 靶子现状：微模型 `node tools/train-v5-micro.mjs --eval-only` 七项 `G1✓G2✓ prec=1` 但 **closeCount 0/7**；`node tools/cfb-cycle.mjs plan-bench --dry` 报「策略 base × 金标 2（dev）= 2 次压缩 ≈ $0.015」。

目标顺序沿用你的排法：**① 模式 2 侧模型银标稳定达金标水平 → ② 模式 3 真机证明 → ③ 银标扩量 → ④ 喂微模型**。下面每一段都只服务其中一件事。

---

## P0 · 把「银标达金标水平」变成一条可算的指标（$0，先做这个）

**为什么先做**：你的目标 ① 现在还没有度量。尺子已经能判金标；同一把尺子去量模式 2 吐出来的银标，就得到「银标距金标差哪几轴」⇒ 这才是「stably reach gold level」的定义，不是形容词。

- 动作：`tools/silver-score.mjs`（复用 `measureGold`，输入 = 模式 2 产出的银标条目/`pending` 目录），输出：轴通过率、`gap` 分布、与金标的**逐轴差值**；再加 `--by-family` 与 `--csv`。
- 测试：`test/silver-score.selftest.mjs` —— 银标 fixture 一条「与金标同过 12 轴」、一条「缺 M3/M4」、一条「raw 缺失 ⇒ fail-closed 未测」；登记 `verify.mjs` ORDER。
- 判据（定死再跑）：`node tools/silver-score.mjs --dirs=silver-lab --json` 能出数，且与 `gold-score` 对同一 fixture 的结论**逐轴一致**。
- 回退：只加工具，不动注册表；失败不影响既有闸。

**这一步交出来的就是目标 ① 的验收线**，之后每次改模式 2 都只报这个数。

## P1 · 给条目盖章 + 清掉尺子的两处脏（$0）—— ✅ 已完成（v14.24.1）

- `tools/gold-attest.mjs` 落账：`goldStandard: { version, status, gap, margin, drift, home, at, stampDigest }`，**只加元数据、不碰 `draft`**（动稿即失分），并写 `.cfb-offline/ruler/gold-attest.json`（逐条 from→to + 缺章/过期清单）。幂等：重跑第二次 `0 处变更`。
- 下游全部改读章（8 个消费点，逐个实测）：`three-mode` 的 `goldRulerOk/goldBenchOk/goldTrainOk` · `traj-corpus.rulerIdSet` · `cfb-judge` · `coverage-plan` · `bench-run.gold-use-mismatch` · `buildBenchPlan`（比对靶） · `build-micro-dataset` / `build-change-dataset`（拟合料） · `train-v5-micro`（devGold + `--eval-only` 自检）。
- 尺子两处脏已清：`gold-score --dedup`（24 行 → **19 个唯一 id**，重复副本不重复计票，已是默认口径写进文档）；`countSamples` 排除 `-resume` 同趟复写，并且**只数真消费过稿的趟**（`hand-samples.jsonl` 有同 task+sample 行、跳过带 `error` 的行）。
- 后果（实测）：标尺侧 `goldRulerOk` **17 → 4**，训练侧 **6 → 19**（降级不删数据）；`gold-study` 同步改 dedup ⇒ 24 → 19 个唯一 id。
- 顺手抓到一个真 bug：`gold-attest --check` 报出 `wrong-model_decoy-s0-r4` 状态由 not-gold 翻成 gold —— 根因是 t103 那趟被停机保护掐掉、`results.jsonl` 仍留 hand 行，被当成"第二次独立样本"。收紧 R2 后重盖章，假 gold 撤掉（`gold 4 · not-gold 19`）。
- 判据全绿：`npm run verify:offline` **1168 通过 / 0 失败 / 1 跳过（38/38 套件）**；三套金标自测 **192 条**（`gold-use-split` 52 + `gold-standard` 79 + `gold-attest` 61，含"真注册表章必须新鲜"活体检查）。

## P2 · 转正缺口：把标尺池从 4 条做到 ≥8 条（≤$0.5，通道恢复才开）—— ⏸ 已武装，等 API

**先探测再掏钱**：预检要看到 `fp=非null` 且「思考 N 字」N>0、正文非空，才起 run；不通就 $0 复验，绝不硬跑。
一切真机花费必须过编排器：`node tools/gold-campaign.mjs`（`--dry` 零请求打印计划+估算；预检不合格直接 exit 3，不起轨迹）。

- 待补清单（按 `gold-score --dedup` 的 gap 升序，2026-10-06 实测）：

| 条目 | gap | 还缺 | 补法 |
|---|---:|---|---|
| `sse-truncated_decoy-s0-r4` | 0.2 | E1 + R1 | 现注册稿 750 字 ≠ 台账所发 662 字 ⇒ 用现稿重跑该格，跑完自动对齐 |
| `wrong-model_decoy-s0-r4` | 0.5 | R2 | 同 task+sample 再跑**一趟独立**（不能是 resume，也不能是空跑） |
| `wrong-model_long-horizon-s0-r4` | 0.5 | R2 | 同上 |
| `eacces-config-s0-r5` | 1.0 | M8 | 先把改法句压到恰 1 条当**候选稿** —— 注意：改稿即章过期 ⇒ 那一格必须重跑才能把 E1/R1 重新挣回来 |
| `eacces-config_long-horizon-s0-r5` | 1.7 | M8 + E1/R1/R2 | 改稿 + 重跑 + 补第二趟 |
| 其余 10 条（gap 2.8–7.8） | — | M3/M4/M5/M6 + E1/R1(±E2/R2) | 属"重写稿"而非"补凭据"，别为凑数动它们；`use:'train'` 保留 |

- 4 条**台账里没有 id**（`eacces-config_decoy-s0-r3`、`perf-regression-s0-r6`、`sse-truncated-s0-r5`、`sse-truncated_decoy-s0-r3`）⇒ 不可回放，只能作训练料；转正唯一办法是按新 id 重跑入册。
- 判据：`gold-score` 里 **每个家族 ≥2 条 gold 且 R2 全过**；`node tools/gold-vs-line.mjs` 有新读数（M2 不再未测）；`gold-attest --check` 全新鲜；每条都带趟名，无「自报」。
- 失败回退：任一格没过闸 ⇒ 只登记 `use:'train'`，不进标尺池；**不删数据、不改阈值凑数**（本仓库既有纪律，别为了跑通放宽谓词）。
- 通道实测（2026-10-06）：三次预检 `preflight-failed:notClaude` / `fp=null`（思考 47 字、正文 1 字）/ `fp=vllm-…无放行依据` + `request-timeout`；唯一成功的那条 t103 三格全部 `upstream-no-reasoning` 停机（rounds 0/4/3），零新样本。⇒ 通道恢复前 P2 保持挂起，不再花钱重试。

## P3 · 一次花钱买两个目标：`auto` 臂上尺（≤$1）

把模式 2 的自动压缩稿（`auto` 臂，非手写）放进同一把尺子量 —— 这同时就是目标 ②「真机证明」的证据。

- 动作：`--variants raw,auto --only <P2 用过的家族>`，产出后 `silver-score --dirs=auto-arm`（或 `gold-score --pending … --draft <auto 稿>`）。
- 判据（跑之前钉死）：自动稿 **M3/M4/M5 ≥90%**；同格 **rtf ≤ raw**；`gap` 中位数 ≤ 1.0；并报告「与手写金标的逐轴差值」——差值集中在 M8 就说明侧模型在「留菜单」，改提示词即可，不用加数据。
- 若 M5 不过：先查 `invented-identifier` 是稿的问题还是证据基缺项（P0 的 fixture 已能区分）——不许一上来改阈值。

## P4 · 微模型只喂达标的（$0 训练 + 本地评估）

- 教师料按 `margin` 分层：margin≥0.7 的 gold 做示范对，0.4–0.7 做偏好对的「优」侧，<0.4 不进训练。
- 判据：`node tools/train-v5-micro.mjs --eval-only` 的 **closeCount 从 0/7 起先到 ≥3/7**，且 `prec=1` 不退；到不了就先回 P0 看银标缺口，别扩数据量（你要的是质量先于数量）。
- `node tools/build-micro-dataset.mjs` 的 `gold-overlap` 口径改为「按 `goldStandard.status`」，`open/no-slot-cue` 计数进 CHANGELOG 当回归哨兵。

## P5 · 银标扩量 → 反哺微模型（你的目标 ③④）

- 只在 P3 达标后启动：同家族 × 多样本 × decoy/long-horizon 矩阵扩跑；每批先 `silver-score` 判缺口再谈注册。
- 每批硬指标：批内 gold 级比例、rtf 分布、vsRaw 胜率、成本/条；`node tools/cfb-cycle.mjs plan-bench --dry` 的预算先行（出「≈$X」才开跑）。

---

## 贯穿的三条纪律（写给未来的我，也写给模式 2）

1. **任何「改好了」的断言必须附 `gold-score` 轴表 + 真机趟名**；没趟名 = 没改。
2. **阈值只能改代码 + 改本文 + 加自测一起改**，升版必须递增 `GOLD_STANDARD_VERSION`，旧版结论同时作废。
3. 花钱单元一次只验一个假设；先 `$0` 复验（`--preflight-only`、`--dry`、fixture）干净才掏钱。

## 不做清单（已结案，别再投入）

- 5 条 `stored` 里带装置话术的 flaky/perf/sse_decoy 格子：隔离句不在 `draft`，改稿救不了（已逐条确认出自 `stored`）。
- 「与旧稿相似度」类判据：口径已废，一切结论作废。
- 为凑 30–40 条金标而扩量：金标是尺子不是饲料。
- 用 `rtf 7/9` 的格子反复重造稿：轮数由主模型决定，稿子只影响 M 轴。
