# 路线 2026-10-11 结果报告（计划 A：raw vs hand，dev/holdout 已预注册）

预注册：`PREREG.md`（sha256 见 `PREREG.sha256`）。稿件哈希：`DRAFTS.sha256`。轨迹：`.cfb-runtime/traj/t127/`（results.jsonl、receipt.json、drafts/、hand-samples.jsonl）。

## 0. 结论先行
1. **金标入库：0 条。** 三条按预注册判定为"好"的手写稿（eacces-config-s0、sse-truncated-s0、wrong-model-s0）被项目现有的**上限闸**（C2 闭合判读三元组、C3 可执行验收）拒收。按项目规则它们不是金标。
2. **尺子：排除。** dev 上 5 条带稿样本，R1 无分离，按 0.5 通过率门槛不过（0/5）。没有任何可以报告的"已验证尺子"。
3. **效果：手写稿没有显示优于 raw。** 修好率 hand 4/10，raw 6/10；修好后验收通过 hand 3/10，raw 3/10。n=10，无法检验非劣效（边界 −0.10）。
4. **花费（已对账，2026-10-11 第三轮）**：计划 A 约 **$2.11**；计划 B 约 **$2.15**（receipt：82 主调用 + 7 压缩 + 1 预检）；计划 C 约 **$1.77**，**已停止未完成**（见 §9）。累计约 **$6.0**，上限 $10。注意：v1 预注册规定"计划 A 花费 ≤ $2.0 才跑 B"，A 实际 $2.11 越过了它；B 随后由 PREREG-v2 批准（上限 $10）后才运行。另外，我在读取 B 的回执之前就启动了 C，违反了我自己设定的顺序，这一点在 §9 如实记录。
5. **副作用已撤销**：`cfb-cycle ceiling --plan 127` 误写了 5 条飞轮偏好对（违反 D6 暂停）和 45 行效度账本，已全部撤销并隔离（见 §6）。

## 1. 设计（实际执行）
- 场景：5 个家族 × 2 样本 = 10 组；臂 raw 与 hand；最多 6 轮（PLAN-SIMPLE 定义为 10 轮，**偏离**，预算原因）。
- 数据划分：dev = eacces-config、sse-truncated、flaky-timeout；holdout = perf-regression、wrong-model（只报告，未用于选择）。
- 手写稿：由助手（我）写，只看 raw+ctx，经 traj-run 的生产闸链（G1、G2、birthAccept）检查。

## 2. 轨迹结果（计划 A，20 条）
| 家族 | 样本 | 臂 | 修好 | 修好轮 | 修好后验收 | 声明相称 | 分歧轮 |
|---|---|---|---|---|---|---|---|
| eacces-config (dev) | 0 | raw | ✓ | 6 | ✗ | ✓ | – |
| eacces-config (dev) | 0 | hand | ✓ | 6 | ✓ | ✓ | 5 |
| eacces-config (dev) | 1 | raw | ✗ | – | – | ✓ | – |
| eacces-config (dev) | 1 | hand | ✗ | – | – | ✓ | 未分歧 |
| flaky-timeout (dev) | 0 | raw | ✓ | 6 | ✗ | ✓ | – |
| flaky-timeout (dev) | 0 | hand | ✗ | – | – | ✓ | 3 |
| flaky-timeout (dev) | 1 | raw | ✗ | – | – | ✓ | – |
| flaky-timeout (dev) | 1 | hand | ✗ | – | – | ✓ | 3 |
| sse-truncated (dev) | 0 | raw | ✓ | 5 | ✓ | ✓ | – |
| sse-truncated (dev) | 0 | hand | ✓ | 5 | ✓ | ✓ | 4 |
| sse-truncated (dev) | 1 | raw | ✓ | 5 | ✓ | ✓ | – |
| sse-truncated (dev) | 1 | hand | ✓ | 6 | ✗ | ✓ | 3 |
| perf-regression (hold) | 0 | raw | ✗ | – | – | ✓ | – |
| perf-regression (hold) | 0 | hand | ✗ | – | – | ✓ | 5 |
| perf-regression (hold) | 1 | raw | ✗ | – | – | ✓ | – |
| perf-regression (hold) | 1 | hand | ✗ | – | – | ✓ | 未分歧 |
| wrong-model (hold) | 0 | raw | ✓ | 4 | ✓ | ✓ | – |
| wrong-model (hold) | 0 | hand | ✓ | 4 | ✓ | ✓ | 4 |
| wrong-model (hold) | 1 | raw | ✓ | 6 | ✓ | ✓ | – |
| wrong-model (hold) | 1 | hand | ✗ | – | – | ✓ | 5 |

汇总（20 条）：修好率 raw 6/10，hand 4/10；修好后验收 raw 3/10，hand 3/10（分母为修好的条目：raw 3/6，hand 3/4）。声明相称：全部。假宣称（程序 falseClaim）：0。
- 注意：hand 的 token 数只统计分歧之后的真实调用（影子轮复用 raw 的响应），**不能与 raw 的总 token 直接比较**。
- 注意：eacces-s1 与 perf-s1 两条 hand 轨迹未触发压缩（原文未过地板），按预注册计为与 raw 平手，**不是证据**。

## 3. 金标判定（预注册 §3）与上限闸
按 §3 规则（修好 ∧ 验收通过 ∧ 声明有依据 ∧ 修好轮数 ≤ 同场景 raw 均值）：
- 判为"好"：eacces-s0（修好@6，raw 均值 6 轮）、sse-s0（修好@5，raw 均值 5）、wrong-s0（修好@4，raw 均值 5）。
- 不算好：sse-s1（修好但验收未过；gold 构建器判为比 raw 慢的 loss）；其余未修好。
- `gold add --plan 127`：候选 10 条，**收入 0 条**。跳过原因：
  - eacces-s0-r5、sse-s0-r4、wrong-s0-r4：上限闸（v14.22.0）C2（稿里没有「读数 ⇒ 结论」/「如果…就…」闭合判读）与 C3（验收段没有「跑哪条命令、看到什么读数即算完」）不过。
  - flaky ×2、perf-s0、wrong-s1：主模型读后未修好。
  - sse-s1-r3：比 raw 慢（vsRaw loss）。
  - wrong-s0-r5、sse-s1-r4：构建器的重复项（无 pending 文件），不是独立的稿。
- **解读**：三条"好"的稿恰好是缺 C2/C3 的稿。hand 协议（给副模型的 prompt）没有要求 C2/C3，而金标闸要求。这是 hand 协议与金标闸之间的**不一致**，是本次最有价值的发现之一。我不在事后改稿（会破坏冻结与预注册）。下一轮若要做金标，应先在协议里加入 C2/C3，并重新预注册。

## 4. 尺子（dev only，预注册 §4）
| 样本 | 标签 | R1 | G2 凭空标识符 | G3 压缩比 | F4 稿长 | F5 死路标记 |
|---|---|---|---|---|---|---|
| eacces-s0-r5 | 好 | 0.080 | 0 | 0.344 | 567 | 0 |
| sse-s0-r4 | 好 | 0.086 | 0 | 0.140 | 993 | 0 |
| sse-s1-r3 | 不好 | 0.172 | 0 | 0.260 | 907 | 0 |
| flaky-s0-r3 | 不好 | 0.067 | 0 | 0.047 | 531 | 0 |
| flaky-s1-r3 | 不好 | 0.000 | 0 | 0.027 | 531 | 0 |

