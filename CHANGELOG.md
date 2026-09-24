# Changelog — dsh-cot-form-b

> 版本说明自 README 迁出（2026-09-24 整理）。历史验证数字按当时记录保留，不回写。
> 当前实现 = 最新条目；更早条目仅作沿革。对应详版报告在 `docs/ ` 或 `docs/archive/`。

> **当前实现：v11.6（2026-09-23）**。成本模型落地第一批（`docs/AUDIT-V11.5.md`）：
> `birth.minChars` 500→**3100**（`净收益=(R−1)·d·(B−B′)−T−5B′`，d=0.02、R=55、B′≈450 反解保本原长 2,959）；
> `maxOutputTokens` 1200→**850 恒定**（不随输入放大，否则与「ρ 越小净收益恒增」反向）；
> `normalizeConfig` 保证 `timeoutMs ≥ finishWaitMs+2000`（缺陷 D，只抬不降，BOOT `configAdjusted` 留痕）；
> 替换结果空白硬断言 `empty-candidate`；新增**纯观测** trace：`birth-window-probe`（免费窗口三时刻）、`birth-econ`（三态判定，只记录不判定）、`birth-condensed.fidelity`（`identifierRecall`，空集标 `unmeasurable` 不算 pass）。
> **v11.7（2026-09-23，第二批）**：TTFB 3 秒的三条正面处置，全部**可关、缺省保守**。
> ① `distill.hedgeAfterMs`（缺省 0=关；建议 3000）：主请求 N ms 内未收到 200 响应头就再发一份相同请求，谁先回头用谁、另一份立即 abort（头一到即取消，输出只付一份）；同一时刻至多 1 份对冲在飞，仅 `maxAttempts ≤ 1` 生效；4xx/5xx 的头不算胜出。trace：`compiler-hedge-fired / compiler-hedge-settled`，`meta.hedged`。最坏情况：尾部请求多付一次输入费（≈0.3K tokens）。
> ② `birth.finishHeadersGraceMs`（缺省 1500）：finish 处 budget 到点但蒸馏**已收到 200 响应头**（排队已结束、正在生成，实测 contentSpanMs 137~1,267ms）⇒ 再多等最多 1.5s；没收到头不加一毫秒。trace：`birth-distill-headers / birth-finish-headers-grace`。最坏情况：单次 finish 多阻塞 1.5s 且仍超时（此时对方已在生成，概率由 contentSpan 分布决定，p90 < 1.3s）。
> ③ `compressSystemPrompt`（缺省 false）：v2/v3 提示词按 `【上一轮思维链】` 拆成 system（规则，字节不变）+ user（原文），让 DeepSeek 缓存前缀单元匹配到规则段（现状 `prompt_cache_hit_tokens` 恒 0）；promptVersion 追加 `:sys` 自动分桶做 A/B。
> 新增套件 `hedge.selftest.mjs`（15 断言，本机 HTTP 可控延迟）。验证：**1222 通过 / 0 失败 / 1 跳过，19 套件**。
>
> `analyze-efficiency.mjs` 新增 `windowProbe / economics / fidelity` 段。验证：**1207 通过 / 0 失败 / 1 跳过，18 套件**。
> ⚠ 判定行为唯一变化 = 门槛与输出上限；动态门槛、保真放行门槛、提前起火**均未接管**，等 trace 数据。

> **当前实现：v11.4（2026-09-23）**。compress PromptVersion 贯通 trace；迟到认领漏斗已在 boot26 真机 trace 命中 10/11；carry 有预算与去嵌套；只在字符估算满足至少 5% 且 100 字符净节省时发射看板，否则保留原文；可选 token-meter 前后采样仅用于诊断。验证套件当前 18 套。
> 这些是代码/单次 trace 事实，不代表每次发射都节省 tokenizer tokens 或模型质量已做 A/B。见 [`docs/CORRECTNESS-V11.md`](docs/CORRECTNESS-V11.md)。
> 下列 v10/v9…段落是对应版本的**历史记录**；其中的开关、待办、套件计数不得当作当前状态。历史套件数按当时记录保留，不做伪造性回写。

> **v10（历史版本记录）：压缩 与 状态记忆 开关切分。**
> 这两件事原本焊在 `stateMemory` 一个开关上：触发粒度是「每段 reasoning」，
> 输入范围却是「整个 60 节点证据窗口」⇒ 每编译 5,371 字符的推理要重发 23,800 字符的窗口证据，
> 实测放大 **7.5x**（工具正文占 58.7%），27 次副编译 0 次替换成功。
> 现在拆成两个独立开关，裁决只在 `resolveCompileMode()` 一处：
> `stateCompress` 只压本段 reasoning，**不采集任何证据**（实测 ratio 1.16~2.0）；
> `stateMemory` 保留证据账本 + 快照 + 两栏判断。
> 见 [`docs/archive/COMPRESS-MEMORY-SPLIT.md`](docs/archive/COMPRESS-MEMORY-SPLIT.md)。
> 当时遗留的 compress 迟到问题已在 v11 接通；压缩率/费用收益仍须按真实 token 用量与任务质量评估。

