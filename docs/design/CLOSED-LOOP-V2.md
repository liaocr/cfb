# 闭环 v2：按比特买证据（v14.2，2026-10-02）

> **约束**：用户只有几美元；愿意放弃一些东西，换一台**真的在转、每一分钱都买到信息**的迭代机。
> **结论先说**：v14.0 的「持续训练架构」在三处断开（候选退化、奖励悬空、环路不闭合），本版把三处接上，代价是明确放弃一批东西（§6）。
> 本文件只写现状与证据；没跑过的事一律写「未跑」。

---

## 0. v14.0 哪里断了（有代码证据，用户已核实）

| 断点 | 证据 | 后果 |
|---|---|---|
| **候选生成是「贴补」不是「生成」** | 旧 `applyKnobs` 在固定前缀上 `slice` / 追加一句；`layeredSet` 6 臂里只有 2 份不同文本；K1 在前缀里根本不存在 | 「9 个候选」实为同一稿的两种写法；离线排序在比较噪声 |
| **奖励是评委 Likert 的加权和** | `DEFAULT_WEIGHTS` 写死；评委维从未与人工裁决对齐；`judgeCapacity` 把状态空间的 bit 当信息量 | 分数高 ≠ 主模型下一步更对；按它搜索 = 对噪声过拟合 |
| **环路没闭合** | `cfb-cycle run` 到「出候选组」为止；`effect-ready` 的 v8 计划不吃候选；`feedback()` 的观测数恒为 0 | 「一直训练」在代码里不存在 |
| **截断顺序**（用户补充） | 固定前缀截断发生在 K 项之前 ⇒ 任何「K 项开关」臂都是空操作 | 杠杆表里的最大杠杆实际不可测 |

---

## 1. 现在的环（全部在代码里，零 API 可走通）

```
                ┌──────────────────────────────────────────────────────────────────┐
                │  champion.json（当前生产等价旋钮；初始 = BASELINE_KNOBS）          │
                └──────────────┬───────────────────────────────────────────────────┘
                               ▼
 ① 成稿   candidates.mjs      5 道冻结任务 × {control = champion 生产重编译, candidate = champion+1 个杠杆}
                               过生产闸门（长度包络 / 无发明标识符 / 三元组保留）；退化（文本相同）如实标出
                               ▼
 ② 离线裁决 truth-dims.mjs    6 个任务真值维（零 API）：只做安全过滤 + 方向校验 + 「可用 ≥3 题」，不排序
                               ▼
 ③ 冻结   eval-plan.mjs       v9 计划 cfb.bounded-ab/9：每题 1 对 + 3 同体探针 = 13 请求；两臂去掉 reasoning 逐字节一致
          api-budget.mjs      审计：≤13 请求 / ≤USD 1 / 轮次 1–20 / 任务 ≥3 不重复 / 假设必填 / 限额防篡改
                               ▼  ← 停下来等人批准；plan 永远不发请求
 ④ 花钱   effect-ready.mjs    run --live --v9 --round N（唯一花钱的命令；收据 transfer/api-budget-approval-v9-rN.watermark.json）
                               ▼
 ⑤ 回灌   experiment.mjs      配对胜负（结构分 = next+avoid−falseDone−bump−reEdit−repeat，与 live 判据同源）
          cfb-cycle ingest    → Beta(1,1) 后验 P(p>0.5) → adopt / reject / continue → history.json
                               ▼
 ⑥ 采纳   champion.json       adopt ⇒ champion 换新 ⇒ 下一轮 control 自动是它；propose ⇒ 生产 diff / src 改动说明（不写 src）
```

命令（`tools/cfb-cycle.mjs`）：

```sh
node tools/cfb-cycle.mjs doctor                      # 9 项预检（Node 20 只影响 live）
node tools/cfb-cycle.mjs plan   [--pricing FILE]     # 零 API：成稿 → 离线裁决 → 冻结 v9 计划 → 打印钱与信息 → 停
node tools/effect-ready.mjs run --live --v9 --round 1   # 需要人批准；Node ≥ 22、网络、DEEPSEEK_API_KEY
node tools/cfb-cycle.mjs ingest --round 1            # 从收据账本回灌；--report FILE 可离线演练
node tools/cfb-cycle.mjs propose                     # 把已采纳旋钮翻成生产配置 diff
node tools/cfb-cycle.mjs status | simulate --p 0.7   # 看账 / 纯算术演练
```

