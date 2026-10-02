# DSH 合并：把宿主层干预接进 cfb 的训练器（v14.13）

> 结论先行：**DSH 的方向 × cfb 的方法。** DSH 在宿主层碰对了杠杆（工具面、事件门禁、用户态近场注入、外部裁判），但从没做过对照；cfb 有预注册 / 影子分叉 / 留出 / 回执的全套方法，却拿去量了一个不动结局的东西（稿）。合并 = 把 DSH 的干预做成 cfb 轨迹器里的**可控变量与臂**，只有在训练器里赢过对照的东西才准进生产预设。压缩器降级为成本开关，不再是训练对象。

## 1. 为什么合并（证据）

**cfb 侧（t6–t9 + 29 条历史轨迹）**：稿对结局 ≈ 0 是构造上必然的 —— 忠实的稿只能保住模型已经做出的决定（I2 / G2 不发明），而 flash 在 ≤8 轮里不忘（重复命令 0、矛盾 0）；稿的可测效应是把下一轮思考吹大（v4d7 ×1.3–1.6，t9 ×4.8），改变的是「想多少」不是「决定什么」。t8 手写稿写「别找了，改」，模型不理。

**DSH 侧（docs/reference/dsh/SESSION-NOTES.md）**：🟢 工具面 91 → 98/99；🟢 门禁 GATE1×2 / GATE2×3 全触发全服从；🟢 用户态一句话 ≫ 注入引导；🔴 12 法则增益无对照。

**把两边放在一起冒出来的发现：通道决定服从度。** 同一个 flash，同样意思的话 —— 放进助手态思维链槽位（稿）它当「自己以前想过的」，不理；放进用户态近场消息（门禁）它照做。另外核对 cfb 轨迹器本身：系统提示是中文的「可用工具 bash / read_file / edit_file……**一次可以发多个独立调用**」、工具是自定义 schema、历史里工具调用被压平成「[tool: …]」文本 —— 既不是 RL 原生工具面，又明文鼓励 Overthinking 论文里的 Rogue Actions（t9 一轮 4–6 个调用），而且这三样从未当过变量。

文献对照（2026-10-02 检索）：ACE（brevity bias / context collapse：上下文该丰富不该压缩）、ReasoningBank（从失败蒸馏策略 46.5→49.7）、Training-Free GRPO（冻结 DeepSeek-V3.1 经验库 +4.6）、Overthinking（k=2 选低过度思考 +30% / −43% 成本）、Thinking vs. Doing（提示「再想再做一次」23→28%）、OpenHands / JetBrains（摘要历史 54 vs 53：压缩 = 成本不 = 结局）。

## 2. 搬了什么（已落地，零 API）

| 项 | 来源 | 落点 | 说明 |
|---|---|---|---|
| **P1 工具面** `--aci rl-native` | DSH B 版预设 + 官方 npm 包 | `tools/helpers/aci.mjs`，`docs/reference/dsh-tools/`（BSD-3-Clause 原文件） | 系统提示只有 `You are a helpful software engineer assistant.`；工具 = bash + str_replace_editor，name / description / parameters **逐字**取自 `@deepseek-ai/dsh-tool-bash@0.1.0-rc.6`、`@deepseek-ai/dsh-tool-str-replace-editor@0.1.0-rc.6`（bash 取无后台无升级形态）。str_replace_editor 的 view / create / str_replace / insert 语义与回文照官方包；路径 `/home/u/work/repo/…` 双向映射到假仓库；bash 非零退出带 `[exit code: N]`。暂只支持 raw / drop / gate / ledger 臂（压缩臂的稿用 edit_file 规范词，换面要先接 compile-v4 的宿主工具映射）。 |
| **P1b 协议** `--tool-protocol native` | 官方 harness 的消息形态 | `tools/traj-run.mjs` | 历史里 assistant 带 `tool_calls`、结果是 `role:tool`（id 成对）；旧 `text` 形态保留为缺省。两者正交 ⇒ 2×2 可做部分因子。 |
| **P2 门禁** 臂 `gate` | DSH v4.3 GATE_SMOKE / GATE_BATCH 的一般化 | `tools/helpers/host-gates.mjs` | 三条规则只看宿主能算的事实：act（读过 src + 同一诊断/验证命令 ≥2 + 0 修改 + 最近两轮只读 + 第 ≥3 轮 ⇒ 做一次可逆修改并验证）、batch（连续两轮修改无验证 ⇒ 合并写入）、verify（宣称修好但最后修改后没验证 ⇒ 不收最终回复，先验证）。注入 = user 角色、紧贴最新工具结果（文本协议附在结果消息末尾；原生协议作为 tool 消息后的一条 user 消息），带「这不是用户输入」标记（DSH GUIDE_HEAD 的做法）。幂等：同轮一次、act 两轮内不重复、verify 整条一次。第一次触发那轮起与 raw 影子分歧。**v14.13.1**：act 的触发签名按 29 条真实轨迹回放改写（验证跑过后只看不改 ≥4 调用、第 ≥4 轮），第一版零触发（见 SUMMARY-2026-10-02 §二 #1）。 |
| **对照** 臂 `drop` | 用户的问题「去掉思维链的干扰」+ DeepSeek 官方 API 默认形态 | `tools/traj-run.mjs` | 历史里不带任何 reasoning_content。cfb 从未跑过这个对照；若 drop ≥ raw，「压缩」问题整个消失。 |
| **P4 仪器** | DSH `scan-format.mjs`（stopReason） | transcript 记 `finish`；预检记形态 | 之前连长度截断都无法回查。形态预检：native / drop 各发一次 max_tokens:1，通道不收 role:tool 或不带思维链的历史 ⇒ 一条轨迹都不开。 |
| **判分** | — | `tools/effect-mr.mjs` claimOf | rl-native 面下模型常用英文收尾 ⇒ 英文宣称 / 否定 / 对冲也认（中文部分一字未动；旧收据不重判）。 |
| 预注册 | — | `cfb-cycle plan-traj --aci … --tool-protocol …` | 面与协议进计划与设计摘要，traj-run 核对；drop 按「第 2 轮起分歧」计费。 |

