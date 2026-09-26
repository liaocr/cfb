# Changelog — dsh-cot-form-b

> 最新在上。每条的验证数字、开关与待办都是**当时**的记录，按原样保留、不回写；现状以最新条目和 README 为准。
> 详版报告在 `docs/` 或 `docs/archive/`（索引见 [`docs/README.md`](docs/README.md)）。

---

## v11.12.1（2026-09-26）提升主模型表现的第四轮调研（**仅文档，代码与缺省值零变化**）

- 新增 [`docs/RESEARCH-PERFORMANCE.md`](docs/RESEARCH-PERFORMANCE.md)：从「推理保留 / 离策略代价 / 去噪 / 历史中的错误 / 想太多想太少 / 状态与复述 / 可逆性」7 个角度调研 30+ 篇来源。
- 核心判断：表现 = 去噪收益 − 离策略代价 ⇒ 逐字抽取（x1）在表现上应优于改写式摘要（v3），待 `cf-eval` 验证（H1）。
- 排序方案：P1 死分支折叠（`refuted` / `abandoned` / `parked`）· P2 失败信号强制保留 · P3 按块类型自适应保留比例 · P4 状态行去重 ·
  P5 句柄取回率闭环 · P6 cf-eval 过程指标（loopRate / rederiveRate / 配对 bootstrap）· P7 勘误写法。均**未实现**。
- `docs/README.md` 索引加一行。

---

## v11.12.0（2026-09-25）抽取式压缩 compress-x1 + 反事实续写评测 + 准则自进化回路（**缺省关闭，线上零变化**）

设计与论文依据见 [`docs/RESEARCH-COT-SHAPING.md`](docs/RESEARCH-COT-SHAPING.md) §10。

### 新增
- **`src/extractive.js` — `compressPrompt: 'x1'`（抽取式）**：副模型不写摘要，只回 JSON 选择（句子编号 / `verified|refuted|unverified` 标签 / 状态变量 / 块类型），
  正文由本地从原文**逐字**拼装：开头计划句 + 按原文顺序的锚点句（行内认知标签）+ `[状态] k=v` 行 + 空行 + 逐字尾巴。
  硬校验：「证实/否定」必须在所引 seq 的工具结果里逐字找到引用，否则只降级；状态值必须逐字出现在原文或用户输入里；
  explore 块的转折句强制保留；逐字标识符全部丢失时补回含它的句子（上限为 min(6, 15% 句数)）；拼装稿超过原文 0.7 按失败处理（原文放行）。
- **birth 接线**：仅 x1 在 block-end 冻结最近 12 条工具结果供标签核对（发给副模型的只是每条 ≤160 字符的索引行）；
  流归属不可证（`sessionAmbiguous`）时不采集，标签全部降级。句柄**已验证**后首行写 `〔原文 art://… · 删去的句子可按句柄取回〕`，计入净省核算。
- 新配置键（仅 x1 生效）：`extractiveTailChars` 400 · `extractiveMaxKeepRatio` 0.7 · `extractiveRepairMax` 6 · `extractiveEvidence` true ·
  `extractiveEvidenceLimit` 12 · `extractiveHandleLine` true · `extractiveGuideline` ''。promptVersion `compress-x1`，准则非空时带 `:g<8 位指纹>`。
- 新 trace：`extractive-evidence` / `extractive-assembled` / `extractive-rejected` / `extractive-evidence-error`。
- **`tools/cf-eval.mjs` 反事实续写评测**：同一会话前缀，分别用 raw / v3 / x1 推理块续写，按 next / avoid / violate 判分，
  并记录 promptTokens、completionTokens、reasoningChars、keptRatio、fallback。直接复用 `src/` 的提示词与拼装代码。示例 fixture：`tools/cf-fixtures/example-await.json`（合成）。
- **`tools/acon-optimize.mjs` 准则自进化**：ACON 对比失败分析（UT 步）/ 求更短（CO 步）+ GEPA 式候选评测，`score = success − λ·keptRatio`，
  只收改进，并保留 Pareto 前沿。产物不会自动上线。
- `index.js` / `index.d.ts` 导出抽取式纯函数；`compressPrompt` 类型加 `'x1'`。

### 不变
- `DEFAULTS.compressPrompt` 仍为 `'v2'`；非 x1 的 compress 仍**不采集证据**（新增测试钉住）。
- `birthFinish` 里保真观测改为对最终候选（含句柄行）计算；非 x1 路径候选与此前逐字相同。

### 验证
`npm test` 1342 通过 / 0 失败 / 1 跳过（26/26 套件，新增 `extractive` 34 条，全部本机、零外网）；`tsc --strict` 通过；`node manifest.mjs` 已重新生成。
**尚未**用真实 CAS 原文跑 cf-eval。上线门槛：x1 successRate ≥ raw 的 95%，且 avoidRate 不高于 raw。

---

## v11.11.2（2026-09-25）可改写思维链的表现提升调研（**仅文档，无代码改动**）

新增 [`docs/RESEARCH-COT-SHAPING.md`](docs/RESEARCH-COT-SHAPING.md)，并登记进 `docs/README.md` 索引。
问题：cfb 能在出生时改写 reasoning，而且宿主压缩被推迟、信息留存更久——这时怎样改写，才能让主模型更专注、更有底气、想得更全？

### 主要结论
- **杠杆真实存在**：DeepSeek 带 tools 的请求会把历史 `reasoning_content` 全部拼进上下文；MiniMax 消融实验显示，
  保留与丢弃历史思维链，Tau² 差 87 vs 64。cfb 应重新定位为主模型的**记忆写入控制器**，不只是压缩器。
- **上一轮否决路线 B 的理由（ReasonIF）在这里不适用**：文本由我们来写，不需要模型配合。Thinking Intervention 证明，写进思考过程的文字远比写进提示词有效。
- **双声道原则**：第一人称会加固信念（看得见自己的答案时，改主意的比例从 32.5% 降到 13.1%），用于有证据的事实与计划；
  外部声音会动摇信念（对反对意见的权重是贝叶斯理想值的 2.58 倍），用于有证据的纠错。没有证据的质疑是煤气灯（准确率掉 25–29%）。