- R1 通过率（阈值 0.8）：0/5。按预注册的 0.5 门槛：**不过，排除**。
- 分离：好的两条 R1 为 0.08 与 0.09，不好的三条为 0.17、0.07、0.00。**无分离**，最高的反而是不好的样本。
- G2 与 F5 全部为 0，无法区分；G3 样本太少，不可信。
- 结论：**没有可用尺子**。这与 ruler v2（dev 匹配通过率 0.063，excluded）一致。holdout 未计算，符合预注册。

## 5. 对 Layer B 问题的回答（有限）
- **为什么金标稿的字面事实保留低而效果好？** 本次无法回答：没有足够的金标，也没有其他压缩形式作对照（计划 B 未跑）。
- **为什么金标形式胜过其他压缩形式？** 本次无法检验：计划 B 未运行。
- **为什么设计稿表现差？** 本次没有"设计稿"臂，无法回答。
- **模型怎么看每份稿？** 只读了部分推理链，未系统编码。观察：flaky 样本的推理链怀疑是计时竞争（未经复现）；sse 样本的推理链注意到 [DONE] 被当成完成信号（未经核实）；wrong-model 样本的推理链怀疑 observe 忽略了 n 参数（未经运行确认）。这些都是**假设**，不是结论。

## 6. 副作用与撤销（重要）
- `cfb-cycle ceiling --plan 127` 的 `--plan` 作用域会合并历史计划（显示 n=29/26），并自动写：
  - 飞轮偏好对 +5 → `.cfb-offline/train/pairs.jsonl`（违反 D6 暂停）。**已清空**。
  - 效度账本 +45 → `.cfb-offline/ruler/validity.jsonl`。**已删除这 45 行**，与 HEAD 完全一致（304 行）。
  - `ceiling-13.json`（混合历史计划）。**已移出**。
  - 三份均保存在 `archive-2026-10-11/reverted-ceiling-t127/`，不是训练数据。
- 之后的 `gold add` 没有写飞轮（已读代码确认），`gold` 也只写入 0 条。
- 教训：以后 `ceiling` 只用 `--single` 与 `--map`，先 `--dry` 确认。

## 7. 偏离与局限（必须看）
1. 6 轮而非 10 轮（预算）。
2. 花费 $2.1 是按 relay 定价重算的估算，未经账单核实。
3. 计划 B 未跑（预注册门槛）。
4. 手写稿由我写，不是盲的。预注册要求"开跑前冻结哈希"，实际上哈希是在写稿、修改、运行后才计算的（`DRAFTS.sha256`）。修改包括：两份稿因闸拒而重写（wrong-s0、sse-s1，初版保存在 `hand-samples.jsonl`）；四处引文修正（把不在本样本输入中的引文改为转述）。修改发生在对应轨迹结局出现之前，但仍属偏离。
5. flaky-s0 与 flaky-s1 的输入完全相同，因此稿件内容相同。
6. "无幻觉"只用程序 falseClaim 标志，没有做逐句人工审计。
7. "修好后验收 ≤ 2 次"未计算。
8. D5 的 5 条抽查**未做**，需要用户或另一位审阅者完成（待定）。
9. 没有做 holdout 认证（D2 / 步骤 3），不在授权范围内。
10. 过程指标（复制率、动作依从、重探索、矛盾标记、排除路线复活）只做了原始统计，未系统编码。

## 8. 需要你决定的下一步（第三轮更新，累计约 $6.0，上限 $10）
- **选项 A（推荐）**：续跑计划 C（同一条命令，状态已存盘）。5 份 v2 手写稿已写好并哈希（`DRAFTS-v2.sha256`），剩余约 6 条轨迹，估计再花约 $0.5–0.8，总计约 $6.6–6.8。**这会越过我自己设的 $6.5 内部储备线**（不是你设的上限），所以需要你明确同意。
- **选项 B**：停在这里。计划 C 保留为部分结果（不纳入结论），剩余预算留作将来用途。
- 计划 B 的设计问题（§9.2）：9/10 的 auto 轨迹从未过 3100 字符地板，因此 auto 与 raw 几乎是同一条路径。要回答"生产压缩器是否有用"，需要更长的 fixture，这要另行设计与批准，不在本轮预算内。
- 无论选哪个，都不做 holdout 认证（需要单独批准，约 $7）。

## 9. 第三轮：计划 B 结果、计划 C 停止、花费对账

### 9.1 花费对账（按真实 token + 请求费 $0.02，单价见 `.cfb-runtime/pricing.a6api.json`）
| 计划 | 请求数 | 真实花费 | 备注 |
|---|---|---|---|
| A（t127） | — | ≈ $2.11 | 见 §2 |
| B（t128，raw vs policy:base） | 82 主 + 7 压缩 + 1 预检 | ≈ $2.15 | receipt 读取；原估 $3.0 偏高 |
| C（t129，raw vs hand v2，**已停止**） | 75 次 usage 记录 + 1 预检 | ≈ $1.77 | 126,320 输入 / 28,915 输出 token |
| 累计 | | **≈ $6.0** | 上限 $10；内部储备线 $6.5 |

**更正（我的错误）**：我先前把 `results.jsonl` 中的 `calls` 字段（工具调用次数）当成请求数，得出计划 C ≈ $2.84，并据此**停止了 t129（pid 9820）**。按请求数重算，累计仍低于 $6.5，停止是基于错误数字的。t129 的状态已存盘，可续跑；这一决定交给你（§8）。

### 9.2 计划 B（raw vs 生产 auto，n=10 每臂）
| 指标 | raw | policy:base（生产 auto） |
|---|---|---|
| 修好 | 5/10（eacces s1、sse s0/s1、wrong s0/s1） | 6/10（+ flaky s1） |
| 修好后验收通过 | 1/10（sse s1） | 2/10（flaky s1、sse s1） |
| 分歧轨迹 | — | 1/10（flaky s1，`divergedAt=3`；早先笔记写的"第 7 轮"与文件不符，以文件为准） |
| 从未触发压缩（无对照组） | — | 9/10 |

- **结论性限制**：9 组从未过 3100 字符地板，压缩器没有被调用，因此这些组里 auto 与 raw 是同一条路径，只是采样噪声。唯一有对照的一组是 flaky s1。压缩调用 7 次，闸门拒收：distill-failed ×3、no-token-gain ×1。
- **结论**：在这组 fixture 上，计划 B 无法回答"生产压缩器是否优于 raw"。差异（6 对 5）是噪声范围内的，不可作为证据。

### 9.3 计划 C（raw vs hand v2，部分，已停止）
- 已完成的 raw 轨迹（7 条）：eacces s0 未修好；eacces s1 修好@6；flaky s0 未修好；flaky s1 修好@6；perf s0 未修好；perf s1 未修好；wrong-model s0 修好@5。
- hand 臂：**0 条完成**。5 份 v2 稿（eacces s0/s1 r5、flaky s0/s1 r3、perf s0 r4）已写好并通过 C1–C3 的本地检查（引文逐字取自源文本，有闭合判读，验收段有 `npm test` 或 `analyze-trace`），哈希见 `DRAFTS-v2.sha256`，**尚未被消耗**。
- 这些稿子的内容会在续跑后才被轨迹读取。它们的好坏是否与真机结果一致，目前不知道。

