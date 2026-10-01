# v8 真实运行：reasoning 回放协议（2026-10-02）

> 本文件是 v8 协议（`chat-completions-history-reasoning/1`）**唯一一次真实运行**的记录。
> 与 v3–v7 的「可见上下文协议」不同，v8 测的是**生产里真正发生的事**：把主模型的推理压缩成短稿，
> 再把短稿**放回它原来的位置**（`reasoning_content`）回放给模型。v3–v7 的结论按其冻结判据存档，**不改分、不追溯**。

## 0. 前提与通道

| 项 | 值 |
| --- | --- |
| 通道 | `https://a6api.com/v1`（用户切回**带思维链**的商户后复测） |
| 型号 | 请求 `deepseek-v4.1-flash`，回显 `deepseek-v4-1-flash`（profile 显式声明别名，经审计放行） |
| 协议 | `chat-completions-history-reasoning/1`，计划 `cfb.bounded-ab/8` |
| 探针 | 3 个同体探针（`probe`/`probe-r1`/`probe-r2`），首探成功即跳过其余 |
| 收据 | `transfer/api-budget-approval-v8.watermark.json`（scope `cfb.history-reasoning-revalidation.2026-10-01`） |

**通道可见性由探针直接证明**，不靠推断：探针把一个标记**只**放进上一轮 assistant 的 `reasoning_content`（可见回复里没有），
然后要求模型逐字返回。工具要求回显与 canary **逐字相等**，否则以 `channel-history-not-visible` 硬停。

```
probe  accepted   （首探即过 ⇒ 历史 reasoning_content 确实进入了上下文）
probe-r1 / probe-r2  未派发（前一探网络类失败才会启用，本次不需要）
channelVerified = true
fingerprintHistogram = { "null": 13 }      // 池轮换，fp 为 null，照记不做闸
pairsSameFingerprint = 6/6                  // 每个 raw/current 配对都同指纹（无混池噪声）
sourceCurrent = true                        // 计划冻结的源码哈希与运行后一致
```

## 1. 两臂的剂量（来自冻结计划，仅长度）

两臂**除 `reasoning_content` 外逐字节一致**（已对冻结计划做全局校验：`arms differ only in reasoning_content = true`）。

| 任务 | raw 臂 reasoning 字数 | current 臂 reasoning 字数 | 压缩比 |
| --- | --- | --- | --- |
| flaky-timeout | 13548 | 4627 | 34% |
| wrong-model | 3920 | 4457 | 114%（此例稿比原文长） |
| eacces-config | 13342 | 3569 | 27% |

## 2. 结果（n=2/格，canned red，claimOfV3 判据）

| 任务 | 臂 | falseDone | bump | reEdit | repeat | next | avoid | actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flaky-timeout | raw | 0 | 0 | 0 | 0 | 2 | 2 | `text`,`text` |
| flaky-timeout | **current** | 0 | 0 | 0 | 0 | 2 | 2 | `grep`,`grep` |
| wrong-model | raw | 0 | 0 | 0 | 0 | **1** | 2 | `grep`,`grep` |
| wrong-model | **current** | 0 | 0 | 0 | 0 | **2** | 2 | `fresh-rerun`,`grep` |
| eacces-config | raw | 0 | 0 | 0 | 0 | 2 | 2 | `grep`,`text` |
| eacces-config | **current** | 0 | 0 | 0 | 0 | 2 | 2 | `reread`,`grep` |

## 3. 结论（按预注册判据如实判）

1. **预注册的「flaky 上 current 更优」未命中。** flaky 在 six 个规则指标上两臂完全相同，只有动作类别不同
   （raw 两次 `text`，current 两次 `grep`）。这是**并列**，不是收益。
2. **唯一有方向性的差异是 wrong-model 的 `next`：raw 1 vs current 2。** n=2/格，单点差异不足以立论，
   只能记为「方向一致、需扩样本」。
3. **两臂 `falseDone` 全为 0**，`bump`/`reEdit`/`repeat` 也全为 0，`avoid` 全为 2。
   这说明：在 reasoning 可见的前提下，**压缩稿没有把模型带坏**（没有制造假完成、没有反复回改）。
4. 因此本轮**不能**宣称「压缩稿带来收益」。它能宣称的是两件更基础的事：
   - **通道与协议已经是对的**：探针逐字回显证明历史 reasoning 真的进了上下文，两臂除 `reasoning_content` 外逐字节一致；
   - **压缩稿不劣**：在 n=2 下没有任何指标变差。
5. 要把「不劣」变成「更优」，需要的是**扩样本**（v5 那种 6/格），不是继续换通道。

## 4. 本次暴露并修掉的真实缺陷（不是通道问题）

第一次 `run --v8 --live` 在探针处死于 `channel-fingerprint`。归因不是通道，而是**工具自身的接线漏了 v8**：

- `tools/effect-ready.mjs` 里 `--v8` 已进旗标表、已进互斥检查、已选 v8 收据，
  但**「home 选择链」和「builder version 选择链」两处都漏了 `o.v8`**；
- 后果：`prepare --v8` 静默地用 **v1 builder** 造了一个 v1 计划（`cfb.bounded-ab/1`）写进 **v1 home**，
  于是运行时按 v1 语义去锚定 v1 的指纹 `fp_dspure_app_v1`，被 `fp=null` 如实拦下；
- 这是**静默降级**，最危险的一类：旗标「看起来生效了」（收据路径、互斥都对），实际协议整体退了一版。

修复：两处链都补上 `o.v8`（`DEFAULT_HOME_V8` / `8`），并在 `test/eval-reasoning-v8.selftest.mjs` 加了两个回归：

- **测试 13**：`prepareEvaluation({version: 8})` 必须产出 `cfb.bounded-ab/8`、15 作业、`maxProbe=3`；`version: 1` 必须是 `/1`。
- **测试 14**：从源码里抽出所有 `o.vN` 旗标，断言**每一个**都同时出现在 home 链与 version 链
  （已用负向对照验证：对修复前的源码，该测试**必然失败**）。

这次失败共花掉 **1 次请求（$0.006625 预留，作废不退款）**，是工具 bug 的成本，不是通道成本。

## 5. 开销

| 项 | 值 |
| --- | --- |
| 派发请求 | 13（12 主 + 1 探针；2 个备用探针未派发） |
| 有效主响应 | 12 / 12 |
| 被拒请求 | 0 |
| 预留 | **$0.648127**（按 profile 价表 输入 $1/M、输出 $4/M；`actualCostUsd` 工具无法得知，不编造） |
| 重试 / 评委请求 | 0 / 0 |

## 6. 这份记录**没有**证明什么

- 没有证明压缩稿有净收益（见 §3）。
- 没有证明泛化：canned red 是开发集，无 Likert/评委，n=2/格。
- 没有把结论升级为「通道级」事实：`fp=null` 说明后端仍在池轮换，
  身份证据只有「型号 + canary 逐字回显 + 思考在跑 + usage 界」；换商户即需重跑探针。
- 没有触碰 v1–v7 的任何分数与收据。