- **首推「认知卫生」三件套**：S1 认知状态标注、S2 按句子功能保留思维锚点（与路线 E 合流）、S3 勘误随下一块出生。均不违反 H2。
- **legacy 提示词（等同 compress-v1）的「严禁软性措辞」「删掉自我怀疑」与证据方向相反**，建议正式标为不推荐。
- **主要风险是示范效应**：历史思维链也是推理风格的示范，可能导致模型想浅或跳过思考。必须监测新生成思维链的长度与质量。
- **评估**：提出不依赖真实会话重放的「反事实续写重采样」方法；上线任何方案前必须先有它。

### 验证
`npm test` 1308 通过 / 0 失败 / 1 跳过（25/25 套件），与 v11.11 基线一致。`node manifest.mjs` 已重新生成。

---

## v11.11.1（2026-09-25）压缩经济性审计与路线决议（**仅文档，无代码改动**）

新增 [`docs/ECONOMICS-V11.11.md`](docs/ECONOMICS-V11.11.md)，并登记进 `docs/README.md` 索引。
**结论上取代 `AUDIT-V11.5.md` 的成本模型部分**；后者按「只追加不回写」保留原文，更正写在 §6.1。

**验证**：`npm test` 1308 通过 / 0 失败 / 1 跳过（25/25 套件），与 v11.11 基线一致。
文中每个数字都用 `node` 重算过一遍，**改掉了两处自相矛盾**（见下）。`node manifest.mjs` 已重新生成。

### 口径变更
- **不再使用用户会话的缓存命中数据**（第三方接入，不可信）。一律按 Harness 官方默认：
  `thresholdRatio 0.8` / `retainRatio 0.16` / 压缩 `maxTokens 8192` / cache-replay 摘要器，定价 d=0.02、输出 4×。

### 主要结论
- **按官方参数重算，cfb 当前设计净亏**：单次宿主压缩 `C ≈ 34k~45k` token，262k 会话下 cfb 多花 **+1.5%~+4.3%**。
  只有 `maxTokens=16384` + thinking on（C ≈ 70k）才转正。
- **单块收益存在数学天花板 `净 ≤ 0.5·r − 4·o − T`**。原因是原文是新生成内容、副模型首读**不命中缓存**，
  按全价 1× 计费 ⇒ 成本至少 `r`、收益上限 `1.5r`。**压缩率优化改变不了这个上限。**
  `r = 1075`（实测均值）时天花板仅 **≈ 390 token**。
- 当前设计回本线 **`r ≥ 11·o + 2·T ≈ 3635` token**；实测均值 1075 ⇒ 每块净亏 **1,280 token**。

### 路线裁决
- **否决 确定性抽取**（用户判断：非大模型无法理解语义；且召回率指标用同一提取器度量属自证）。
  仅保留为失败降级路径。
- **否决 主模型自写摘要**：ReasonIF 基准显示推理模型在思考过程中的指令遵守率 **< 25%**（放最终回答里 57.3%，
  要求思考里按 JSON 写则 **0**），且越难的题遵守越差；"Let Me Speak Freely?" 显示格式限制会降低推理能力。
  此前「占 15%」是假设值非实测，特此更正。
- **否决 跨轮批量**（**推翻上一轮的建议**）：批量摊薄每块只多赚 ≈ 80 token，
  而等 3 块再压造成的延迟衰减每块亏 ≈ 860 token，**净 −780**。
- **保留 语义选句**（模型只输出保留句的序号、本地 `slice()` 原样拼接）：零幻觉、损失可计算、
  可用 `fidelity.js` 做**硬门控**（缺标识符即放弃压缩）。**先做离线评估，不接线上。**
- **保留 副模型只压大块**：经济上唯一明确盈利（10k 块净 +3,183），但实测均值 2,763 字符 ⇒ 覆盖率不足。

### 写文档时自查出的两处错误（已在文中改正）
- **chars/token 自相矛盾**：文中同时写了 `r=1075 token = 2,763 字符`（⇒ 2.57）和「实测 1.67」。
  查 `AUDIT-V11.5.md` 确认两个数字**都不在该文件里**，1.67 实为 DeepSeek 官方对**中文字符**的估算（0.6 token/字），
  不是实测。**仓库内无 trace.log，无法裁定**，已列为阻塞项——它决定回本门槛是 6,070 还是 9,342 字符。
- **副模型 1/5 定价的收益**：原写 +641，漏加模板 T；实为 **+633**（成本 486，非 478）。

### 新增阻塞项
chars/token 实测值、`rawChars` 分布、归档失败率 ≥ 28% 的成因（铁律③依赖归档成功）。
`AUDIT-V11.5.md` 建议的 `birthMinChars` 3K 已执行，但**在两种口径下都仍低于回本线**。

---

## v11.11（2026-09-24）并发正确性、Responses 协议测试、token 校准链路、plugin.js 拆分

**验证**：1308 通过 / 0 失败 / 1 跳过，**25 套件**（新增 `concurrency` 13、`protocol` 15、`branches` 14）。
`npm test` 墙钟 **14s → 8.5s**。行覆盖 97.0% → **98.5%**（`evidence.js` 分支 62% → 84%，`transport.js` 行 85% → 98.5%）。
关键修复均做过变异验证：换回 v11.10 的 `plugin.js` / `evidence.js`，对应测试必挂。

### 修复
- **checkpoint early-fire 用错模型**（已由测试复现）：followHostModel 看到新模型就改写共享 `cfg.model`，而 early-fire
  在**流被消费时**才读它 ⇒ A 流开 → B 流开（换模型）→ 消费 A ⇒ A 的提前调用用了 B 的模型。
  新 `host-follow.js`：每次 `llm/stream` 派生**调用级**配置，共享 `cfg` 永不改写（不变式 12）。
  birth 路径此前在同一同步调用里就复制了配置，**不受影响**（上一轮报告里「birth 可能用错模型」的说法不准确，特此更正）。
  预热同样改为跟随本次调用的 provider（`prewarm(why, callCfg)`）。
  顺带：只见过模型、没见过 provider 时，旧实现会把显式 `followProvider` 覆盖成 null；现在保留显式值。