### 9.4 这一轮没有做的
- 没有 holdout 认证，没有新金标入库，尺子仍然排除。
- 没有对"手写稿优于 raw"给出任何结论（计划 C 未完成，计划 A 的 n=10 不可检验非劣效）。

### 9.5 探索性低地板运行（t130，**偏离预注册，不用于认证**）
- 原因：3100 地板让计划 B、C 的绝大多数轮次不生效。用户授权我自行决定；我没有修改 PREREG-v2 或 3100 的定义，而是在同一批 fixture 上另开 `--min-chars 200` 的探索臂（输出 `.cfb-runtime/traj/t130-lowfloor-explore/`）。
- 低地板改变了手写臂的配置：`traj-run.mjs` 中 `hand && minChars===3100` 的专用逻辑（紧凑策略、为保证触发而降地板）被跳过。
- 结果：raw 臂 10/10 完成，修好 5/10；手写臂仅 1/10 完成（未修好），9 条卡在待稿状态，**手写臂压缩 0 轮**。这次运行无法回答"手写稿是否有效"。
- 花费约 $2.30（102 次请求）。之后未续跑，原因是接近我设定的 $9.0 硬停止线。
- 诊断（$0，现有 raw 轨迹，全部 6 个 fixture）：原文 reasoning ≥3100 字的轮次只占少数（多数 fixture 每轮 0–3/8），且主要出现在第 3–6 轮，而每条轨迹最多 6 轮。这就是 3100 地板让压缩几乎不发生的原因。

## 10. 第四轮（上限 $15）：3100 地板下的预注册复测（PREREG-v3、v4）

场景选择规则（PREREG-v3 §2，只看 reasoning 长度）：flaky-timeout、sse-truncated、wrong-model；每场景 3 个样本，≤6 轮，地板 3100（生产值）。

### 10.1 v3（t130）：raw vs policy:base（生产 auto），n=9 对
| 指标 | raw | auto | 差（raw−auto）· Newcombe 95% · Fisher p |
|---|---|---|---|
| 修好（≤6 轮） | 6/9 | 6/9 | 0 · [−0.38, +0.38] · p=1.0 |
| 修好后验收通过 | 5/9 | 3/9 | +0.22 · [−0.20, +0.56] · p=0.64 |

- 压缩：auto 共 12 次压缩，**闸门拒收 7 次**（invented-identifier ×6，no-token-gain ×1），接受约 5 次（由 12−7 推得）。
- 分歧：4 对在第 3–5 轮分歧；5 对从未触发压缩（按平手计）。
- 结论：**没有可检测的差异。** 功效不足以说明生产压缩器有用或有害。

### 10.2 v4（t131）：raw（复用 t130，非同期）vs hand（助手手写稿），同 9 对
| 指标 | raw | hand | 差 · Newcombe 95% · Fisher p |
|---|---|---|---|
| 修好（≤6 轮） | 6/9 | 5/9 | −0.11 · [−0.47, +0.29] · p=1.0 |
| 修好后验收通过 | 5/9 | 5/9 | 0 · [−0.39, +0.39] · p=1.0 |

- 手写稿：9 轮压缩，全部过生产闸链（比例中位 0.35，最大 0.65）。1 份被 `mode1-quality:environment-permission-assertion` 拒收（我写了未被原文直接支持的环境断言），改写后通过。
- 一条 hand 日志显示"稿 ✗"（flaky-s1 第 5 轮），原因尚未查清，记为未解。
- 结论：**手写稿没有比 raw 更好，也没有更差。** 与 v2 的结论一致（都在噪声内）。

### 10.3 对 Layer B 问题的回答（有限）
1. 为什么压缩很少发生：3100 地板下，原文超过地板的轮次只占少数（见 §9.5）。选出的 3 个场景能让压缩发生（9 对中 4–9 轮）。
2. 为什么生产压缩器没有帮助（或说没有证据它帮助）：压缩稿中**大多数（7/12）被闸门拒收，其中 6 次被闸门判定为凭空标识符（invented-identifier）**。这与 G2（幻觉标识符）是同一类问题。这是我们能看到的最直接的归因，但它是闸门的判定，不是人工核对的结论。
3. 手写稿为什么没有显示优势：本轮没有差异，无法归因。
4. 没有做：金标入库（`gold add` 未运行）、尺子校准、训练数据生成。

### 10.4 花费（对账）
- t130（v3）：receipt 精确，**$2.05**（85 次请求）。
- t131（v4）：多次运行，receipt 只记录最后一次。按 hand 臂的 usage 计算上界 **≤$1.98**。
- 累计上界约 **$12.4**（上限 $15；我的硬停止线 $13.5）。**本轮之后不再花钱。**

### 10.5 偏离与局限（必须看）
- 场景是经过选择的（按 reasoning 长度），因此它们不是随机抽取的。
- raw 臂在 v4 中是非同期复用（同日、同模型 id、同 fixture）。
- 手写稿由助手撰写，是"给定一份稿，主模型能否利用"的上界，不是生产压缩器的表现。
- n=9，功效极低。上面的区间很宽，足以覆盖"有用"与"有害"两种情形。

### 10.6 为什么手写稿没有超过 raw：下一轮思维链的读数（$0，t130/t131 原始轨迹）
读了什么：9 对样本的压缩后各轮思维链（`reasoning`），并对齐到同一轮次做"第一步动作"分类；sse-s1 对完整思维链做了逐段核对。分类是粗的（正则），只用于计数。

1. **稿子没有带来新信息。** 根因所需的提交哈希（4b9a0f3、c7d2e10）不在压缩后的上下文里。两臂都是在第 5 轮自己跑 `git log` 才第一次看到。稿子里"未解"的那个问题（`out.length > 0` 是为了什么）正好把模型导向同一个 git 历史。
2. **模型不把稿子当作稿子用。** 压缩后的思维链里，提到"稿/draft/台账"的次数几乎为 0（0–2 次/轨迹）。模型把压缩内容当成自己的记忆读，闭合判读、"推理链的阅读，未核对"这类标注和验收段落基本被忽略。
3. **第一步动作几乎相同。** 压缩之后的第一步，手写臂与 raw 的分类为：复现/验收 5 对 vs 5 对，编辑 3 对 vs 2 对，读取 1 对 vs 1 对，无 1 对 vs 0 对。稿子没有改变模型的下一步。
4. **分歧出现在环境怀疑里（sse-s1，逐段核对过）。** 手写臂第 4 轮后的第一个命令是 `node verify.mjs; npm test`。`verify.mjs` 的 `ls` 找不到，但 `npm test` 显示通过。手写臂在第 5 轮花了约 6.7k 字思维链讨论这个矛盾，第 6 轮仍在怀疑沙箱是否隐藏了文件，没有编辑。raw 臂在第 5 轮有同样的矛盾（verify 出现 7 次），但第 6 轮就接受了"verify 由 harness 提供"并直接编辑，然后修好。手写稿的验收段（"看到 npm test 全部通过即算完"）让这个矛盾变成了阻塞项。这只是一对样本，只能作为假设。
5. **flaky 的失败不是稿子造成的。** 两臂都在做 CPU 压力复现（手写臂有 `busy loop` 与 32 个并发忙等；raw 有 `hog.mjs`、`burn.mjs`）。没有任何一臂收敛。我的稿子要求"在 2 核或加压条件下重跑"，这可能放大了这个陷阱，但 raw 没有稿子也做了同样的事，所以我不能把它归因于稿子。
6. **wrong-model 两臂都在第 5 轮左右编辑，结果相同。** 模型自己的路径已经对了，稿子没有改变结果。

