# 金标扩量覆盖矩阵（对账）

> 由 `node tools/coverage-plan.mjs` 生成，零 API（输入指纹 b4309d64a18d4fe8）。格 = 5 家族 ×（3 轮位档 + 3 长度档）= 30；两根轴是同一批条目的两种投影（各加总 = 目标 40 条），不是交叉相乘。

### 每格明细（先投影表、再逐格，缺哪格一目了然）

| 家族 | 轴 | 档 | 已有 | 目标 | 差额 | 用了哪几条 |
|---|---|---|---|---|---|---|
| `eacces-config` | 轮位 | early | 0 | 1 | **差 1** | — |
| `eacces-config` | 轮位 | mid | 2 | 2 | ✓ 满 | eacces-config_decoy-s0-r3、eacces-config_long-horizon-s0-r5 |
| `eacces-config` | 轮位 | late | 0 | 1 | **差 1** | — |
| `eacces-config` | 长度 | <2k | 0 | 1 | **差 1** | — |
| `eacces-config` | 长度 | 2–5k | 2 | 2 | ✓ 满 | eacces-config_decoy-s0-r3、eacces-config_long-horizon-s0-r5 |
| `eacces-config` | 长度 | >5k | 0 | 1 | **差 1** | — |
| `flaky-timeout` | 轮位 | early | 0 | 1 | **差 1** | — |
| `flaky-timeout` | 轮位 | mid | 0 | 2 | **差 2** | — |
| `flaky-timeout` | 轮位 | late | 0 | 2 | **差 2** | — |
| `flaky-timeout` | 长度 | <2k | 0 | 1 | **差 1** | — |
| `flaky-timeout` | 长度 | 2–5k | 0 | 2 | **差 2** | — |
| `flaky-timeout` | 长度 | >5k | 0 | 2 | **差 2** | — |
| `perf-regression` | 轮位 | early | 0 | 1 | **差 1** | — |
| `perf-regression` | 轮位 | mid | 0 | 2 | **差 2** | — |
| `perf-regression` | 轮位 | late | 1 | 2 | **差 1** | perf-regression-s0-r7 |
| `perf-regression` | 长度 | <2k | 0 | 1 | **差 1** | — |
| `perf-regression` | 长度 | 2–5k | 1 | 2 | **差 1** | perf-regression-s0-r7 |
| `perf-regression` | 长度 | >5k | 0 | 2 | **差 2** | — |
| `wrong-model` | 轮位 | early | 0 | 1 | **差 1** | — |
| `wrong-model` | 轮位 | mid | 2 | 2 | ✓ 满 | wrong-model_decoy-s0-r4、wrong-model_long-horizon-s0-r4 |
| `wrong-model` | 轮位 | late | 0 | 1 | **差 1** | — |
| `wrong-model` | 长度 | <2k | 1 | 1 | ✓ 满 | wrong-model_decoy-s0-r4 |
| `wrong-model` | 长度 | 2–5k | 1 | 2 | **差 1** | wrong-model_long-horizon-s0-r4 |
| `wrong-model` | 长度 | >5k | 0 | 1 | **差 1** | — |
| `sse-truncated` | 轮位 | early | 0 | 1 | **差 1** | — |
| `sse-truncated` | 轮位 | mid | 3 | 2 | ✓ 满 | sse-truncated_decoy-s0-r4、sse-truncated_long-horizon-s0-r5、sse-truncated-s0-r5 |
| `sse-truncated` | 轮位 | late | 0 | 1 | **差 1** | — |
| `sse-truncated` | 长度 | <2k | 1 | 1 | ✓ 满 | sse-truncated_decoy-s0-r4 |
| `sse-truncated` | 长度 | 2–5k | 1 | 2 | **差 1** | sse-truncated-s0-r5 |
| `sse-truncated` | 长度 | >5k | 1 | 1 | ✓ 满 | sse-truncated_long-horizon-s0-r5 |

标尺侧 8 条（use=ruler）· 已放行成训练料的注册表条目 0 条 · traj 训练料 5 条（另有 7 条因命中已入册标尺被剔除，不计入本表）

| 家族 | 已有 | 目标 | 缺口 | 早≤r2 | 中r3–5 | 晚≥r6 | <2k | 2–5k | >5k |
|---|---|---|---|---|---|---|---|---|---|
| `eacces-config` | 2 | 8 | **6** | 0 | 2 | 0 | 0 | 2 | 0 |
| `flaky-timeout` | 0 | 8 | **8** | 0 | 0 | 0 | 0 | 0 | 0 |
| `perf-regression` | 1 | 8 | **7** | 0 | 0 | 1 | 0 | 1 | 0 |
| `wrong-model` | 2 | 8 | **6** | 0 | 2 | 0 | 1 | 1 | 0 |
| `sse-truncated` | 3 | 8 | **5** | 0 | 3 | 0 | 1 | 1 | 1 |
| **合计** | 8 | 40 | **32** | | | | | | |

## 下一批（预注册命令，$0 出稿前不花钱）

命令里不含 `--force`，跑之前自己核对是否已有同设计未执行的计划：

```sh
node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios eacces-config --samples 1 --round-band early --min-raw-chars 800 --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：eacces-config 缺口 6 条（当前档 early/<2k）"
node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios flaky-timeout --samples 1 --round-band early --min-raw-chars 800 --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：flaky-timeout 缺口 8 条（当前档 early/<2k）"
node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios perf-regression --samples 1 --round-band early --min-raw-chars 800 --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：perf-regression 缺口 7 条（当前档 early/<2k）"
node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios wrong-model --samples 1 --round-band early --min-raw-chars 800 --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：wrong-model 缺口 6 条（当前档 early/>5k）"
node tools/cfb-cycle.mjs plan-traj --arms raw,hand --scenarios sse-truncated --samples 1 --round-band early --min-raw-chars 800 --max-rounds 9 --stop --cap-usd 0.15 --purpose "扩量批次：sse-truncated 缺口 5 条（当前档 early/<2k）"
```

说明：`--round-band` / `--min-raw-chars` 只决定**挑哪一轮、要多长的原文**，不参与判定、不改闸值（实现见 `tools/cfb-cycle.mjs` cmdPlanTraj）。