- **流归属交错**（新 `session-tracker.js`）：宿主的 `llm/stream` 不带会话，旧实现用全局 `birthSessionId`（pre-step 写、流读）。
  A.pre → B.pre → 开流时，A 的块会登记到 B（CAS 挂错会话；memory 模式还会把 B 的证据喂给 A 的摘要）。
  现在维护「已 pre-step、未开流」窗口：出现 ≥2 个会话 ⇒ 不可证 ⇒ 缺省**原文放行**（`birthSessionAmbiguity:'passthrough'`，
  可设 `'latest'` 回到旧行为），留 `birth-session-ambiguous`。单会话宿主永不触发。
  ⚠ 这是检测器不是证明：抓得住交错形态，抓不住所有误归属；假阳性代价 = 偶发一块原文放行（测试 §3e 钉住）。
  根治需要宿主在 `llm/stream` 里带会话。
- **`manifest.mjs` 会把 gitignore 掉的生成物收进清单**：本地量过覆盖率（`coverage/`）再 `npm run manifest`，清单里就多出几十个
  本地文件，干净的 CI 检出里它们不存在 ⇒ `--check` 必挂。现在跳过 `coverage/`、`.nyc_output/` 等生成物目录。
- **`collectEvidence` 在索引构建抛错时整体抛出**：回退扫描分支因此不可达。现在索引失败即走回退扫描（`evidence.js`）。

### 新能力
- **token 估算校准链路**：compress / legacy 模式的成功结果记录 `prompt/output{Wide,Other}Chars`（只有数量），进 settled 白名单；
  `analyze-trace` 每组新增 `tokenCalibration`：对 provider 自报 usage 做最小二乘 `tokens ≈ 中文·W + 其他·O + C`，
  输出拟合系数、现行 0.6/0.3 的偏差与误差对照；产物侧扣除思考 token；样本不足 / 单一书写系统 / 共线时不给该维度（不猜）。
  memory 模式提示词在内部拼装，不产生样本。
- `analyze-trace` 的 birth 漏斗计入 `session-ambiguous`。

### 测试
- **Responses 协议首次有功能测试**（此前只测了 URL 拼接）：completed / incomplete / failed / 缺 status / 仅顶层 output_text /
  reasoning 不混入摘要 / `reasoning.effort` 被拒后降级重试 / 非流式收到 SSE / 流式 completed / incomplete / 断流。
  结论：该路径的完成判据是对的（半成品一律抛错 ⇒ 原文放行），未发现缺陷。
- 分支补齐：跨窗口结构性证据（opt-in）的逐类上限与时间序、覆盖判据四形态、预热节流 / 非 2xx 永久停用 / 连不上、消费计量、token 非串输入。
- `hedge` 套件提速（13.8s → 7.6s）：「慢的那份必须被 abort」改为直接观察服务端连接提前关闭，不再等它的延迟跑完；
  「不得发生」的断言仍真实等过计时器（改用更短的计时器）。

### 重构
- `plugin.js` 618 → 188 行，只做接线：`boot-record.js`、`host-follow.js`、`session-tracker.js`、`birth-claim.js`、
  `checkpoint.js`、`handle-probe.js`（`mkHandleProbe` 从 `src/plugin.js` 的旧导入路径仍可用）；
  `streamProvenanceRecord` 移入 `messages.js`。搬移部分逐字不变（脚本切割），全部既有测试不改即通过。
- `index.js` 新导出 `scriptCounts`、`createHostFollower`、`createSessionTracker`；`index.d.ts` 同步（`tsc --strict` 通过）。

### 刻意未做
- `hybrid` 套件（约 8s，现为墙钟下限）里那条「REAL default hooks: 8000ms timeout」故意跑生产缺省超时，缩短会改变测试本意。
- memory 模式三个存储文件的同步 I/O：缺省 birth 模式不走这些路径；等 memory 模式要上线再改。
- `birth-claim.js`（实验路径，缺省关）的部分认领与归档失败分支仍未覆盖（行 85%）。

---

## v11.10（2026-09-24）全面加固：取消泄漏、token 闸门、死锁接管、trace 有界、测试并发、CI

**验证**：1266 通过 / 0 失败 / 1 跳过，**22 套件**（新增 `hardening` 40 条；`core` §10 新增 5 条默认值钉子）。
`npm test` 墙钟 **36s → 14s**（并发 + 慢套件先跑）。关键修复均做过**变异验证**：换回旧实现后对应测试必挂。

### P0
- **取消泄漏**（`birth.js`）：此前只有「finish 到点」这一条放弃路径会取消在飞提纯；**硬停（error/aborted/length）、
  源流结束却没有 finish、源流抛错、消费者提前退出（用户取消）** 四条路径都会让副模型白跑到 `timeoutMs` 并白付费。
  现在全部经由唯一实现 `birthCancelFlying`（已导出），并分别留 `birth-flush`（`why=hard-stop:<kind>|no-finish|source-error`）
  与 `birth-consumer-return` trace。迟到认领打开时尊重它；消费者提前退出除外（块从未出站，不可能被认领）。
- **`birth.probeTimeoutMs` 进了 `unknownOptions`**（`config.js`）：d.ts 与注释都写了嵌套写法，但 `NESTED_BIRTH_KEYS` 漏了它 ⇒
  配置静默无效。已登记；新增嵌套键 `minTokens` / `tokenGate` / `minSavedTokens`。
- **崩溃残留锁永不释放**（新 `src/fs-lock.js`）：`snapshot-store` / `evidence-ledger` / `evidence-storage` 三处锁文件此前为空，
  进程崩溃后锁永远 busy ⇒ memory 模式永久降级。现在锁文件写 `pid@hostname@ms`，**只在同机且 pid 已不存在（ESRCH）时**接管；
  活进程、别的机器、旧格式/空锁一律照旧 fail-closed，**不按年龄抢锁**。`lockStats()` 已导出。
- **字符门槛 ≠ token 门槛**（新 `src/tokens.js`）：3100 字符对英文 ≈ 930 token、对中文 ≈ 1,860 token；中文摘要替换英文推理时
  字符净省为正但 token 可能反而变多。新增 **token 闸门**（缺省开，`why=no-token-gain`）与 opt-in 的 `birthMinTokens`。
  估算口径取 DeepSeek 官方：中文 0.6/字、其余 0.3/字 —— **只用于拒绝，不用于宣称节省**；trace 新增 `*TokensEst` 字段。

### P1
- **trace 有界**（`trace.js`）：`traceMaxBytes`（64 MiB）轮转到 `.1`；新文件首行 `trace-rotated` + `BOOT` 副本（`rotatedCopy:true`）。
  大小在内存累加，不再每行 stat。`analyze-trace` 识别轮转元信息、不另开组。