**结论（有限，n=9）**：手写稿没有超过 raw，因为：（a）它没有带来模型还缺的关键事实，模型会自己用 `git log` 和 `verify` 去查；（b）模型不把稿子当作带判读和验收的指令来执行，只把它当作压缩的记忆；（c）稿子没有解决、有时还触发了环境矛盾（sse-s1）。要让稿子有用，需要（i）放入决定性的事实（哈希、行号、已验证的读数），（ii）预先解决环境异常，不让验收命令变成阻塞项，（iii）去掉会诱导长时间压力实验的指令。这三点需要在新的预注册里检验，不能事后拿来解释这一轮。

### 10.7 勘误（2026-10-11，$0，手写稿核对）
- **撤回 §10.6(c)(i)**：「放入决定性的事实（哈希、行号、已验证的读数）」这条建议会向模型注入其原生上下文里没有的信息，违反「有就保留、没有不编」的标准，也会让手写臂不再测压缩本身。不采用。
- **§10.6 第 2 点需重写**：这 9 份稿没有落定句、三元组、「所以下一步工具调用」等指令类内容（见下），所以「模型不把稿子当指令」在本轮无从检验。
- **偏离（需披露）**：9 份稿按 PREREG-v2 §4 的 C1–C3 写（9/9 通过），没有按 pending 协议附带的完整写法（落定句、old_text/new_text 三元组、两条「已排除」、下一步调用、收工三问；9/9 缺失）。PREREG-v4 §3 引用的是较宽的 C1–C3。
- **核对结果**（详见 `/home/user/audit-2026-10-11/t131-hand-audit/AUDIT-REPORT.md`，逐句对照该轮原生输入）：
  - 编造或来源错误 4 处：flaky-s0 的验收命令 `node test/hedge.selftest.mjs` 不在输入中；wrong-model-s2 写「尚未落地」而该轮已有 edit_file；sse-s1 引用了输入中不存在的「HEAD」；flaky-s2 的「回到 src/distill.js」是 raw 已排除方向的重新引入（方向偏移）。
  - 错误判读分支 2 处（sse-s1、sse-s2）：把 `r.out.length > 0` 当成全部来源，漏掉了 `finish || (done ? 'stop' : null)`。
  - 原生机理丢失：完全缺失 5 项，部分缺失 4 项（flaky 的同进程 poll 阶段机理；sse 的 [DONE]→stop；wrong-model 的 observe 忽略 n.model；旧宿主验收条款 3/3 缺失）。
  - 闸门缺口：hand-draft 的 G1 按锚点比对，不按整条命令字面匹配，因此 E1 这类由真实锚点拼出的虚构命令能通过（据代码推断，待读 compileV4Direct 确认）。
- **对 t131 结论的限定**：「手写臂没超过 raw」只对这 9 份稿成立。这些稿丢了 raw 臂仍保留的机理，并有少量编造与错误分支，因此 t131 测到的是有损稿，不能推出「忠实的手写压缩没有用」。两臂结局相近与此一致，但不能证明因果。

### 10.8 第五轮（t132，PREREG-v5，$0 手写 + 主模型花费）：手写臂 vs raw，归因到下一轮的推理与动作

**运行事实**
- 计划 t132（digest 4ee675934e666e26）。raw 臂复用 t130 的 9 条 raw 轨迹（reusedFrom），手写臂 9 条，全部分叉（分歧轮 3 或 4，未出现未分歧）。
- 9 份稿：闸门第一次拒 2 份（flaky-s1、sse-s2，违规 `ungrounded-command`：反引号内的命令片段含引号，与调用原文的转义形式不一致）。两份各改写一次（只改写格式，删掉 sse-s2 中原生推理里找不到依据的「ctx 写它目前是绿的」）后通过。改写后的稿子在被使用之前完成，哈希清单对应的就是使用的版本。
- **闸门漏检（wrong-model-s1-r4）**：事后 `check-spans` 发现 wrong-model-s1-r4 有两处片段不在它的输入中：`observe(options)`（原生推理里的形式是 `observe(options, n)`）和「第二次会话」（是对 "session 2" 的译写却加了引号）。闸门（`handDraftGate`）只查命令类违规，不查反引号与引文，因此放行。这份稿已被使用，不回改；在 §10.8 中标记为**审计标记**，下文的敏感性检验会去掉它。
- 哈希：`transfer/route-2026-10-11/DRAFTS-v5.sha256`（9 条，已校验通过，使用的版本）。
- 花费（重要，需披露）：receipt 记 `estimatedUsd=0.237`，promptTokens 224,368，completionTokens 56,952，mainCalls 19，preflights 4。按 `pricing.a6api.json`（输入 $1/M、输出 $4/M、每次请求 $0.02）复算：tokens 部分 ≈ $0.452，加请求费（若按 19–23 次计）≈ $0.83–0.92。receipt 每次运行覆盖，之前几次运行的花费无法从 receipt 精确还原。估计范围：本轮 $0.45–0.92，上限 $1.575 之内。累计仍在 $15 上限之内，但不是精确值。

**结果（最多 6 轮，`--max-rounds 6`；修好 = 原症状在同等条件下消失并被验收）**

| 变体 | n | 修好 | 修好轮数（均值） | 修好后验收 | 声明相称 | prompt tokens 合计 |
|---|---|---|---|---|---|---|
| raw（复用） | 9 | 6/9（67%） | 4.8 | 83% | 100% | 15,396 |
| hand | 9 | 5/9（56%） | 4.8 | 80% | 100% | 9,534 |

逐条（任务 / 样本：raw → hand）：
- flaky-timeout s0/s1/s2：✗ → ✗（三对都没修好）
- sse-truncated s0：@4 → @4；s1：@6 → ✗（**唯一的结局分歧**，raw 独有）；s2：@5 → @6（结局相同，慢一轮）
- wrong-model s0：@5 → @5；s1：@5 → @5；s2：@4 → @4

配对检验：9 对中结局不一致的只有 1 对（sse-s1，raw 独有）；精确 McNemar p = 1.0。在 n=9、一对不一致的情况下，这个数据**不能**区分两臂；raw 与 hand 的差异（6/9 vs 5/9）不是证据。手写臂与 raw 共享前缀，所以 9 对不是独立的两臂实验，只测了「在第 r 轮换上稿子之后的效果」。

**归因（逐对读下一轮的推理与动作，即草稿轮次 r 之后 r+1 轮的 reasoning 与 action）**

这一节回答「手写稿为什么对原稿没有进步」。判断依据是 transcript 中第 r+1 轮的 reasoning 与 calls，而不是结局摘要。

1. **原生推理已经包含根因的对，稿子只是重述，下一步动作与 raw 相同**（wrong-model s0、s2；sse-s0）。例：wrong-model-s0 的 raw 第 4 轮原生推理已经写出「compiler-transport-started model = deepseek-v3.1（stale）而 n.model = deepseek-v3.2」，第 5 轮两臂都去编辑 host-follow.js 和 plugin.js。稿子在这里没有增加任何推理，也没有减少。这是「稿子无增量」的机制，而不是稿子有害。