**没搬**：Three.js / CDP / inspect-scene；visual / solve 因果流；神鬼二元与相变分带（上游已勘误）；384K maxTokens（本通道不是问题，要的是记 finish）；j-space；工具晋升（只有 2–3 个工具）；认知解耦（无证据）；RL_GUIDE 全文整体注入（先当种子，见 §4）。

## 3. 第一组单元（预注册后再花钱；每对写死预测与作废条件）

| 顺序 | 计划 | 问的问题 | 预测 | 作废条件 | 费用（期望） |
|---|---|---|---|---|---|
| ① | `plan-traj --arms raw --scenarios perf-regression --max-rounds 8 --aci rl-native --tool-protocol native` | 官方工具面下 flash 在 perf 上会不会落子（与 t8/t9 的 cfb 面 raw ✗ 对照） | 若工具面是主因：edit ≥1；否则 0 edit 同前 | 预检形态 ✗ ⇒ 不跑；跑完 0 edit ⇒ 工具面不是 perf 的主因，但仍可作后续基线 | ≈ $0.10 |
| ② | `plan-traj --arms raw,drop --scenarios <家族> --max-rounds 5`（与 ① 同面） | 历史思维链是干扰、无关、还是必需 | drop 与 raw 修好率同、drop 更便宜 | drop 显著更差 ⇒ 思维链携带有价值，压缩器的成本目标成立 | ≈ $0.11 |
| ③ | `plan-traj --arms raw,gate --scenarios perf-regression --max-rounds 8`（可验证版 perf 做好后换它） | 用户态近场门禁能不能把「找证据」变成「改并验证」 | act 门禁触发后 2 轮内出现 edit；verify 门禁把假宣称率压到 0 | 门禁触发而 0 edit ⇒ 通道假说作废，杠杆只剩模型 | ≈ $0.16 |

跑的顺序理由：① 决定后面所有对照的基线面；② 决定「压缩」这条线是关掉还是降级成成本开关；③ 是 DSH 核心机制在 bugfix 上的第一次对照。三者都用留出家族前先在 perf / eacces 上过一遍，再上 wrong-model[h]。

## 4. 下一步（未做，等 ①–③ 读数）

- **可验证版 perf**：现 perf-regression 的三文件假仓库没有把 `compressTargetMax` 接进任何代码，flash 两臂都在找「哪个旋钮真的接线了」——先加一个真的用这个旋钮的 `src/prompt.js`（新 id，不改写历史），再跑 raw 一次。
- **手册臂 `guide`**：ACE 式 delta 条目 + helpful/harmful 计数，以 DSH `DETAIL_GUIDE.exec` 与排错因果顺序为种子，从 t8/t9/traj 的失败里提炼；只写顺序与因果、<250 字、user 角色近场、每轮最多一次。只在 gate 之上测增量。与红线「不加第 N 条 K 规则」的关系：那条禁的是往**压缩器**提示词里堆规则刷评委分；手册是给**主模型**、按结局判、带计数、留出家族上验的另一种对象 —— 仍需用户认可。
- **plan-first 任务提示词**（DSH 最强单一效应）：bugfix 上必须测，Overthinking 论文警告它可能加重分析瘫痪。
- **过度思考分**：先零 API 在现有 30+ 条轨迹上算（每次调用思考字数、同轮连发动作数、证据齐后的探测数），看是否像论文那样预测失败。