- **用户正文片段**：`tracePreviewChars`（缺省 48 = 原先写死的值，行为不变；现在可调，0 = 不留任何正文）。
- **`llm-stream` 体积 O(n²)**：`roles` 改为游程字符串（`system user assistant tool*3`），`reasoningChars` 改为稀疏 `[[下标, 字符数]]`。
  ⚠ 字段**形状变了**（仓库内无消费者；外部脚本若按数组读需要跟进）。
- **provider / 凭据热路径同步重解析**（`provider.js`）：按文件身份（ino/size/mtime/ctime）缓存，文件一变即重读；
  只缓存成功结果与单个键值（不常驻整份凭据）；返回副本。`clearProviderCache()` 已导出。

### P2
- `plugin.js` 的 `deps.distill` 三元内联抽成 `distill.js` 的 **`makeBirthCompiler`**（已导出、有真实 HTTP 单测）。
- 隐藏默认值显式化进 `DEFAULTS`（`staticMinRawChars` / `econCharsPerTurn` 等）；**`birthHandleInText` 退役**
  （2026-09-18 起已无任何效果）——出现即进 `retiredOptions`。
- `index.js` 新导出：`estimateTokens` `wideShare` `makeBirthCompiler` `birthCancelFlying` `lockStats`；`index.d.ts` 同步（`tsc --strict` 通过）。

### P3 工程
- `verify.mjs` 并发（缺省 `max(6, CPU 数)`；`-j N` / `--serial`；结果仍按 ORDER 打印；JSON 带 `jobs`/`wallMs`；单套件 300s 看门狗）。
- `.github/workflows/ci.yml`：Node 20/22 × 清单校验 + 全部自测 + 类型契约。
- `analyze-trace` 每组新增 **`birth`**：结局漏斗与 **`needWaitMs`**（真工期 − 免费窗口，按 taskId 关联）分位数、
  当前 `finishWaitMs`(+宽限) 覆盖率 —— `finishWaitMs` 该取多少从此有数据可依（取值仍是产品决定）。
- README / ARCHITECTURE / INSTALL 去掉写死的测试数字（只在本文件按版本记录）。

### 刻意未做（原因见各条）
- 按模式懒加载实验模块：`plugin.js` 顶层与三种模式的交叉引用较深，拆开收益小、回归面大。
- 从 stream options 取 session/model 取代全局 `birthSessionId` / 共享 `cfg.model` 改写：宿主 API 未确认，不猜。
- 流式期间分段压缩、退役 memory/legacy 模式：产品决策，不在工程加固范围。
- trace 异步缓冲写：大量测试与离线工具依赖「写完即可读」的同步语义。
- 自动恢复旧格式 / 空锁文件：无法证明持有者已死，按 fail-closed 保留（README 写明人工处理方式）。

---

## v11.9.1（2026-09-24）P1 工具结果可检索化 + 钩子级端到端测试

**验证**：1219 通过 / 0 失败 / 1 跳过，**21 套件**（新增 2 套：`checkpoint-hooks` 7 条、`hook-wiring` 5 条）。
覆盖率（c8 实测，source-map 到源码）：`plugin.js` 84.21% → **95.8%** 行 / 64.24% → 70.6% 分支；
`emitter.js` **98.64%**；`birth.js` **98.28%**。

### P1 工具结果可检索化（`emitter.js`）

**问题**：归档行此前只有 `[工具结果 seq=N · X 字符 · 原文 art://…]` —— 没有工具名、没有调用参数、没有内容样本
⇒ 模型看到一排句柄**无从判断哪根有用** ⇒ 只能整块回读。而按保本算术，回读一次的代价 ≈ 把整块原文按全价重新
吃回上下文（一次性抵消约 50 轮 × 0.02 的缓存收益）⇒ **回看概率比压缩率更决定胜负**。

- 每条归档的工具结果后附一段富化视图（**独立成段**）：`↳ 工具 bash · 参数 {…} · 类别 recent` +
  `↳ 样本 <单行、限长>` +（选择性）`↳ 摘录（原文 N 字符，错误行 + 上下文 / 头尾）`。
- ⚠ **格式约束**：句柄行必须**单独成段且逐字不变** —— `flattenCarriedBoard()` 只保留「单行且含 `· 原文 `」的段，
  把样本挂进同一段会在旧看板被吞并时**连句柄一起丢掉**。有回归测试专门钉住这条。
- **选择性**：`error`（isError 标记，或**头尾 3500 字符内**出现错误特征 —— 中间夹一句 `error` 不算）⇒
  附「**错误行 + 上下文**」摘录（不是头尾截断：错误现场几乎总在中部，头尾截断会正好把唯一有价值的行挖掉）；
  `dump`（低熵：重复行占比 <15%，或超长单行）⇒ **不给摘录**（摘录一坨重复行 = 白花预算）；
  `recent`（区间内最后 N 条）⇒ 头尾摘录；`plain` ⇒ 只给样本。
  判定顺序：error → **dump → recent**（dump 必须排在 recent 前）。
- 新键：`emitterSelectiveArchive`(true) / `emitterToolSampleChars`(120) / `emitterExcerptChars`(800) /
  `emitterKeepRecentToolResults`(2)；全部进 BOOT。**归档一律仍然原文**（信息不丢铁律不动）。
- 代价可审计：`ledger-built` 增 `enrichChars / enrichParts / excerpted / errorSeen / dumpSeen /
  toolResultLensMax / toolResultBuckets`（`<2K / 2–8K / 8–32K / >32K` 四桶直方图，用于标定
  `maxInlineToolResultChars`）；`emit-net-savings` 增 `enrichChars / netSavedIfHandleOnly`
  （净收益已扣富化代价，上界单列 ⇒ A/B 能归因「花的视图预算买到了什么」）。
- 工具名只在调用侧（`tool-call` 块）⇒ 新增 `toolCallsFromSpan()` 建立 `toolCallId → {name,args}` 索引；
  形状不认识一律跳过（**不猜**：猜错的名字比没有名字更坏）。

### 钩子级端到端测试（新增 2 套）

此前 `plugin.js` 的接线**没有任何测试钉住**（emitter 的单测直接调纯函数，绕过了钩子入口）。现在：

