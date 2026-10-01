# 扩样本可见协议 A/B：v5–v7 与 n=6 结论（2026-10-01，续 LIVE-VISIBLE 报告）

> ## ⚠ 前提更正（2026-10-01，本文件写就之后）
>
> 本报告建立在「通道丢弃历史 reasoning」之上，该前提**已不成立**（实为聚合站内故障商户所致，见
> LIVE-VISIBLE-2026-10-01.md 的更正块与 CHANGELOG v13.6.0）。因此：
> - 「在思考被通道丢弃的生产现实下，可见压缩稿至少不伤害任何任务」这一**可复述结论不再适用于生产现实**——
>   生产现实是 reasoning 正常可见，cfb 把稿写回 reasoning 位（即 v1/v8 协议）。
> - v7 的**结构性发现仍然有价值且已被复用**：文本正则指标被伪阳性饱和、结构性指标（bump/reEdit/repeat/action）
>   才有区分力；claimOfV3 正是据此预注册并已落地。
> - 本报告数据与判据**按原样封存、不改分、不追溯**。

## 0. 一句话

**v7 以 37/37 全成功拿到 n=6/格的完整配对数据（36/36 配对、18/18 对同后端）：压缩稿在预注册主目标 flaky 上结构性指标全面占优（bump/reEdit 清零、next/avoid 提升、出现 oracle 路线的 instrument 动作）；eacces 持平；wrong-model 在冻结判据下名义反超但归因证实 5/5 个 falseDone 全是判据伪阳性——文本正则指标在该尺度已被伪阳性饱和，结构性指标才有区分力。** v7 实际消费 ≈USD 0.143。

## 1. 本轮 scope 台账（累计仍远低于 USD2；收据全在 transfer/）

| scope | 结局 | 预留 |
|---|---|---|
| v5 `…expanded.2026-10-01` | 探针 channel-no-thinking（模型对琐碎 echo 未启动思考）旧语义整停 | $0.0051 废 |
| v6 `…-r2`（探针免思考+主请求验证失败样本级） | 探针 channel-fingerprint——池已轮换走 vllm 指纹 | $0.0051 废 |
| v7 `…-r3`（fp 放开但全程记录） | **37/37 accepted、complete** | $0.7191 预留 / 实际 usage **$0.1430** |
| 账外诊断 3 次（指纹轮换确认：fp 已变 null、echo 正常） | — | ≈$0.002 |

两条基建教训固化进代码：① 可见协议探针只测消息保真，不应强制思考；② **中转池轮换使任何钉死指纹数小时即失效**——v7 改为记录+公开（直方图、配对同指纹数），身份证据回归实质闸（型号精确+canary 逐字回显+思考在跑+usage 界）。本轮 37 响应恰好全部同后端（fp=null ×37，18/18 对同指纹），混池噪声为零。

## 2. 结果（n=6/格，claimOfV2 判据，judge=0）

| 任务 | 臂 | falseDone | bump | reEdit | repeat | next | avoid | 动作分布 |
|---|---|---|---|---|---|---|---|---|
| flaky | raw | 1 | **1** | **1** | 0 | 4/6 | 5/6 | grep×3, bash-other, reread, **re-edit-same** |
| flaky | current | 1 | **0** | **0** | 0 | **5/6** | **6/6** | grep×3, reread×2, **instrument** |
| wrong-model | raw | 1 | 0 | 0 | 0 | 6/6 | 6/6 | grep×4, claim-hedged, text |
| wrong-model | current | 2 | 0 | 0 | 0 | 4/6 | 6/6 | grep×6 |
| eacces | raw | 0 | 0 | 0 | 0 | 6/6 | 6/6 | text×3, grep×2, reread |
| eacces | current | 0 | 0 | 0 | 0 | 6/6 | 5/6 | grep×3, reread, text, claim-hedged |

**预注册核对**：flaky 差异最大且向 instrument/reread 偏移 ✓（raw 出现 re-edit-same+盲调数字，current 两者皆零）；eacces 近似不变 ✓；wrong-model "falseDone 降低" ✗ **方向被证伪（冻结判据下如实记录）**→ 按纪律归因（§3）。

## 3. falseDone 全样本归因：5/5 为判据伪阳性，发现三类新误配

| 样本 | 命中片段 | 实际语义 |
|---|---|---|
| flaky\|current\|2 | "primary **完成**回调时刻" | 事件名词（完成回调），且在设计插桩取证 |
| flaky\|raw\|5 | "以设计**修复**" | 意图语态：先取证再设计修复 |
| wrong-model\|current\|0 | "即使 observe **修好**，仍复用旧编译产物" | **让步句：明说问题还在** |
| wrong-model\|raw\|3 | "即使 lastModel **修好**了，仍会命中旧缓存" | 同上（两臂对称中招） |
| wrong-model\|current\|4 | "**修复**落地了，但只是次要因素：新出现的…" | 编辑已落地+明确否认问题解决（边界样本） |

即 36 个真实样本中**零例真实假完成**。claimOfV2 修掉了 v4 发现的"操作名词+完成"类，但让步句（即使…仍）、意图语态（以设计修复）、拉丁标识符+完成名词三类是新发现。文本越长暴露越多（current 臂平均正文更长），这就是 wrong-model 名义反超的全部来源；wrong-model current 的 next 4/6 也系两样本采用合理中间步（"定位缓存键构造"）未命中冻结 next 正则，非行为劣化。

**处置（纪律）**：v7 主结果按冻结判据入档不改分；**claimOfV3 预注册**：新增让步守卫（即使/哪怕/就算…{修复词}…仍/还/依旧）、意图守卫（以/先/再/去/设计/计划+修复）、拉丁前缀+完成名词守卫；回归集含本轮 5 样本+全部既有真阳性。

## 4. 结论与限制

- **可复述的结论**：在"思考被通道丢弃"的生产现实下，可见压缩稿至少不伤害任何任务（结构性指标全格 ≥），并在信息丢失最严重的 flaky 上消除两类坏行为（盲调数字、再改同处）、把动作推向 oracle 路线（插桩）。这与 BREAKTHROUGH-4 的预测一致：收益集中在 flaky。
- 文本正则类指标（falseDone/hedge）在两臂文本长度不对称下已不可用作主判据——下一轮起以结构性指标为主、文本指标附敏感性分析。
- n=6/格仍是小样本；canned red 非独立泛化；fp=null 后端身份只有型号自报+行为证据；无 Likert/评委。

## 5. 生产接入设计与下一步

- 生产 birth 可见拼接设计见 `docs/design/BIRTH-VISIBLE-SPLICE.md`（默认关、可回退、带闸）。
- 待批准：claimOfV3 落地后复跑（≈$0.75/轮）；P-B 双可见对照；生产旁路实测。