自测：`test/closed-loop.selftest.mjs`（25 项）用 `CFB_CYCLE_DIR` 改道到临时目录，走完 plan → 合成报告 ingest → adopt → 下一轮 control 换新 → reject → propose，不碰真实轮次目录。

---

## 2. 候选生成：生产等价，不再贴补

`tools/helpers/candidates.mjs`

- **control** = 当前 champion 旋钮下的**生产重编译**（`compileV4Direct` 同一路径，与 `eval-plan` 的冻结 r2 同口径：1 900–3 200 字），不是原文前缀。
- **candidate** = control 上**只改一个杠杆**（一轮一个假设，否则 5 对数据分不出谁的功劳）。
- 杠杆表 `KNOBS`（每个都写明生产对应物 `production` / 落点 `kind` / 理论出处 `theory`）：

| 杠杆 | 取值 | kind | 生产对应物 | 理论 |
|---|---|---|---|---|
| `kItems` | on / **off** | program | `spliceProgramParts(verifyHints)` | S10.14 可推导的预见（红题 4.9→8.0 的来源） |
| `selection` | keepAll / balanced / strict | transform | 句级取舍（受保护句永不删） | 卷四 A2 v(i)=D·Pn·(1−R) 的句级代理 |
| `deadEnd` | paired / shelved / none | transform | 「已排除：」标签 | 卷五 P4 REFUTED/SHELVED |
| `closing` | on / off | program | 收工三问 | S10.18 |
| `layout` | state-first / conclusion-first | transform | 段落顺序（只移动不增删） | 卷三 |
| `bind` | on / off | config | `compressV4DirectBind` | v12.8.8 |

- **闸门**：长度包络（不超过生产成稿）、无发明标识符、三元组 `old_text/new_text` 保留；不过闸 ⇒ `infeasible`，不进计划。
- **退化如实标出**：文本与 control 相同 ⇒ `degenerate` + 原因。`bind=off` 在已自闭合的冻结 r2 稿上 **5/5 退化**（`bindFixBranches` 不动自闭合三元组）——它是惰性杠杆，不是 A/B；`doctor` 会报，`plan --lever bind=off` 会拒。
- **分句**：不切反引号内的 `?`/`。`（v12.8.8 的教训；`A5` 有回归）。
- **没有「长度」杠杆**（红线：不把稿子压更短）。

---

## 3. 奖励：从「评委 Likert」换成「任务真值 + live 结构分」

### 3.1 离线：6 个任务真值维（`tools/helpers/truth-dims.mjs`，零 API）

全部从冻结任务的 `chain / spec`（`transfer/mr/*.json`、`tools/effect-mr-specs.json`）可推，与 live 判据同源：

| 维 | 定义 | 同源 |
|---|---|---|
| `locusHit` | 上一轮 edit 的路径 + old_text/new_text 是否逐字在稿里 | 主模型一条 grep 能确认落地 |
| `nextDerivable` | spec `obs.red.next` 正则在稿里已预写为分支的比例 | live `next` |
| `deadEndsCarried` | 参考死路以**否定语境**提到的比例（前后窗口；`rm` 不匹配 `permission`） | — |
| `keyFactsCarried` | 参考关键事实的强记号出现比例 | — |
| `avoidLeak`↓ | avoid 正则以**非否定**语境命中（本轮自己的 edit 路径豁免） | live `avoid` |
| `claimRisk`↓ | `claimOfV3`：fixed=1、强宣称被守卫撤回=0.5、纯对冲=0 | live `falseDone` |

**它们只做三件事**：安全过滤（任一题 avoid/claim/locus 变差 ⇒ `offline-unsafe`，不花钱）、方向校验（五题生产稿 > 原文，与 v8 live 效应同向，`doctor` 5/5）、可用性（≥3 题有非退化候选）。**不做排序、不做奖励**——因为它们对多数候选的 Δ 是 0（见 `plan` 表），分不出高下，这是诚实的，不是缺陷。