- `test/checkpoint-hooks.selftest.mjs`：**真实 HTTP 夹具 + 真实钩子入口**，7 条。覆盖全链路
  （llm/stream 触发 early-fire → agent/pre-step 收网 → 合规 `replace` 发射），并逐条断言：
  ① 工具配对平衡（区间左端=目标 assistant、右端=配对的 tool/result、绝不越过真人 user）；
  ② 活跃尾部永不被遮蔽；③ 真人原话与归档原文都不许消失；④ 评估态零 CAS 写入 / 零表面改写；
  ⑤ **读回闭环**（文本里的句柄必须能按同 session 读回原文；**跨 session 读不回 ⇒ 拒发**，真机约束在夹具里同样成立）；
  ⑥ 形状不认识 ⇒ 整块拒发；⑦ 提纯终局失败 ⇒ 不发射且原文逐字不变。
- `test/hook-wiring.selftest.mjs`：5 条，专打「只有出错才会走到、于是从来没人走过」的分支：
  服务获取抛错只降级不阻断、坏形状不包装（原样返回同一个对象）、CAS 写入抛错 ⇒ 原文逐字放行、
  **主流自己的错误原样抛出**（插件只许降级自己）、birth 评估态零改写零写入。

### 其他

- `.gitignore` 增 `coverage/`（c8 产物不进包）；`MANIFEST.sha256` 重新生成（122 个文件）。
- `README.md` / `docs/ARCHITECTURE.md` 同步新键、新套件与「评估态零副作用 / 地址必须可读回」两条不变式。

### 验收口径工具化（`tools/analyze-trace.mjs`）

真机 A/B 不再需要人肉算表：`npm run trace:audit -- trace.log` 输出 `toolResultPath`，即判据本身。

- **净下降只算真正发射的尝试** —— 同一 `emitAttemptId` 在闸门/重算/结果三处各落一条，取**最后一次**读数；
  被闸门拦下的尝试既没省上下文也没改表面，不得计入收益（有回归测试钉住"不得重复计数"）。
- `breakeven.fullReadBacksAffordable` = 净下降 ÷ 归档条目均长 ⇒ **还能整块回读几次，超出即亏**；
  这是「净下降 − 读回成本 > 0」的可读数形式（宿主侧回读次数本机看不到，故给预算而非常量）。
- 同时给出 `enrichShareOfSaving`（P1 富化代价占收益比）、`archive.rechecks`（归档失败真实发生过的证据）、
  `handle.*` 三态分布、`lens.buckets` 四桶直方图（标定 `maxInlineToolResultChars` 用）。

### 仍然做不到（要真机才能收的）

- 句柄**读回成本**与**回看概率**只能在真机采；本轮的 `netSavedIfHandleOnly` 只是给了归因口径；
- 探针在真机上的语义（读 API 抛错是否等价于「查无此记录」）仍需小流量 A/B 用真 trace 标定；
- `mode:'search'/'lines'` 的细粒度回读（几百 token 而非整块）依赖宿主侧 `inspect_artifact` 的行为，本机无法验。

---

## v11.9（2026-09-24）评估态零副作用 + 句柄读回验证

**验证**：1162 通过 / 0 失败 / 1 跳过，19 套件（跳过项同前：T13 需要宿主兄弟包 `dsh-context-memory-bundle`）。
新增回归 60 条：emitter 43（P0-1 两阶段组装 / 句柄卫生 / 三态读回验证 / 全链路零副作用）、birth 10（T34 句柄可归因）、
robustness 7（句柄探针契约）。

### P0-1 评估态零副作用（`emitter.js`）

**问题**：`buildLedger` 边渲染边落盘 ⇒ `no-net-savings` / `stale-distill` / `dryRun` 三条**提前返回路径**
都先把工具结果原文写进了 CAS 才被闸门拦下；`dryRun` 还是缺省值 ⇒ 出厂评估态就在持续污染生产 CAS 配额。

- **两阶段组装**：`buildLedger({ planOnly: true })` 零 I/O 出计划 —— 该归档的项换成**与真机同长的占位句柄**
  （`HANDLE_PLACEHOLDER` = `'art://'` + 22 位，共 28 字符，与 `deriveArtHandle` 同式）。
  于是「闸门看到的字节数」≡「真机发射的字节数」，净收益判定整体挪到**任何一次 CAS 写入之前**。
- `commitLedgerPlan()` 按计划顺序写真 CAS，再用**同一个** `buildLedger` 回填真句柄（渲染只有一条路径，形状不会分叉）。
  归档失败的项原文回退内联 ⇒ 看板变长 ⇒ `runPreStepEmit` **重算闸门**（`emit-net-savings-recheck`，
  拒绝原因 `no-net-savings-after-archive`），并在落盘后复检一次 `validatePending`。
- **句柄卫生** `usableHandle()`：非字符串 / 空 / 带换行 / >96 字符一律**当归档失败**（原文内联）。
  死指针是本架构唯一的静默失败模式，宁可不压也不写坏。
- 可观测新增：`emit-archive-simulated`、`ledger-archive-commit`、`emit-net-savings-recheck`；
  `ledger-built` 增 `toolResultItems / toolResultLens / archivePending`（逐项长度分布，用于标定
  `maxInlineToolResultChars`）；`emit-net-savings` 增 `usedTokens / usedTokensSource / archiveMode`；
  `emit-net-savings-result` 增 `casWrites / casWriteChars / archiveSimulated`。

### P0-2 句柄读回验证（句柄是唯一会进模型上下文的地址）

写成功 ≠ 读得回（跨 session 所有权校验 / 配额驱逐 / TTL / 公式漂移）。读不回 = 模型侧一根永远打不开的指针，**静默**。

- **`emitter.verifyHandles()`**：发射前抽样按句柄读回（`emitHandleProbeMax`，缺省 2）。三态：
  `true` 有正面证据能读回；`false` 有正面证据读不回；`null` 不可证（无读 API / 超时 / 抛错）。
  **只有正面证伪才拦住发射**（`handle-unresolvable` ⇒ 保持原文）；不可证只落 trace，不误伤正常发射。
- **birth 句柄可归因**：store 回给的句柄是权威（`store-returned`）；`task.handle`（`deriveArtHandle` 内存预推）
  只是**预测**，必须 `deps.probeHandle` 给出正面证据（`derived-verified`）才允许当句柄用；
  否则按 `handle-unverified` 原文放行。限时 `birthHandleProbeTimeoutMs`（缺省 800ms），超时=不可证。
  依据：T13 的「本机推导 ≡ 兄弟包推导」等价测试在同机没有兄弟包时**整条跳过**（本机即跳过状态）。
  调用点只在「store 说成功却没给句柄」这条罕见分支，不给主流加延迟。
