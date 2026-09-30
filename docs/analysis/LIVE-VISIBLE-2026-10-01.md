# 首次真实通道验证与可见上下文 A/B（2026-10-01，scope v2→v4 全记录）

## 0. 一句话

**通道被证明丢弃全部历史 reasoning（canary 证伪），据此把实验换成生产等价的"可见压缩稿 vs 思考已丢"对照；v4 全链 13/13 成功、12/12 配对完整，这是本项目第一次拿到经过完整可信性闸的真实模型对照数据。** 实际消费约 USD 0.05（另有约 0.05 的作废预留与诊断），远低于 USD 2 授权。

## 1. 授权与费用台账（全部收据在 transfer/api-budget-approval*.watermark.json）

| scope | 结果 | 预留 | 结局 |
|---|---|---|---|
| v1 `minimal-api-approval.2026-09-30`（旧批准） | 探针 request-network-error | $0.0051 | 按 v1 语义永久停机，收据封存 |
| v2 `bounded-api-approval.2026-10-01` | 探针 channel-fingerprint（后端=vllm 自报指纹，非官方） | $0.0051 | 可信性全停，收据封存 |
| v3 `visible-context-approval.2026-10-01` | 探针 accepted（通道首次验证）＋1 主 accepted＋1 主 response-incomplete | $0.0373 | 旧语义全停，收据封存 |
| v4 `visible-context-approval.2026-10-01-r2` | **13/13 accepted，complete** | $0.2431（实际 usage 合计 ≈$0.05） | 正常完成 |
| 账外诊断（归因用，共 9 次微型调用） | 2 次 canary 复核＋5 别名扫描＋2 内容复核 | ≈$0.006 | 已在本文与提交信息公开 |

用户授权原文（2026-10-01）："密钥我给你……用api去真实跑优化！……测试等api不要调用太多，我没多少钱。" 每个 scope 一份冻结批准；失败不退款、不重发、收据不删。

## 2. 通道取证（为什么旧协议必须换）

1. v2 探针被 `channel-fingerprint` 拦截：响应指纹为 `vllm-0.0.0-tp4-dp2-ep-869f52fc`（三次实测一致），不是曾验证过的 `fp_dspure_app_v1`。
2. 两次 canary 复核：`prompt_tokens=66`（≈仅可见文本），模型 thinking 烧满 512 输出、无法回显标记 → **reasoning_content 在到达模型前被剥离**。
3. 五别名扫描（v4-flash / V4-Flash-0731 / v4-flash-0731 / v4.1-flash-expires / v4-pro）：无一具备 `fp_dspure_app_v1`；两个 pTok 计费包含 reasoning 字节的路由，模型仍明说"对话历史里只有两条可见消息，没有标记内容" → **该中转当前所有路由都丢弃历史 reasoning**，`chat-completions-history-reasoning/1` 协议物理不可用。
4. 结论：指纹闸把损失控制在 $0.0051，避免了在 raw 臂被静默剥离的情况下花 $0.30 产出伪对照。

## 3. 协议替换的论证（v3/v4 = 生产等价问题）

今天生产通道的现实就是"思考会丢"。因此把对照换成：

- **raw 臂** = 只有可见消息（思考已丢、没有 cfb 的现实）；
- **current 臂** = 可见消息 + 压缩稿以冻结定界符 `【前情压缩稿】…【/前情压缩稿】` 可见拼接（birth 的真实形态）。

审计强制：全部消息零 reasoning_content；canary 只在探针单条可见 assistant 消息；current 臂 = 稿块前缀 + raw 臂逐字节一致；其余闸（型号精确、usage 越界、工具 JSON、预算双平面预占、不退款、不重发、评委 0、重试 0）一条不松。新增：网络类失败预算 3（v2 起）、length 截断样本级预算 3（v4）。

**预注册（写在计划里）**：current 相对 raw 应降 falseDone/repeat、升 next/avoid，flaky 差异最大；raw 反超即先归因不庆祝；wrong-model/eacces 近似不变。

## 4. 结果（v4，n=2/格，judge=0，全部确定性规则判定）

| 任务 | 臂 | falseDone | bump | reEdit | repeat | next | avoid | 动作 |
|---|---|---|---|---|---|---|---|---|
| flaky-timeout | raw | 0 | 0 | 0 | 0 | 1/2 | 2/2 | grep, bash-other |
| flaky-timeout | current | **1**⚠ | 0 | 0 | 0 | 1/2 | 2/2 | reread, **instrument** |
| wrong-model | raw | **1** | 0 | 0 | 0 | 2/2 | 2/2 | grep, grep |
| wrong-model | current | 0 | 0 | 0 | 0 | 2/2 | 2/2 | text, grep |
| eacces-config | raw | 0 | 0 | 0 | 0 | 2/2 | 2/2 | grep, grep |
| eacces-config | current | 0 | 0 | 0 | 0 | 2/2 | 2/2 | grep, grep |

预注册符合度：eacces 持平 ✓；wrong-model current 消除 1 例假完成（方向正）✓；flaky 名义上 raw 反超 1 项 falseDone ⚠ → 按纪律先归因（§5）。

## 5. 归因与测量效度发现（本轮最有价值的产出之一）

1. **flaky|current|0 的 falseDone=1 是 CLAIM_RE 正则误判**：命中片段为"……（主请求**完成**→`primarySettled` 置位）在阈值触发时根本没……"——"主请求完成"是被等待事件的名词短语，且整句意为"该事件根本没发生"。该样本实际行为：1 次工具调用 + 半衰期级插桩诊断，质量良好。
2. **结构性度量偏差**：本协议下 raw 臂回复正文长度为 0（纯工具调用），物理上不可能触发文本类指标（falseDone/hedge）；current 臂边做边解释，独自暴露在正则误判面前。任何文本正则指标在两臂间不对称。
3. 敏感性分析（非主结果）：若排除"请求完成/事件完成→"类名词短语误配，则 flaky falseDone 为 0:0，三题主指标 current ≥ raw 全面成立。**本轮主结果仍按原判据记录**；正则修正作为下一轮预注册改进，不事后改分。
4. 定性：flaky 的 current 臂动作（reread+instrument）恰是手写 oracle 路线（插桩），raw 臂是 grep+bash-other。

## 6. 限制（不许拿本文冒充的东西）

- n=2/格、3 个已知 canned red 开发题：**不是独立泛化，不是 run4 Likert 分数的可比延续**（协议已换）。
- vllm 指纹是中转自报值，只作连续性锚；后端供应商内部实现未证明。
- "raw 臂=思考已丢"只代表**这一类通道**的生产现实；在保留 reasoning 的通道上结论不可搬运。
- 实际账单以服务商为准；本地账本是可信价表下的保守上界。

## 7. 下一步（需要新批准的都列明）

1. **零成本**：修 CLAIM_RE 名词短语误配（带回归样例），进入下一轮预注册。
2. **零成本**：把 v2–v4 的三级容错（网络/截断/可信性分层）写进训练/评测手册。
3. **待批准**：扩样本（n≥6/格）复跑 v4 矩阵（估 ≈$0.75/轮，13–15 请求×3）；或对"draft-vs-raw-visible 双可见"第二对照（P-B）开新 scope。
4. **待批准**：把可见拼接协议接入生产 birth 路径的实测（当前生产路径未动）。