> **v9：减少无效编译，改善判断交接。**
> 默认路径精确共享相同在途请求；归档终局失败只取消对应消费者；提示词统计与发送复用一次构造。
> 判断保留适用条件、修正原因及待核对旧记忆；新增分阶段时延、请求级缓存用量和人工决策审核入口。
> 见 [`docs/archive/COMPILER-EFFICIENCY-V9.md`](docs/archive/COMPILER-EFFICIENCY-V9.md)。无新增开关或等待预算；真实产品收益仍未验收。

> **v8：保留证据，减少同请求内的重复展示与准备。**
> 相同采集正文按原可见区间取并集，调用身份、状态与完整性仍逐事件保留。
> 批内复用正文 hash 与文件校验；生产和重放共用证据准备入口。
> 见 [`docs/archive/EVIDENCE-SHARING-V8.md`](docs/archive/EVIDENCE-SHARING-V8.md)。真实产品指标仍未验收，无新增开关或等待预算。

> **v7：恢复有依据的判断编译，验证结果真正被消费。**
> 工具正文重新进入默认副编译请求，包含正常结果；不因已落盘而省略核对材料。
> 新增有上限的证据存储、满额后的内存证据回退、认领消费漏斗；四个旧生产开关退役。
> 见 [`docs/archive/GROUNDED-COMPILER-V7.md`](docs/archive/GROUNDED-COMPILER-V7.md)。
> **不承诺未经真实重放证明的性能／压缩率不下降。v6“工具正文跨轮零重发”的取舍已撤回。**

> **v6：确定性证据记录＋两栏判断编译（历史）**。用户现有 `birth + stateMemory:true` 路径直接切换，无新开关。
> 工具原文先落盘，失败不再触发旧正文全量重发；finish 只采用已就绪结果，不主动等副模型。
> 方案、代价与重放方法见 [`docs/archive/HYBRID-COMPILER.md`](docs/archive/HYBRID-COMPILER.md)。
> **真实产品指标尚未验收**：完整会话、主模型探索标注和运行凭据未提供。本地回归不能替代这些指标。

> **v5：迟到认领加固**，见 [`docs/archive/LATE-CLAIM-HARDENING.md`](docs/archive/LATE-CLAIM-HARDENING.md)。
> 当批验证：1088 通过、0 失败、1 跳过，13 套件。新增分支隔离、歧义拒绝、发射前复检及缓存体量限制。

> **统一优化版 v4**：范围回执、编译输入工作集、后台 CAS 镜像／恢复与故障门禁已接线。
> 见 [`docs/archive/OPTIMIZATION-INTEGRATED.md`](docs/archive/OPTIMIZATION-INTEGRATED.md)。
> 当批验证：1073 通过、0 失败、1 跳过，12 套件。
> 新策略 `stateEvidenceViews` / `stateSnapshotMirror` 默认关闭；配置、代价和真机验收边界见报告。
> 历史报告中“CAS 尚未接通”等描述仅适用于当时版本；不代表 v4 源码状态。

> **第三批更新：安全覆盖修复＋增量编译通道实验**，见
> [`docs/archive/OPTIMIZATION-PHASE3.md`](docs/archive/OPTIMIZATION-PHASE3.md)。
> 当批验证：1032 通过、0 失败、1 跳过，11 套件。
> 新实验 `stateCompileQueue` 默认关闭；policy 3 不再把截断工具结果整条标成已覆盖。
> policy 1/2 升级保留正文、重新积累覆盖，短期输入可能增加。

> **第二批更新：记忆可信度与执行隔离**，见
> [`docs/archive/OPTIMIZATION-PHASE2.md`](docs/archive/OPTIMIZATION-PHASE2.md)。
> 当批验证：1003 通过、0 失败、1 跳过，10 套件。
> 旧快照正文保留；旧覆盖集合需要通过新编译重新建立，迁移初期输入可能增加。

> **第一批优化记录（2026-09-22）**：当时的变更、验证与待办见
> [`docs/archive/OPTIMIZATION-REPORT.md`](docs/archive/OPTIMIZATION-REPORT.md)。
> 本轮不改等待预算、模型、输出上限或 surface 替换协议；未部署到真实网关。
> 第一批时快照只有本地原子文件存储；v4 已另行接通可选 CAS 镜像及后台恢复。
> 现有下文的历史设计说明不应被当成这些能力已经上线的证明。