- **`plugin.mkHandleProbe()`**：读回探针。先用一根**必然不存在**的同形句柄做受控探针，确认失败信号可信，
  才把抛错当证伪（否则读 API 签名不符会误伤所有发射）；控制结果缓存，不进常规路径。

### 其他

- 成本模型 `R` 回落值 **55 → 60**（2026-09-24 用户拍板；`d=0.02` 已在用）。保本原长 2,959 → **2,747**，
  `birthMinChars` **不下调**（仍 3100）：实测 token/账单未到手前不放松闸门；运行期观测只用于校验模型假设。
- `index.d.ts` / `README.md` / `docs/ARCHITECTURE.md` 同步新增键与两条不变式（评估态零副作用、地址必须可读回）。
- 读取口径：净收益行的 `usedTokens` **复用**开头那次 `readPressure`，不再多读一次 `tokenMeter`
  （字符 ≠ 钱；评估态也需要一个真 token 锚点，但绝不多花读数）。

### 已知边界（诚实）

- 以上全部是**本地自测**：读回探针在真机上的行为（尤其「抛错是否等价于查无此记录」）仍需小流量 A/B 用真 trace 标定；
- 句柄读回的**成本**（每项平均读回一次 ≈ 一次全价前缀）尚未计入净收益判据，回看概率与本机分布仍缺实测。

---

## v11.8（2026-09-24）整理、缺陷修复与默认值收敛

**验证**：1102 通过 / 0 失败 / 1 跳过，19 套件（跳过项同前：T13 需要宿主兄弟包）。
测试数变化：v11.7 的 1242 → 新增 7 条缺陷回归 → 删除 150 条只测已删除功能的用例 → 新增 3 条（T18a-3、24.16、24.17）。

### 默认值变更（BOOT 可见，均可回退）

| 项 | v11.7 | v11.8 | 回退 |
|---|---|---|---|
| `mode` 缺省 | `'distill'` | `'birth'`（`dryRun` 仍缺省 `true` ⇒ 合闸前零调用零改写） | 显式写 `mode` |
| `birthDeferredClaim` 缺省 | `true`（且不写该键即视为开） | `false`，只认显式 `true`；打开时 BOOT `birth.experimental: true` | `birthDeferredClaim: true` |
| 非法 `mode` | 回落 `'distill'` | 按 `'off'` 处理并记 `invalidMode` | — |
| `timeoutMs` 自动抬高 | `≥ finishWaitMs + 2000` | `≥ finishWaitMs + finishHeadersGraceMs + 2000`（宽限也会被请求超时杀掉） | 显式给足 `timeoutMs` |

`birthDeferredClaim` 改为 `false` 依据 `docs/AUDIT-V11.5.md` §四 建议②（与线上配置一致；late-claim 的缺陷 B 在关闭时休眠）。

### 退役与删除

- **`mode: 'distill'` / `'rules'` 退役**：两者唯一的写回路径（事后以 `assistant/message` 充当 replace 载体）被宿主 `surface.js:207`
  永久禁止，trace 恒为 `replace-refused-h2`；`distill` 还会在缺省 `dryRun` 下照样发起副模型调用（白花钱）。配置里出现时按 `'off'` 处理，记 `retiredMode`。
  删除：pre-step 事后改写链（`handleBlock` / `applyRules` / `appendReplace` / `flushPendingEmit`）、`agent/request` 钩子、H2 `locked` 集合、
  骨架化、原话注入、保本不等式等 15 个仅此路径使用的函数、规则引擎 `compressByRules`（`rules.js` 更名 `fidelity.js`，只留保真度核算）。
  随之退役的键进 `retiredOptions`：`hurdleRounds`、`templateChars`、`maxVerbatimChars`、`skeleton*`、`rules*` 与整个 `rules:` 容器。
- **v7 已退役开关的残留实现**：删 `evidence-views.js`（`validReceipt` 迁入 `snapshot-store.js` 以兼容旧快照字段）、`compile-lane.js`、
  birthStart 里的证据视图 / 编译排队 / 快照镜像分支、`rebaseCompileEnvelope`。
- **cover.json 覆盖水位**（`markCovered` / `coverWatermarkOf` / `coverSnapshotOk` / `coverVersionOf`）：无生产调用方，删除。
- 每行 trace 不再附 `stats` 计数器（只在已退役的 distill 路径里递增，birth 下恒为 0）。
- 删除的代码可从提交 `e818cff`（本轮删除前的最后一个提交）取回。

### 缺陷修复（均附回归测试，旧代码上失败）

- 对冲：主请求已结算（成功或失败）后计时器不再发出对冲；主请求先失败时立即按主错误结算（此前会白发一次对冲并推迟降级）。
- compress / legacy 模式的传输与对冲 trace 缺失（`compiler-transport-*` / `compiler-hedge-*` / `compiler-retry-skipped` 全无）：闭包现在透传 trace；
  刻意不传 flights（这两种模式没有 scope，共享永不命中，反而会把取消路径的传输 meta 换成合成错误）。
- `settledTraceData` 白名单补 `hedged` / `hedgeAfterMs` / `hedgeStartedAt`（此前只活在 meta 里）。
- 嵌套配置里拼错的键（如 `birth.finishWait`）现在也进 `unknownOptions`。
- memory 模式快照条目无限增长（hybrid 条目没有 objectKey ⇒ 不去重，每次整文件重写）：同一陈述只留最后一次，总数封顶 256。
- `analyze-trace` 读 BOOT 的 `birth.finishWaitMs`（此前读不存在的扁平字段，恒为 null）。
- 自测写真实 `~/.dsh`：`verify.mjs` 为每个套件设独立临时 `DSH_HOME`（原值经 `CFB_REAL_DSH_HOME` 只读传入，供探测宿主兄弟包）。
- `verify.mjs` 汇总计数取第一个匹配 ⇒ 有失败时合计少算；改为取最后一个。

### 结构

- 源码进 `src/`：`index.js` 从 4303 行拆成 11 个职责模块（plugin、config、prompts、messages、provider、transport、distill、evidence、
  late-memory、birth、trace），根目录 `index.js` 只剩入口与导出清单（导出面与拆分前逐一相同）。
  拆分为纯搬移，用 AST 逐声明校验：99 个顶层声明中 96 个逐字节一致，`DEFAULTS` 仅少一个空行，`DEP_ID` 有意重写，`apply` 仅修正 4 行缩进。