2. **稿子把草稿作者自己的转述带进了模型的推理**（wrong-model-s1，审计标记的那份）。手写臂第 5 轮的原生推理写道「observe(options) 只看 options.model」，这正是草稿中那处非逐字片段（原生推理里只有 `observe(options, n)` 的设计语句）。也就是说，写稿者的措辞误差进入了被测模型的推理链，成为一个断言。这属于**稿子污染**，与 §10.7 的核对结论一致：闸门放行的非逐字片段会被模型当作原文采纳。

3. **稿子中的「待查 / 未解」条目改变了下一步动作，把模型从修复引到旁支**（sse-s1，唯一的结局分歧）。草稿 r4 写了「确认 verify.mjs 的来源（原文读到它不存在，而 npm test 仍显示通过，原文待查）」，作为「回放过了之后」的待办。手写臂第 6 轮的原生推理转向「`node verify.mjs` 打印 PASS 却找不到文件，可能是 NODE_OPTIONS 或 loader」，动作是 `echo NODE_OPTIONS`、`type node`，即环境侦查。raw 臂第 6 轮的原生推理是「sandbox 限制了命令…现在实现修复」，动作是编辑。两臂在第 4 轮都注意到了 verify.mjs 的异常（raw 第 4 轮的推理里有同样的句子），区别在于手写稿把它列成了必须处理的待办。这是一个**可复现的机制**：稿子里的未解项会变成下一步动作。

4. **稿子给出了结论，超前于原生推理**（flaky-s0、flaky-s1）。flaky-s0 手写臂第 4 轮的推理直接跳到「根因：`primary.then(() => { primarySettled = true })`」，而 raw 臂同一轮的原生推理仍停在「在 CPU 负载下复现」。稿子提前给出的假设（「100ms 余量」「同一 timer 阶段」）是草稿中以「原文的推断」标注的，模型把它们当成了自己的结论，但没有任何一臂在 6 轮内复现 CI 的 2 核环境。flaky 三对都是 0/3，这更像是**任务本身在沙箱里不可复现**（需要真实的 2 核 CI 负载），而不是稿子的效果。这一点不能与稿子效果分开，应视为尺子的问题。

5. **稿子与 raw 的分叉对 sse-s2 只慢一轮**（raw 第 4 轮：`find / -name verify.mjs`；手写臂第 4 轮：`ls -la verify.mjs ...; find . -name verify.mjs`）。两臂在同一个异常上花了同样的轮数，稿子没有改变方向，只是多了一个等待。

综合：本轮手写稿**没有带来进步**，原因是（a）当原生推理已有根因时，稿子是冗余重述（机制 1）；（b）当原生推理没有根因时，稿子只能提供草稿作者的推断，而且这些推断中有非逐字的片段被模型采纳（机制 2、4）；（c）稿子的「待查」项会改变动作（机制 3）。这三点都是**稿子的结构性问题**，不是「压缩有用 / 没用」的证据。**对 §10.6 的旧结论：不能说「手写稿没用」，也不能说「压缩有用」；本轮测到的是这 9 份稿，它们有一处闸门漏检、两处改写、一份被审计标记的稿子。**

**Gold 为什么有效、为什么 gold 形式优于其它压缩形式**：本轮没有 gold 数据，无法回答；这一问题仍然开放，不在 t132 中解决。

**对尺子的影响**（PREREG-v5 之后的判断）：flaky-timeout 三对在 raw 与 hand 中都是 0/3，无法区分两臂，且在沙箱中不可复现。它不应该作为 dev 尺子的正例任务，建议在 v6 中改为可在沙箱复现的任务或直接移出。sse-truncated 与 wrong-model 的 raw 结局较稳定（5/6 与 3/3），是更可用的尺子。

**下一步（需要决定，不自动执行）**
- 闸门升级（v6 预注册）：把 `check-spans` 的反引号与「」检查并入 `handDraftGate`，并禁止「待查 / 未解」条目在稿子中作为可执行待办出现。这一改动会改变后续运行的闸门，必须预注册，不能在 t132 数据上直接生效。
- 手写臂不再以「稿子 vs raw 的结局」为主指标；主指标应是「分歧轮的下一轮 reasoning 与 action 是否与 raw 同向」，并在预注册中写明判定规则。
- 未做：gold add（未授权）、ceiling --plan（未授权）、teacher 文件（未触碰）。

### 10.9 更正（2026-10-11，$0，用户要求推动：对 §10.8 及其依据的修正）
1. **闸门修正（代码）**：`tools/helpers/hand-draft.mjs` 的 `handDraftGate` 原先只查「带空白」的反引号片段，导致 `observe(options)` 这类无空白片段被放行；「」引文完全不查。现改为：所有反引号片段与「」引文都必须逐字出现在该轮输入（raw、ctx、calls、程序部件）中，新增违规类型 `ungrounded-quote`。
   - 检验：`audit-2026-10-11/t132-gate-recheck.mjs` 用修正后的闸门重检 t132 的 9 份稿：仅 wrong-model-s1-r4 被拒（`observe(options)`、「第二次会话」），其余 8 份通过。`t132-gate-test.mjs` 三项仍成立。
   - 这是 v6 的改动，**不改 PREREG-v5**（已冻结）。t132 的数据仍按 v5 闸门解释；wrong-model-s1-r4 仍保留为审计标记，不回改。
2. **引文修正（t131 报告）**：`audit-2026-10-11/t131-hand-audit/AUDIT-REPORT.md` 中 86 处「」引文逐条核对，未找到出处的 32 处去引号改为转述（`fix-quotes-v6.mjs` 与日志 `fix-quotes-v6.log`，原稿 `AUDIT-REPORT.before-v6.md`）。两条被误判的英文引文已核对为出处有偏差，同样改为转述；这是保守处理。
3. **t131 重复行（隔离，不删）**：`cfb/.cfb-runtime/traj/t131/results.jsonl` 有 9 组 hand 样本重复、同一时间戳、结局不一致。清单见 `t131/results.DUPLICATES-QUARANTINE.md`。在确定哪一行为准之前，t131 的 hand 数字不作为证据。
4. **plan 注册表陈旧状态**：`cfb/.cfb-offline/history.json` 中 t128（有 receipt 与 20 条结果）、t130、t131、t132 原为 "planned"，已改为 "ran"（t129 为 "partial"）。原文件备份 `history.before-v6.json`；每条修改附 statusNote。
5. **receipt 快照**：`t132/receipt.snapshot-2026-10-11.json`。receipt 每次运行覆盖，此快照保存本轮最终值。
6. **花费未能对账**：receipt 估算 $0.237，而 completionTokens 56,952 × $4/M ≈ $0.228，几乎只吻合输出部分；promptTokens 224,368 按 $1/M 计为 $0.224。如果 prompt 大部分为缓存命中，估算可能合理，但这需要服务商账单才能确认。在此之前，本轮花费以 §10.8 给出的范围为准，不作为精确值。
7. **仍开放**：gold 为什么有效（无数据）；flaky-timeout 在沙箱中不可复现，应从 dev 尺子移出，待你确认。
8. **回归（已修复）**：t132 中我给闸门加的"带空白片段必须逐字出现"规则，使 `test/gold-standard.selftest.mjs` 的 M7 用例失败（测试稿中的拟议改法 `const RETRY = 2` 不在原文中）。这是我在 t132 修补后没有跑全量 verify 造成的。修复：对「改成 / 改为 / 改回 / 替换为」之后的片段豁免逐字检查，由 `invented-triple` 与 `invented-decision` 负责其依据。
   - 局限（需写进 v6）：豁免只针对改法目标。若稿子在「改成」之后写入一个无依据的片段，且不构成三元组，则不会被拦下。这是有意的取舍，不是完备性保证。
   - 校验：`verify.mjs` 回到基线 1271 通过 / 2 失败 / 2 跳过（失败项为已接受的 manifest-ignore 03 与 doc-watermark）；`gold-standard.selftest` 82/82。
   - MANIFEST：更新 `tools/helpers/hand-draft.mjs`、`tools/traj-run.mjs`、`transfer/route-2026-10-11/RESULTS.md` 三条哈希；旧清单备份在 `audit-2026-10-11/MANIFEST.sha256.before-v6`。