### 3.2 付费：配对胜负

每对 = 同一题、同一 sample、两臂只有第 2 轮 reasoning 不同；结构分 `next + avoid − falseDone − bump − reEdit − repeat`（全部来自 `resultOf` claimVersion 3，与 v8 live 同一判据）。candidate > control 记胜、< 记负、= 记平（各记半）。

**评委维（6 个 llm 维）降级为诊断**：`judgeCapacity().selectionSignal === 'code'`；`cfb-judge capacity` 不再把 19.27 bit 说成「信息量」。

---

## 4. 实验经济学：每一对花多少钱、买到多少 bit

`tools/helpers/experiment.mjs`

- **先验** Beta(1,1)，胜 +1 α、负 +1 β、平各 +½。`pWin = P(p>0.5)`。
- **判定**（`DEFAULT_DESIGN`）：`pWin ≥ 0.95` adopt；`≤ 0.10` reject；累计 25 对未判 ⇒ `stop-undecided`（钱不再往这个假设上投）。
- **后验跨轮累积**：同一 `lever=value@champion` 的多轮配对合在一起算（5 对一轮，通常 2–3 轮出结论）。
- **信息账**：`expectedBitsNextPair`（先验下一对 ≈ 0.19 bit，越确定越便宜）、`bitsBought`、`usdPerBit`。`plan` 把这些连同 `reservedUsd / expectedUsd` 一起印出来再停。

### 4.1 运行特性（`simulate`，2000 次模拟，平局率 0.1，上限 25 对；种子固定、可复现）

| 真实胜率 p | adopt | reject | 未判即停 | 中位对数 |
|---|---|---|---|---|
| 0.3 | 1.2% | 85.9% | 13% | 8 |
| 0.4 | 4.1% | 57.6% | 38% | 16 |
| 0.5 | **12.7%** | 28.5% | 59% | 25 |
| 0.6 | 37.6% | 10.9% | 52% | 25 |
| 0.7 | 70.6% | 3.6% | 26% | 12 |
| 0.8 | 94.1% | 0.9% | 5% | 8 |
| 0.9 | 99.9% | 0.1% | 0.1% | 5 |

**读法**：这是一条**按预算塑形的决策规则，不是假设检验**。可选停止会抬高名义错误率；p=0.5 时有 12.7% 概率误采纳——我们接受它，因为误采纳的代价是一行配置回滚（`propose` 的 diff 可逆），而不是生产事故。想要更保守就把 `adoptAt` 提到 0.98：同样 2000 次模拟、上限 25 对，p=0.5 误采纳 12.7% → 5.8%，但 p=0.7 的采纳率 70.6% → 52.6%、中位对数 12 → 22——在几美元的预算里这是**用吞吐换保守**，默认不这么选。

### 4.2 钱

按 v8 收据口径（13 请求预占 0.648 USD、实付 ≈ 0.13）和用户给的价（输入 $1/M、输出 $4/M）：

| | 每轮（5 对 + 3 探针） | 一个假设出结论（中位） |
|---|---|---|
| 预占（账本锁上限） | ≈ USD 0.50 | — |
| 预计实付 | ≈ USD 0.13 | p=0.8：中位 8 对 = 2 轮 ≈ 0.26；p=0.7：12 对 = 3 轮 ≈ 0.39；p=0.5：25 对封顶 = 5 轮 ≈ 0.65 |
| 每 bit | ≈ USD 0.22（先验） | — |

几美元 = 大约 **10–20 轮 = 3–5 个假设出结论**。这就是这台机器在当前预算下的全部吞吐，文档里不写更多。

---

## 5. 预注册与账本（没有放松任何一条纪律）