- `package.json` 的 `main` / `exports` / `types` 不变 ⇒ bundle 与遗留 `file://…/index.js` 两种挂载都不受影响。
- `DEP_ID` 改为自动枚举 `src/*.js`（+ 包入口），新增模块不再可能漏登记。
- 测试文件统一为 `*.selftest.mjs`：`selftest` → `core`、`selftest-birth` → `birth`、`incremental` → `snapshot-invariants`、
  `evidence-views` → `robustness`；`fixtures/` → `test/fixtures/`。`verify.mjs` 自动发现套件、支持按关键字过滤，登记了却缺失的套件判失败。
- `deploy/` 只留 `onboard.mjs`；`analyze-trace`、`benchmark-index` 移入 `tools/`。`replay.mjs` 的 `maxOutputTokens` 不再写死 1200。
- `package.json` 新增 scripts：`test`、`verify`、`manifest`、`manifest:check`、`onboard`、`trace:audit`、`trace:efficiency`。
- `index.d.ts` 与现状对齐；删除 `rules.d.ts`。

### 文档

- README 重写（与 v11.8 代码逐项核对）；新增 `docs/README.md`（索引）、`docs/ARCHITECTURE.md`（开发者视角）；`docs/INSTALL.md` 改为单包安装。
- `docs/at-birth-interception.md`、`docs/ARCHITECTURE-CONSOLIDATED.md` 移入 `docs/archive/`（只追加登记）。

### 升级注意

- profile 显式写了 `mode: distill` / `rules` ⇒ 现在等于 `off`（BOOT `retiredMode`）。
- profile 依赖迟到认领却没写 `birthDeferredClaim` ⇒ 现在需要显式 `true`。
- 重装流程不变（删副本 → `pnpm install` → `npm run onboard` drift 0 → 重启）；BOOT 的 `deps` 现在列出 `src/` 下全部模块。

---

## v11.7 补丁（2026-09-24，PR #1）

凭据正则行首锚定并剥引号（防 `MY_X_KEY` 被 `X_KEY` 子串误命中）；cover.json 走 `$DSH_HOME`；未知配置键进 `unknownOptions`；
`DEP_ID` 补 `exact-flights.js`；README 回滚键改为 `birth.finishWaitMs`；`index.d.ts` 对齐 `DEFAULTS`。
文档整理：历史报告/简报/证据归档至 `docs/archive/`（只移不删），版本块迁出为本文件；自测套件归 `test/`、离线工具归 `tools/`。
验证：1242 通过 / 0 失败 / 1 跳过，19 套件。

## v11.7（2026-09-23）延迟与缓存：三个可关的开关

TTFB 3 秒的三条正面处置，全部**可关、缺省保守**。

1. `distill.hedgeAfterMs`（缺省 0=关；建议 3000）：主请求 N ms 内未收到 200 响应头就再发一份相同请求，谁先回头用谁、另一份立即 abort
   （头一到即取消，输出只付一份）；同一时刻至多 1 份对冲在飞，仅 `maxAttempts ≤ 1` 生效；4xx/5xx 的头不算胜出。
   trace：`compiler-hedge-fired / compiler-hedge-settled`，`meta.hedged`。最坏情况：尾部请求多付一次输入费（≈0.3K tokens）。
2. `birth.finishHeadersGraceMs`（缺省 1500）：finish 处 budget 到点但蒸馏**已收到 200 响应头**（排队已结束、正在生成，
   实测 contentSpanMs 137~1,267ms）⇒ 再多等最多 1.5s；没收到头不加一毫秒。trace：`birth-distill-headers / birth-finish-headers-grace`。
   最坏情况：单次 finish 多阻塞 1.5s 且仍超时（此时对方已在生成，概率由 contentSpan 分布决定，p90 < 1.3s）。
3. `compressSystemPrompt`（缺省 false）：v2/v3 提示词按 `【上一轮思维链】` 拆成 system（规则，字节不变）+ user（原文），
   让 DeepSeek 缓存前缀单元匹配到规则段（现状 `prompt_cache_hit_tokens` 恒 0）；promptVersion 追加 `:sys` 自动分桶做 A/B。

新增套件 `hedge.selftest.mjs`（15 断言，本机 HTTP 可控延迟）。验证：1222 通过 / 0 失败 / 1 跳过，19 套件。

## v11.6（2026-09-23）成本模型落地第一批

依据 `docs/AUDIT-V11.5.md`：

- `birth.minChars` 500→**3100**（`净收益=(R−1)·d·(B−B′)−T−5B′`，d=0.02、R=55、B′≈450 反解保本原长 2,959）；
- `maxOutputTokens` 1200→**850 恒定**（不随输入放大，否则与「ρ 越小净收益恒增」反向）；
- `normalizeConfig` 保证 `timeoutMs ≥ finishWaitMs+2000`（缺陷 D，只抬不降，BOOT `configAdjusted` 留痕）；
- 替换结果空白硬断言 `empty-candidate`；
- 新增**纯观测** trace：`birth-window-probe`（免费窗口三时刻）、`birth-econ`（三态判定，只记录不判定）、
  `birth-condensed.fidelity`（`identifierRecall`，空集标 `unmeasurable` 不算 pass）；`analyze-efficiency.mjs` 新增 `windowProbe / economics / fidelity` 段。

判定行为唯一变化 = 门槛与输出上限；动态门槛、保真放行门槛、提前起火**均未接管**，等 trace 数据。
验证：1207 通过 / 0 失败 / 1 跳过，18 套件。

## v11.5（2026-09-23）compress-v3 与审计

compress-v3 = v2 的保真规则 + v1 的绝对长度目标（`compressTargetMin/Max`，缺省 250/450）。
同日发布审计 [`docs/AUDIT-V11.5.md`](docs/AUDIT-V11.5.md)：收益判据按缓存记账口径重写、按真实工况（95% 冗余）重算门槛反解表。

## v11.4（2026-09-23）