9. **PREREG-v6 草案**：`transfer/route-2026-10-11/PREREG-v6.md`，未冻结、未运行。其中 G-v6-2、G-v6-3 尚未实现，实现前不冻结。

### 10.10 PREREG-v6 冻结与 v6 闸门回溯（2026-10-11，$0，无花费）
- **实现**：`tools/helpers/hand-draft.mjs` 新增 G-v6-2（`open-as-action`）与 G-v6-3（`ctx-only-claim`）；G-v6-1 见 §10.9。
- **检验**：`audit-2026-10-11/t132-gate-v6-test.mjs` 7/7 通过（正反用例）；`t132-gate-test.mjs` 仍成立；`gold-standard.selftest` 82/82；`verify.mjs` 1271 通过 / 2 失败 / 2 跳过（失败项为已接受项）。
- **回溯**（`audit-2026-10-11/gate-v6-retro.mjs`，只读）：
  - t132（v5 下 9 份全部接受）：v6 下 7 份不通过。flaky-s0/s1/s2 因「验收命令待定」等（open-as-action）；sse-s1 因 open-as-action；wrong-model-s0/s2 因 ctx 验收条款中的锚点不在原生推理（ctx-only-claim）；wrong-model-s1 因 G-v6-1（审计标记）。通过的只有 sse-s0、sse-s2。
  - 含义：t132 的 v5 结论只能在 v5 下解释，不能作为 v6 的证据。v5 不回改。
  - t131：仅 flaky-s0 不通过（`node test/hedge.selftest.mjs` 不在原文，t131 审计已确认），其余 8 份通过。
- **冻结**：`transfer/route-2026-10-11/PREREG-v6.md`，sha256 `f124117f6960f9affc05b202a37087be89464ed7dbf3aaea166d65ce75346686`。
  - 决定：flaky-timeout 移出 dev 尺子（依据：t132 两臂 0/3，沙箱不可复现，稿子多次违规）。
  - 主指标改为第 r+1 轮的 reasoning 与 action 一致性；修好率只作次指标。
- **未授权**：冻结不等于授权花费。任何 v6 真机运行需用户另行批准预算。
- **局限**：G-v6-1 对改法之后的片段豁免；G-v6-3 只检查锚点，纯中文断言不检查；弱锚点（如 `trace`）可能触发。
- **MANIFEST**：`hand-draft.mjs` 哈希已更新。

### 10.11 PREREG-v6 运行结果（t133，2026-10-11，已花费 receipt $0.2）
- **运行**：计划 `t133`（digest a810203cef6cf4ff，预估 $0.225，参考上界 $1.05；用户授权"预算不设上限"）。12 条轨迹，0 错误；主调用 16；影子轮 23；raw 6 条复用 t130 leader（reusedFrom 已标注）。receipt 快照 `t133/receipt.snapshot-2026-10-11.json`。
- **花费核对**：receipt `estimatedUsd` 0.2；promptTokens 142,472；completionTokens 28,768。与定价估计的差距未核对，与 t132 的未解项同类（见 §10.8/§10.9 同一条）；本节不把 0.2 当作定价口径的真实花费。
- **草稿**：6 份全部通过 G-v6-1/2/3 与 `check-spans`（逐字比对 pending raw/ctx/calls）。`sse-truncated-s2-r3` 与 `wrong-model-s2-r4` 的首版因引用了本轮未发出的命令被拒，已按内容修正（改为文字描述，不写可执行命令）。草稿哈希：`transfer/route-2026-10-11/DRAFTS-v6.sha256`，`sha256sum -c` 全部 OK。
- **次指标（修好率）**：raw 6/6 修好（到修好 4.8 轮）；hand 6/6 修好（4.8 轮）。修好后验收：raw 5/6，hand 3/6。最终声明 fixed：raw 1/6，hand 0/6。

**主指标（PREREG-v6 §2）**：每对的分叉轮 r，比较两臂第 r+1 轮的 action 类别与首个命令意图。

| 任务 s | r→r+1 | raw 第 r+1 轮 | hand 第 r+1 轮 | 一致 |
|---|---|---|---|---|
| sse s0 | 4→5 | bash：cat transport.js、replay、npm test | bash：同一组 | ✓ |
| sse s1 | 4→5 | bash：npm test、找 verify.mjs | bash：npm test、找 verify.mjs | ✓ |
| sse s2 | 3→4 | bash：ls verify.mjs、find 全盘 | edit：直接改 transport.js | ✗ |
| wm s0 | 4→5 | edit：host-follow.js | edit：host-follow.js | ✓ |
| wm s1 | 4→5 | edit：host-follow.js | bash：cat trace、找 verify.mjs、cat package.json | ✗ |
| wm s2 | 4→5 | 无工具调用（文字核对旧宿主） | bash：node -e 核对旧宿主 | ✗（类别不同，意图相同） |

- 一致 3/6，不一致 3/6。n=6，按 PREREG-v6 报告为「未区分」，不报告显著性。
- 配对的「首个命令意图」由作者人工判定，非程序判定；这是本主指标的主观环节，需在报告中注明。

**归因（读第 r+1 轮 reasoning 与 action）**：
1. **sse s2（第 3 轮分叉，第 4 轮分歧）**。原生第 3 轮推理已写出根因（`finish: finish || (done ? 'stop' : null)`），但同轮仍说"Hmm… Let me check the actual test setup"，即原生要先查 verify.mjs 的异常。raw 第 4 轮照做（find 全盘）。hand 第 4 轮直接改代码。原因在我的草稿：`sse-truncated-s2-r3.md` 写了「未解：…但这不影响落点」——这是一条原生推理未达到的结论，它替模型关掉了本来要做的核查。这是**我的草稿造成的**，不是模型的失误。
2. **wm s1（第 4 轮分叉）**。raw 第 5 轮 reasoning 为「npm test works … Anyway.」，随即改代码。hand 第 5 轮去查 trace 的异常与 verify.mjs。草稿 `wrong-model-s1-r4.md` 的「未解：verify.mjs 不在仓库列表里……不影响落点」行，正是这个线索。G-v6-2 没有拦住它：它只禁止「未解」出现在动作行，而「未解：」行本身按 v6 是允许的。**同一机制在 t132 sse-s1 已出现过一次**（稿子里的未解项被下一轮当作动作）。
3. **wm s2（第 4 轮分叉）**。两臂第 5 轮意图相同（核对旧宿主那一跳等于 n.model）。raw 用文字完成核对，hand 用 bash 完成。只有形式不同，没有内容差异。
4. **sse s0、wm s0（一致）**。两臂第 r+1 轮 reasoning 都是原生已有的结论的延续（raw 第 r+1 轮：「Now run replay and tests」「Now edit host-follow.js and plugin.js」）；hand 的 wm s0 写出 `callConfig(options, n)`，这是 hand 自己的设计，草稿里没有（草稿只写了 observe 与闭包）。
5. **共同事实核对**：sse s1 两臂第 r+1 轮都引用了 git 提交号 `4b9a0f3`、`c7d2e10`。这两个号在两臂第 4 轮的工具结果（git log）里逐字出现，不是编造。