- v9 计划 `cfb.bounded-ab/9`、scope `cfb.candidate-replay.2026-10-02.r1 … r20`（静态表，`KNOWN_API_SCOPES` 收录）、`APPROVED_API_LIMITS_V9 = {13 请求, USD 1, 主 10, 探针 3, 重试 0, 评委 0}`。
- `plan` 把假设、两臂全文、离线裁决、判定规则写进 `plan.json` 的 `preregistration`，摘要进 `evidenceDigest`；有收据后改稿 ⇒ 拒。
- `plan` 在已有收据的轮次上拒绝重开；`ingest` 拒绝重复回灌、拒绝往已判定假设上继续加数据。
- `propose` 只输出 diff / 说明，**从不写 `src/`**；`kind:'program'|'transform'` 的采纳给出落点与做法（`needsSrcChange`），由人改、再走 verify。
- 收据不追溯重打分：`ingest` 只读 `results[].rule`（已按计划的 claimVersion 冻结）。

---

## 6. 放弃了什么（以及为什么）

| 放弃 | 为什么 | 留了什么后路 |
|---|---|---|
| 评委 LLM 作为选择信号 | 未校准、每票要钱、与真实下一步无已证相关 | 维度与提示词都还在，`cfb-judge` 可单独诊断 |
| Likert 加权综合分 | 权重拍脑袋；加权求和把「可解释的失败」平均掉 | `compositeScore` 保留给诊断 |
| 大样本 / 名义错误率保证 | 几美元买不到 n=50；序贯 + 可选停止换吞吐 | §4.1 的运行特性如实列出 |
| 每轮多杠杆 / 全因子设计 | 5 对分不出两个因素的功劳 | 一轮一个假设；后验跨轮累积 |
| LoRA / 自托管训练 | 本机无 GPU、无 torch；旧训练路径保留但不在本环里 | `docs/RUNBOOK-TRAINING-READY.md` 原样 |
| 版面类杠杆作为付费轮 | 理论效应小；离线 Δ=0 | 仍在杠杆表，排在最后，`--lever` 可强制 |
| 以原文为 base 的候选 | 原文不过生产闸门（长度/三元组），不是生产会发出的东西 | raw 只做方向校验的对照 |
| 每轮评委票 / 自动重试 | 直接花钱且不进判据 | `judges 0 / retries 0` 写进限额 |
| `length` 杠杆 | 红线：不把稿子压更短 | 不会再加 |
| `bind` 杠杆作为假设 | 冻结语料上 5/5 退化（惰性） | 换语料后可能复活；`doctor` 会报 |
| 泛化声明 | 轮次复用同 5 道冻结任务（模型随机性下的重复观测）；p 的含义是「在这些题的回放上 candidate 更好的概率」 | 换语料 = 新 champion 摘要 = 新假设键 |

---

## 7. 怎么加杠杆（下一个模型照做）

1. 在 `candidates.mjs` 的 `KNOBS` 加一项：`values`（第一项必须是生产现状）、`kind`、`production`、`theory`；`BASELINE_KNOBS` 加默认值；`LEVER_ORDER` 按理论效应排位。
2. 在 `renderCandidate` 加它的变换；变换必须**生产等价**（生产能做出一模一样的文本），否则 `propose` 给不出落点。
3. 跑 `node tools/cfb-cycle.mjs doctor`：看「可用 ≥3 题」与「退化」；退化 ≥3 题就不是杠杆，别浪费钱。
4. `test/closed-loop.selftest.mjs` A4 加它的语义断言，`node verify.mjs` 全绿、`node manifest.mjs`。
5. 然后才 `plan --lever k=v`。

---

## 8. 没做 / 没证的

- **一分钱没花**：v9 一轮都没实跑；§4 的钱是按 v8 收据口径与用户给的价推算的。
- `nextDerivable` 等维依赖 `effect-mr-specs.json` 的正则；spec 不完整的题给 `null`（降 coverage），不猜。
- `claimOfV3` 把「三件都拿到之前不能说修复完成」判成 fixed（否定词不在前 10 字末尾）——这是冻结判据的已知边界，**不改**（收据不追溯）；生产稿不用这种句式。
- 环路只覆盖 reasoning 回放协议（生产真实路径）；可见协议 v3–v7 不再测。
- Node 20 沙盒跑不了 live（`runtime-node` 门槛）；plan / ingest / propose / 自测都不受影响。