发射结果关联（emission outcome correlation）；可选的宿主 token-meter 前后采样（仅用于诊断）。
compress PromptVersion 贯通 trace；迟到认领漏斗已在 boot26 真机 trace 命中 10/11；carry 有预算与去嵌套；
只在字符估算满足至少 5% 且 100 字符净节省时发射看板，否则保留原文。验证套件当时 18 套。
这些是代码/单次 trace 事实，不代表每次发射都节省 tokenizer tokens 或模型质量已做 A/B。

## v11.3（2026-09-23）

阻止净增长的替换（替换输出比原 span 更长 ⇒ `no-net-savings`）；整段 replace 保留完整 span 内容；澄清输入放大度量的含义
（`promptChars/inputChars` 是请求侧放大，不是输出压缩率）。

## v11.2（2026-09-23）

promptVersion 端到端贯通（单一裁决点，不写死）；无原文时的 retarget；claim-miss 的在飞登记；非法区间诊断；analyzer 的 A/B 分桶。

## v11.1（2026-09-23）

carry 预算与去嵌套；retarget 的看板单例守卫；认领漏斗与 miss 诊断；compress-v2 提示词；可选的部分认领（`lateClaimPartial`）；`markerConflict` 审计标记。

## v11（2026-09-23）正确性修正

整段 replace 的覆盖完整性、迟到候选反查、来源对象解析、compress 迟到通路；传输层上限与退避；契约漂移。
见 [`docs/CORRECTNESS-V11.md`](docs/CORRECTNESS-V11.md)。

## v10：压缩与状态记忆开关切分

这两件事原本焊在 `stateMemory` 一个开关上：触发粒度是「每段 reasoning」，输入范围却是「整个 60 节点证据窗口」
⇒ 每编译 5,371 字符的推理要重发 23,800 字符的窗口证据，实测放大 **7.5x**（工具正文占 58.7%），27 次副编译 0 次替换成功。
现在拆成两个独立开关，裁决只在 `resolveCompileMode()` 一处：`stateCompress` 只压本段 reasoning，**不采集任何证据**（实测 ratio 1.16~2.0）；
`stateMemory` 保留证据账本 + 快照 + 两栏判断。见 [`docs/archive/COMPRESS-MEMORY-SPLIT.md`](docs/archive/COMPRESS-MEMORY-SPLIT.md)。
当时遗留的 compress 迟到问题已在 v11 接通；压缩率/费用收益仍须按真实 token 用量与任务质量评估。

## v9：减少无效编译，改善判断交接

默认路径精确共享相同在途请求；归档终局失败只取消对应消费者；提示词统计与发送复用一次构造。
判断保留适用条件、修正原因及待核对旧记忆；新增分阶段时延、请求级缓存用量和人工决策审核入口。
见 [`docs/archive/COMPILER-EFFICIENCY-V9.md`](docs/archive/COMPILER-EFFICIENCY-V9.md)。无新增开关或等待预算；真实产品收益仍未验收。

## v8：保留证据，减少同请求内的重复展示与准备

相同采集正文按原可见区间取并集，调用身份、状态与完整性仍逐事件保留。批内复用正文 hash 与文件校验；生产和重放共用证据准备入口。
见 [`docs/archive/EVIDENCE-SHARING-V8.md`](docs/archive/EVIDENCE-SHARING-V8.md)。真实产品指标仍未验收，无新增开关或等待预算。

## v7：恢复有依据的判断编译，验证结果真正被消费

工具正文重新进入默认副编译请求，包含正常结果；不因已落盘而省略核对材料。
新增有上限的证据存储、满额后的内存证据回退、认领消费漏斗；四个旧生产开关退役。
见 [`docs/archive/GROUNDED-COMPILER-V7.md`](docs/archive/GROUNDED-COMPILER-V7.md)。
**不承诺未经真实重放证明的性能／压缩率不下降。v6“工具正文跨轮零重发”的取舍已撤回。**

## v6：确定性证据记录＋两栏判断编译

用户现有 `birth + stateMemory:true` 路径直接切换，无新开关。工具原文先落盘，失败不再触发旧正文全量重发；finish 只采用已就绪结果，不主动等副模型。
方案、代价与重放方法见 [`docs/archive/HYBRID-COMPILER.md`](docs/archive/HYBRID-COMPILER.md)。
**真实产品指标尚未验收**：完整会话、主模型探索标注和运行凭据未提供。本地回归不能替代这些指标。

## v5：迟到认领加固

见 [`docs/archive/LATE-CLAIM-HARDENING.md`](docs/archive/LATE-CLAIM-HARDENING.md)。
当批验证：1088 通过、0 失败、1 跳过，13 套件。新增分支隔离、歧义拒绝、发射前复检及缓存体量限制。

## v4：统一优化版

范围回执、编译输入工作集、后台 CAS 镜像／恢复与故障门禁已接线。见 [`docs/archive/OPTIMIZATION-INTEGRATED.md`](docs/archive/OPTIMIZATION-INTEGRATED.md)。
当批验证：1073 通过、0 失败、1 跳过，12 套件。新策略 `stateEvidenceViews` / `stateSnapshotMirror` 默认关闭；配置、代价和真机验收边界见报告。
历史报告中“CAS 尚未接通”等描述仅适用于当时版本；不代表 v4 源码状态。

## 第三批：安全覆盖修复＋增量编译通道实验

见 [`docs/archive/OPTIMIZATION-PHASE3.md`](docs/archive/OPTIMIZATION-PHASE3.md)。当批验证：1032 通过、0 失败、1 跳过，11 套件。
新实验 `stateCompileQueue` 默认关闭；policy 3 不再把截断工具结果整条标成已覆盖。policy 1/2 升级保留正文、重新积累覆盖，短期输入可能增加。

## 第二批：记忆可信度与执行隔离

见 [`docs/archive/OPTIMIZATION-PHASE2.md`](docs/archive/OPTIMIZATION-PHASE2.md)。当批验证：1003 通过、0 失败、1 跳过，10 套件。
旧快照正文保留；旧覆盖集合需要通过新编译重新建立，迁移初期输入可能增加。

## 第一批优化（2026-09-22）

当时的变更、验证与待办见 [`docs/archive/OPTIMIZATION-REPORT.md`](docs/archive/OPTIMIZATION-REPORT.md)。
本轮不改等待预算、模型、输出上限或 surface 替换协议；未部署到真实网关。
第一批时快照只有本地原子文件存储；v4 已另行接通可选 CAS 镜像及后台恢复。现有下文的历史设计说明不应被当成这些能力已经上线的证明。