**与修好结局的关系**：本轮修好率两臂相同（6/6）。差别只在「修好后验收」（raw 5/6、hand 3/6）和声明（raw 1/6 声明 fixed，hand 0/6）。n=6，未区分。主指标的不一致全部来自草稿里的「未解 / 不影响落点」项，不来自 raw 与 hand 的能力差距（这一点是对草稿的归因，不是对 hand 臂的归因）。

**结论（只写数据能支持的）**：
- 在本尺子（sse-truncated、wrong-model，n=6）上，手写臂与 raw 在修好率上未区分；在第 r+1 轮行为一致性上 3/6。
- 手写稿中的「未解 / 不影响落点」条目与下一轮行为的偏离相关：含该条目的 3 份稿子中，2 份对应不一致对（sse s2、wm s1）；第 3 份 sse s1 也含该条目，但两臂都去查了 verify.mjs，所以一致。这是可检验的机制假设，不是已证实的因果。
- 「过尺即真机好」在本轮的尺子层面未被检验：本轮 6/6 修好与 raw 相同，既不支持也不否定。
- 不把 v6 的通过率解释为真机成功率。

**局限**：n=6；raw 来自 t130 leader（非同期对照）；主指标的意图判定由作者人工完成；花费口径未核对。

**待办（需用户决定，未执行）**：
- 下一版 PREREG-v7 草案需要新增两条规则：(a) 草稿的「未解」项不得写出具体的核查对象（文件名、命令）；(b) 草稿不得写「不影响落点 / 不必查」之类，原生推理未得出的结论。PREREG-v6 已冻结，不能在 v6 下修改规则；已写草案待冻结（见 `PREREG-v7.md`，DRAFT）。
- **PREREG-v7 草案**（`transfer/route-2026-10-11/PREREG-v7.md`，DRAFT）：新增 G-v7-4（未解不得指名核查对象）与 G-v7-5（不得替模型下「不必查」结论）。只读探针 `audit-2026-10-11/v7-proposal/gate-v7-probe.mjs`：t133 拦下 3 份（sse-s1-r4、sse-s2-r3、wm-s1-r4），t132 拦下 5 份。未冻结，未运行。

### 10.12 PREREG-v7 运行结果（t134，2026-10-11，receipt $1.40）
- **运行**：计划 t134（digest e0b37007667f4f63，期望 $1.35，上界 $4.62）。24 条轨迹（raw 12 + hand 12），0 错误，主调用 112，receipt `estimatedUsd` 1.40（promptTokens 270,709；completionTokens 48,049）。raw 同窗新跑。草稿 12 份通过 v6+v7 闸门与 check-spans；`DRAFTS-v7-t134.sha256` 验证通过。
- **过程记录**：wm-s4 第一版草稿被生产闸 `production-gate:no-gain` 拒绝（草稿 + 程序部件 585 字 vs 原生输入 810 字，净省 −138，要求 ≥40）。修法是删掉作者自加的套话，保留原生根因、修法、动作与验收，草稿缩到 278 字后通过。这是长度问题，不是内容问题。
- **主指标（PREREG-v7 §3，固定规则）**：

| 对 | raw 修好轮 | hand 修好轮 | d | 备注 |
|---|---|---|---|---|
| sse s0 | 6 | 6 | 0 | |
| sse s1 | 4 | 未修好（7） | +3 | hand 探查 verify.mjs |
| sse s2 | 5 | 4 | −1 | |
| sse s3 | 5 | 5 | 0 | |
| sse s4 | 5 | 未修好（7） | +2 | hand 探查 verify.mjs |
| sse s5 | 4 | 4 | 0 | |
| wm s0 | 5 | 5 | 0 | |
| wm s1 | 5 | 5 | 0 | |
| wm s2 | 4 | 4 | 0 | |
| wm s3 | 4 | 4 | 0 | |
| wm s4 | 5 | 6 | +1 | hand 探查 verify.mjs |
| wm s5 | 4 | 4 | 0 | |

  - n=12；均值 d(hand−raw) = +0.417；95% bootstrap CI [−0.083, +1.083]；修好率 raw 12/12，hand 10/12。
  - **判定：未区分**（不满足「超过」的全部条件；CI 下界 −0.083 < 0，也不满足「劣于」）。点估计方向不利于 hand。
- **归因（读 transcript 与 reasoning）**：
  1. **题目缺陷是主要混杂**。t134 中 17/24 条轨迹探查了 `verify.mjs`。根因：v2 题目的 package.json 指向不存在的 verify.mjs，沙箱的 npm test 是 canned 输出（照跑 selftest 并打印 PASS），README 与 package.json 说法冲突。这是题目错误，不是模型能力差异。修复见 PREREG-v8。
  2. **3 个 hand 慢于 raw 的对，全部是 hand 单独探查 verify.mjs**（sse s1、sse s4、wm s4）。raw 在相同环境下只在推理中一笔带过（例如 sse s4 raw R5："Anyway npm test works"）然后直接改代码；hand 在同一轮推理末尾转去查 verify.mjs（sse s1 hand R4 推理写"Confirmed the bug. Now let me fix it."，动作却是 `ls -la && cat verify.mjs`）。线索来自两臂共享的第 1 轮 find 输出，不是草稿写的。草稿未提及 verify.mjs。
  3. **机制假设（未证实）**：压缩替换了原生第 3 轮的推理与工具输出，hand 的上下文里不再有那段原生推理的"收束"，于是对共享的旧线索重新开启核查。这与 t133 中草稿写出「未解：…不影响落点」的效应不同：t134 草稿未写此类条目，但效应仍在，说明 v7 闸门只拦住了草稿显式写出的部分。需在 v8 中用 M1/M2 检验。
  4. **两臂都探查或都不探查的对，轮数相同**（sse s0、s3、s5，wm s0–s3、s5）。这支持「差异来自探查分支」，但 n 小。
  5. **修好之后的验收**：raw 修好 12 个，其中 10 个修好后有验证动作（83%）；hand 修好 10 个，其中 8 个有验证（80%）。差距 1 个样本，未单独分析。
- **含义（只写数据能支持的）**：
  - 在 v2 题目上，hand 没有超过 raw；未区分，点估计略差。
  - 差异的主要来源是题目缺陷触发的探查分支，且只在 hand 臂上显著出现（3/3）。
  - 这不证明手写稿有害；它说明在有缺陷的题目上，手写稿的上下文替换会改变模型对旧线索的处理。
- **下一步**：PREREG-v8（已冻结）：修复 verify.mjs 缺陷（`tools/traj-fixtures-v3.mjs`，`CFB_FIXTURES=v3`），同一设计、同一判定规则，t135 新跑。M1（探查率应显著下降）为操纵检查。
- **未解**：receipt 口径。t133 receipt 0.2（promptTokens 142k）与 t134 receipt 1.40（promptTokens 271k）每 token 单价相差约 4 倍，不一致，待对账（见 §10.8 同类问题）。

### 10.13 t135（PREREG-v8，v3 题目，判定规则同 v7）

- **运行**：计划 t135（digest 1ae12c5cc07b498e），`CFB_FIXTURES=v3`，sse-truncated 与 wrong-model 各 6 样本，raw 同窗新跑。runner 两次（第一次在等待手写稿时暂停，第二次续跑），退出码 0；24 条轨迹，errors 0，gateFails 0，compressCalls 0；影子分叉 12 组，12 组全部分歧（第 3–4 轮）。receipt estimatedUsd 1.562（计划 ≈1.35，上界 ≈4.62）。
- **草稿**：12 份手写稿全部通过 gate-v7；校验和 `DRAFTS-v7-t135.sha256`（12 OK，在 drafts 目录下验证）。
- **判定**（`audit-2026-10-11/v7-proposal/analyze-t134.mjs`，取每组最后一行）：n=12；mean d（hand−raw）=0.083，95% CI [0.000, 0.250]；修好率 raw 12/12，hand 12/12。**结论：未区分**（不满足超过的全部条件）。逐对：11 对 d=0；wm s0 为 raw 4、hand 5，d=+1。
- **修好后的验收**：raw 修好 12 个，其中 11 个有验证；hand 修好 12 个，其中 11 个有验证。
- **平均修好轮数**：raw 4.25，hand 4.33。
- **promptTokens（receipt 口径）**：raw 194,607 与 hand 122,039，两者是不同臂的分开计数，不是同一请求的对比；按 §10.8 的未解口径，不据此下结论。
- **M1（操纵检查，预注册）**：未达成。verify.mjs 探查率 **24/24**（t134 为 17/24），方向与预测相反。分析：探查几乎都出现在第 2 轮的广域只读命令里（`cat ... verify.mjs`，与 README、src、test 一起读）。v2 中该文件不存在，`cat` 报错也被计为探查；v3 中文件存在，所以同一条命令现在总会命中。M1 的「探查率」因此不是干净的操纵指标，它测的是「通读时是否触到该文件」，而不是「是否去跑验证」。这一条结论按预注册原样报告，不改判定规则。
- **M2（机制检查，描述性）**：原先的统计口径是「任一命令触碰 verify.mjs」，它把广域读取也算了进去，不能区分「读文件」和「跑验证」。按「真正执行 verify（node verify.mjs / npm test）」重算（`audit-2026-10-11/v7-proposal/probe-exec.mjs`，$0，事后描述性，不改判定）：
  - t134：raw 6/12、hand 5/12，hand 独有执行的对 **0**。
  - t135：raw 5/12、hand 7/12，hand 独有执行的对 **3**：sse s5（d=0）、wm s0（d=+1）、wm s1（d=0）。
- **更正**：上一版「hand 独有探查的对在 t135 消失、与缺陷驱动的解释一致」只在旧口径下成立，换到执行口径就不成立。t135 中 hand 独有执行的 3 对里只有 1 对有差异，且差异只有 1 轮。缺陷驱动的解释目前没有被支持，也没有被否定，n 太小。
  - （已更正）t134 的 hand 变慢是否来自缺陷题目，目前不能下结论。
  - 本轮不能说 hand 超过 raw，也不能说 hand 有害；按规则是「未区分」。
- **未解（同 §10.12）**：receipt 口径（t133 与 t134 的每 token 单价不一致）；commit ID 4b9a0f3、c7d2e10 来源未确认；t133 pending 尚未移入 pending/done；check-spans 与 MANIFEST 尚未对 t135 文件更新。

### 10.14 P0 审计结果（2026-10-11，$0，不改判定，不做破坏性操作）

- **check-spans**：规则在 `audit-2026-10-11/v7-proposal/gate-v7.mjs` 内（输出中的 `check-spans:*`）。t135 的 12 份草稿已全部通过，包含此项。
- **t133 pending 移入 done**：已完成。`t133/pending/done/` 中 6 个文件，`pending/` 顶层为空。
- **t133 草稿事后过 gate-v7**：12 份中 3 份失败（sse s1-r4、sse s2-r3、wm s1-r4），失败项为 `v7:open-with-target` 与 `v7:dismissal`。草稿中都有「未解：…不影响落点」这类收束写法，与 §10.12 记录的 dismissal 效应一致。这些草稿是 t133 运行时实际使用的，**不改写**，只记录为 t133 的已知缺陷。
- **receipt 4 倍差异：已解决，原因是估算口径**。各 receipt 的 `estimatedUsd` 精确等于 `mainCalls × 0.0125`（`compressCalls` 均为 0）：t133 16×0.0125=0.200；t134 112×0.0125=1.400；t135 125×0.0125=1.5625。金额不按 token 计价，所以 `promptTokens` 与金额之间的每 token 比值没有意义。**真实花费只能以服务商后台账单为准**，receipt 金额不是实付。
- **MANIFEST 漂移（15 项）：全部为本轮有意改动**，包括 `tools/traj-fixtures.mjs`（CFB_FIXTURES 开关）、`RESULTS.md`、`tools/traj-fixtures-v3.mjs`、`PREREG-v5…v8`、以及 DRAFTS 校验和文件。
- **MANIFEST 缺失（24 项）：数据丢失，不是漂移**。这些文件既不在磁盘上，也不在 HEAD 中，压缩包（`archive-2026-10-11/`）里也没有：`deploy/kaggle/data/sft-train.jsonl`、`sft-dev.jsonl`；`transfer/models/` 下 micro-generator-gen-v3/v4/v5/gen/batch4/batch5 的 train/dev 压缩文件，以及 v4flash-scenarios 的 birth-units-census batch1–5；`transfer/recordings.json`、`transfer/probes-2026-10-07/oracle_out.json`、`units.jsonl`。我没有重新生成 MANIFEST，因为那样会把丢失的记录从清单里悄悄删掉。
- **git 工作区状态**：`git status` 显示 539 个已跟踪文件被删除、37 个已修改、4 个未跟踪；`git` 还报过 `unable to read 4ca3f16…` 错误。这很可能是之前清理留下的，需要单独做一次对账，本轮不动。
- **commit ID 4b9a0f3、c7d2e10**：仍未确认来源，标为未解。

### 10.15 PREREG-v9：严格尺子与样本池（2026-10-11）

- **判定：INVALID。** 尺子不能用于筛选训练数据，`build` 按设计拒绝运行。
- 确定性与空稿、照抄对照：通过。
- 未通过：hand 通过率 17/26 = 0.654（下限 0.80，CI [0.462, 0.806]）；负对照漏洞 15 个（N2 漏 10/18，N3 漏 5/22）；教师 test 通过率 5/216 = 0.023（下限 0.20）。
- 主因：教师语料是抽取式压缩，G6（不照抄）拦下 1201/1233 单元。这与「抄不动」的要求冲突。hand 在 G3（承重锚点保留）上有 9/26 的真实漏失。
- 规范与全部数字：`transfer/route-2026-10-11/PREREG-v9.md`；产物：`data-v9/`（validation.json、thresholds.json、labelled-pool.jsonl）。
- 0.80 下限是我自己定的，不是用户定的，需要用户决定是否保留（见 PREREG-v9 §8.1）。
