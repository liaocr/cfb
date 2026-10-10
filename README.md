# dsh-cot-form-b (`cfb`) — 思维链「出生即压缩」认知编译器

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
> **当前版本：v14.25.4** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块）
> **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**
> · 验收口径 `npm run verify:offline`（真断网 Linux 命名空间）：42/42 套件通过 · `1242 通过 / 0 失败 / 1 跳过`
> · 快速自检 `npm test`（联网机上跑，需要隔离的那条断言按设计跳过）：42/42 套件通过 · `1241 通过 / 0 失败 / 2 跳过`
> 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。
> **规模**：`src/` 24 个零依赖模块 · `tools/` 61 个脚本 + 29 个 helpers · `test/` 42 套自测 · `transfer/gold/` 13 条（4 个家族）
<!-- watermark:end -->

> **核心定位**：Cordis 协议外部插件。在主模型每轮 `reasoning` 块**出生时（进入会话历史之前）**，同步完成 CAS 原文归档与认知编译压缩（支持**零 API 成本的本地认知图微模型 `compressLocalModel: true`** 与副模型编译双路径）；收网门逐条列在下面 §4.1，任何一步不达标或异常即 **100% 无损回退原文放行**。
>
> **本文件的数字一律不手抄**：规模、版本、自测读数、六道门清单都由 `tools/doc-watermark.mjs` 现算现渲染；`verify.mjs` 的 `doc-watermark` 套件会在文档漂走时报错（含 5 个负例夹具证明这道门会咬人）。
>
> **两条"跳过"分别是什么**（水位块里的 `N 跳过` 就是它们，不是丢了的测试）：
> · `test/birth.selftest.mjs` 的 **T13**（`deriveArtHandle ≡ dshb-store.deriveHandle`）—— 私有宿主兄弟包 `dsh-context-memory-bundle` 不随 npm 发布，本机没有 ⇒ 整条跳过；设 `CMB_STORE_PATH` 指向该包才会真跑。
> · `test/eval-ready.selftest.mjs` 的 **第 38 项**（需要真断网命名空间才能取证）—— 只在 `npm run verify:offline` 里跑，联网机上按设计跳过。
> ⇒ 所以"隔离内 1 跳过 / 联网 2 跳过"，且 `verify.mjs` 的结论行永远写"存在跳过项，非完整宿主验证"，不会替宿主侧契约背书。
>
> **水位块是"记账回执"而非"实时现算"**：`tools/doc-watermark.mjs --check` 比对的是**文档 ↔ `transfer/watermark.json`**，不会去比对回执与当次运行是否一致。回执在 Linux 上记账（上表数字即该环境读数）。
> **在 Windows 上跑会看到不同的跳过数**（如 `1238 通过 / 0 失败 / 8 跳过`）：无 `bash`/网络隔离命名空间，`test/closed-loop-v4.selftest.mjs`（A18/A19/A34 及 A38 的 C3）与 `test/mode1-quality-parity.selftest.mjs` 的依赖项按 `process.platform === 'win32'` 守卫跳过。**这是环境差异，不是回归**；要复现水位块数字请在 Linux 上跑 `npm run verify:offline`。
---

## 1. 三十秒极速上手（人类 & AI 模型通用）

```bash
# 1. 新克隆或跨环境恢复：重建可再生离线状态 → 校验完整性 → 真断网跑全量自测套件
npm run restore             # = node tools/cfb-cycle.mjs restore（从 transfer/cycle-state.json 恢复 .cfb-offline）
npm run manifest:check      # = node manifest.mjs --check（校验 MANIFEST.sha256 零漂移）
npm run verify:offline      # = node tools/verify-offline.mjs（真断网跑全部 selftest；用时见文首水位块）

# 2. 查看闭环训练状态与外部评测口径的本地代理记分卡（$0 API，1 秒出表）
npm run cycle               # = node tools/cfb-cycle.mjs status（策略池、Pareto 前沿、飞轮、效度账本）
npm run bench               # = node tools/cfb-cycle.mjs benchmark（本地代理指标，受 SWE-bench/TAU/Arena/AA 口径启发；非官方参测成绩）
npm run next                # = node tools/cfb-cycle.mjs next（自动诊断瓶颈并给出单条最优下一步命令）
```

---

## 2. 常用命令速查表

| 场景 | 命令 (`npm run ...` 或 `node ...`) | API 成本 | 说明 |
|---|---|---:|---|
| **全量自检（断网）** | `npm run verify:offline` | `$0` | 在 Linux 网络隔离命名空间跑满全部 `test/*.selftest.mjs`；套件数/断言数见文首水位块（`--record` 记账） |
| **快速自检（并发）** | `npm test` / `node verify.mjs birth v4` | `$0` | 并发跑全部或指定关键字的自测套件（联网机上需要隔离的那条断言按设计记为跳过） |
| **本地代理记分卡（Tier 0）** | `npm run bench` | **`$0`** | 本仓对既有轨迹/预筛数据计算的 L2+L1 汇总，借鉴 SWE-bench/TAU/LMArena/AA/LiveBench 的指标思路；不是官方 benchmark 提交或认证 |
| **零 API 预筛 + 析因** | `npm run prescreen` | **`$0`** | 在冻结金标上跑生产 `compileV4Direct + spliceProgramParts + birthAccept + ranker` 并做四维正交因子归因 |
| **闭环全景状态** | `npm run cycle` | **`$0`** | 查看金标池、策略、Pareto 前沿、CPU 排序器与效度账本；动态读数以本次命令输出为准 |
| **双轨语义裁判** | `npm run judge` | **`$0`** | 确定性规则 × LLM 语义双轨裁判（支持 `capacity` / `audit-draft` / `audit-traj` / `audit-bench` / `calibrate`） |
| **极简基准实测（Tier 1）** | `npm run bench:lite` | **`≈ $0.004`** | **省钱首选**：复用缓存 `base` 臂，仅对新候选策略发 **1 次**副模型调用即可完成配对比较 |
| **极简轨迹实测（Tier 2）** | `npm run traj:lite` | **`≈ $0.068`** | **真机验效**：IRT 自动挑信息量最高 1 题 × 4 轮上限 × 影子分叉（分歧前零主调用）+ `$0.08` 硬熔断 |
| **导出训练数据** | `npm run train:export` | **`$0`** | 按 5 家族严格组隔离导出 SFT / DPO 数据集与 In-Context DPO 黄金范例对 |
| **更新哈希清单** | `npm run manifest` | **`$0`** | 修改任何入库文件后重新生成 `MANIFEST.sha256` |
| **文档水位** | `npm run watermark:check` / `watermark:record` | **`$0`** | 文首与 `docs/ARCHITECTURE.md`、`transfer/HANDOFF.md` 的水位区：现算结构计数 + 六道门，漂了就报错 |

---

## 3. 仓库架构与目录地图

仓库收敛为**三个内聚平面**，零冗余旁路：

```
dsh-cot-form-b/
├── index.js / index.d.ts        包入口与对外 TypeScript 类型契约
├── cordis.patch.yml             Cordis bundle 挂载声明（零硬编码路径）
├── verify.mjs / manifest.mjs    并发自测执行器 / SHA-256 完整性清单校验器
│
├── src/                         ① 生产插件核心（零依赖 ESM 模块；数量见文首水位块）
│   ├── plugin.js                组合根：注册 agent/pre-step 与 llm/stream 钩子、BOOT 自证
│   ├── config.js / policy.js    配置归一化与可训练策略空间白名单（提示词 + 部件 + 制度 + 范例）
│   ├── birth.js                 ★ 出生即压缩主干：流式拦截、CAS 归档、自适应 λ 地板（birthAdaptiveFloor）、六道收网门（清单见 §4.1）
│   ├── distill.js               副模型调用：重试降级、对冲（hedge）、传输 trace、In-Context DPO 范例自动注入
│   ├── prompts.js               提示词编译（v3 / v4-ops / v4d6 直写 + modularPromptPrune 反稀释动态裁剪）
│   ├── compile-v4.js            ★ v4 认知编译器：JSON 原子条目编译（I1–I8 不变量）+ v4d6 直写程序门 + 状态部件紧致化（compact）
│   ├── segment-v4.js            v4 流式增量分段器（长思维链边写边编，收网只等尾段）
│   ├── messages.js              出站消息溯源、台账提取、有界延续段（continuationPath:'bounded'）与文件出处保留
│   ├── fidelity.js / tokens.js  逐字标识符召回率、发明标识符拦截闸、按书写系统区分的 token 粗估
│   ├── transport.js / provider.js / host-follow.js / session-tracker.js / handle-probe.js / trace.js / boot-record.js
│   ├── evidence-program.js / evidence-store.js   宿主类型化证据程序与 CAS 签名块仓（默认关，opt-in）
│   └── training-core.js         纯函数训练内核：5 家族连通组隔离切分、SFT/DPO 导出与严格逐项发布门
│
├── tools/                       ② 统一科学训练闭环与双轨评估 CLI
│   ├── cfb-cycle.mjs            ★ 闭环主控：status / next / benchmark / prescreen / plan-bench / plan-traj / flywheel / export-train
│   ├── cfb-judge.mjs            ★ 双轨裁判：规则 × LLM 语义交叉验证、死路复活检测、130 样本 L2 岭回归校准
│   ├── bench-run.mjs            Mode 2 金标基准执行器（跨计划 CAS 缓存 + In-Context DPO 注入）
│   ├── traj-run.mjs             Mode 3 多轮可执行轨迹执行器（影子分叉 Shadow-Forking + 轮次自适应 λ）
│   ├── traj-fixtures.mjs / traj-fixtures-v2.mjs  5 道主池 + 5 道留出池真实可运行排障沙箱
│   ├── effect-ready.mjs / bounded-ab.mjs         有界 API 预算账本与双平面预注册评测
│   ├── verify-offline.mjs       Linux unshare 断网自检入口
│   ├── analyze-trace.mjs / analyze-efficiency.mjs / phase0-report.mjs / cf-eval.mjs / v4-live.mjs / closure-check.mjs / draft-lint.mjs
│   └── helpers/                 内聚辅助模块（ruler / judge-layer / hand-draft / flywheel / proposer / gold-store 等；数量见文首水位块）
│
├── test/                        *.selftest.mjs 套件（个数见文首水位块）+ fixtures/ 真机样本
├── deploy/                      onboard.mjs 部署漂移体检 + eval-profile 配置模板 + kaggle/ 一键训练启动器(train_micro/train_gen/repred_micro/start)
├── docs/                        ③ 合一化文档体系（索引见 docs/README.md）
│   ├── README.md                文档总目录与阅读路线图
│   ├── ARCHITECTURE.md          生产插件与认知编译器技术架构
│   ├── TRAINING-AND-BENCHMARK.md v14.20 训练闭环与本地代理基准历史指南（见新鲜度说明）
│   ├── HISTORY-AND-EXPERIMENTS.md 历史实验、成本定律与工程审计全集（合一版）
│   ├── EVIDENCE-PROGRAM.md      宿主证据程序接口规范
│   ├── INSTALL.md               Cordis 部署与排错指南
│   ├── proposals/               预注册策略补丁 JSON（供闭环自测与复现）
│   └── theory/CFB-THEORY-COMPLETE.md  认知编译器六卷完整理论与数学推导
└── transfer/                    跨会话公开状态：HANDOFF.md（一页交接卡）、cycle-state.json、gold/ 金标库及历史实验回执
```

---

## 4. 生产工作流与核心配置

### 4.1 一个 `reasoning` 块的生命周期（`mode: 'birth'`）

1. **流式捕获与自适应门槛（`birthStart`）**：
   - 在 `llm/stream` 中拦截 `reasoning` 块；由 `computeAdaptiveBirthControl(raw, ctx, pressure, cfg)`（`src/birth.js`）计算动态门槛 `effectiveFloor` 与输出上限 `effectiveMaxChars`：
   - 缺省门槛 `birthMinChars: 3100`（基于缓存命中率与后续阅读轮数 $K$ 的盈亏平衡点）；开启 `birthAdaptiveFloor: true` 后按**三个工作区**分派（实测值，基准 3100）：**fresh-early**（第 1 轮、`spinScore < 0.25`、水位 `< 0.20`）地板 `×1.20` ⇒ **3720**，保护原生探索；**cruise**（常规轮）保持 **3100**；**high-spin-or-long-horizon**（轮次 ≥ 4、连续只读 ≥ 3 轮、`spinScore ≥ 0.45`、或窗口水位 ≥ 0.50）地板 `×0.65` 且下限 **1600**（3100 时得 **2015**），输出上限同步收紧 `×0.85`。
2. **并行 CAS 归档与副模型编译（`distill`）**：
   - 原文写入宿主 CAS 存储（生成可读回的 `art://` 句柄）；
   - 同时调用副模型（主模型同端点关闭思考）执行编译：支持 `v3`（散文摘要）、`v4-ops`（JSON 八类原子条目确定性编译）与 **`v4d6` 直写（`compressPrompt: 'v4', compressV4Direct: true`）**。
3. **程序门核真与部件拼接（`compileV4Direct` + `spliceProgramParts`）**：
   - 机械核验反引号锚点逐字存在、判读分支闭合、三元组非空且 `new_text ≠ old_text`；
   - 自动拼接程序部件：**【延续段】**（支持 `continuationPath: 'bounded'` 有界滑窗与历史文件出处保留）+ **【状态部件】**（支持 `statePartsMode: 'compact'` 剔除与正文重叠的复述句）+ **【在手行】**。
4. **六道收网门（`birthFinish` → `birthAccept`）**：顺序与判据见下；清单由 `tools/doc-watermark.mjs` 从 `src/birth.js` 同源渲染，与 `docs/ARCHITECTURE.md` §2.1 逐字一致。

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
1. **归档成功** —— 拿不到可读回的 CAS 句柄 ⇒ 不换原文（`birth.js` 的 archive 结果先行判定）
2. **编译非空** —— 空稿或纯空白 ⇒ `empty-candidate`，原文放行
3. **无发明标识符** —— 稿里的路径 / 反引号代码 / camelCase / snake_case 必须逐字出自 `raw ∪ ctx ∪ 程序部件`；发明或核验异常 ⇒ 原文放行
4. **字符净省** —— `raw − candidate ≥ birthMinSavedChars`（默认 50），否则 `no-gain`
5. **token 严格下降** —— 字符达到净省门槛但 token 没降 ⇒ `no-token-gain`（估算按书写系统区分，不是真 tokenizer）
6. **替换成功（condensed）** —— 以上全过才原位改写；任何一步不达标或异常 ⇒ 取消在途请求并原文放行

> **结构闭合**（判读分支闭合、三元组 `new_text ≠ old_text`）与**死路不复活**是**编译阶段**的要求（`compileV4Direct` / `src/compile-v5-local.js`），不在上面这六道收网判定里 —— 两段别混成一条闸。
<!-- watermark:end -->

### 4.2 关键配置项（`src/config.js` & `src/policy.js`）

| 配置键 | 默认值 | 最优策略值 (`p-1490eefcdf`) | 作用 |
|---|---|---|---|
| `mode` | `'birth'` | `'birth'` | 唯一生产路径（`'off'` 为关闭） |
| `dryRun` | `true` | 生产设 `false` | 评估态保护：默认只写观测 trace，显式设 `false` 才合闸改写 |
| `compressLocalModel` | `false` | **`true`** | **v5 本地认知图微模型（`src/compile-v5-local.js`）**：`$0` 副模型 API 成本；单次编译实测 4.1–7.4 ms 均值（真金标 warm ×20 复测 ×3 轮，见 §5）。**只在含本项目标识符的 raw 上满分**，兜底路径读数见 §5 的 gap map |
| `compressPrompt` | `'v3'` | `'v4'` | `'v3'` 散文压缩 / `'v4'` 认知编译器（直写 + 程序门） |
| `continuationPath` | `'full'` | `'bounded'` | 将 O(轮数) 膨胀的【台账】已走路径收束为最近 2 条 + 历史文件出处 |
| `programParts` | `'all'` | `'compact'` | 剔除【已排除】/【未解】与验证提示中的冗余套话，消除双倍叠加 |
| `promptMode` | `'full'` | `'modular'` | 反稀释裁剪：按当轮上下文动态剥离不触发的冗余提示词规则块 |
| `birthAdaptiveFloor` | `false` | `true` | 轮次与停滞度感知的动态 $\lambda$ 压缩地板（理论第四卷控制器落地） |

---

## 5. 当前实测基线与证据新鲜度（外部评测口径的本地代理记分卡）

下列命令于 **v14.25.4 / 2026-10-07（本地日期）**在当前 checkout 现场重跑；receipt 的 `at` 时间戳使用 UTC，故可显示为 2026-10-06。结构规模只以文首水位块为准。`npm run bench` 是零 API 的在盘轨迹汇总 + 当前预筛，不是新的盲测或单一随机配对实验；不要把混合轨迹的 `n` 当独立样本量。输出中的 SWE-bench/TAU/Arena/AA 名称只表示**本地借鉴的指标口径**，不代表参加了对应官方基准、使用了官方测试集或获得官方认证。

- **L2 轨迹汇总**（`npm run bench` 当前输出；读取 `transfer/traj1..3` 与 `.cfb-runtime/traj/*`）：`raw n=80`、`auto n=7`、`ledger n=6`。`auto` 严苛修好率 **85.7%**、伪修好 **0.0%**、`pass@1=0.889`、`pass^2=0.778`、平均 **4.86 轮（相对 raw −24.9%）**、思维链字符 **−27.4%**；Elo **1104，95% CI [945, 1279]**，区间覆盖 raw 锚点 1000，不能据此宣称稳赢。`ledger` 仍有 **16.7%** 伪修好。榜首 L1 候选 `p-1490eefcdf` 在这份 L2 汇总里的 `policy` 臂为 **1/24（4.2%）**严苛修好；这是描述性旧轨迹汇总，但足以说明 L1 领先不等于已验证端到端收益。
- **L1 预筛榜首**（`npm run bench` 当前输出第二表，尺子来自 `transfer/gold/`）：`p-1490eefcdf` 金标过闸 **12/13（净省 431 tok）**、`dd=0.724`；当前任务池 **4/4 题、9/9 轮**、均省 **1111 tok**、Oracle `dd=0.831`、真值分 `0.696`、AA 密度效率 `0.6473`。这只是同一预筛中的第一名，**不是 champion**。旧文中的 `8/8、482 tok、Oracle 0.908、真值分 0.781` 与当前命令输出不一致；它们仍见于 A39 隔离夹具/旧快照，确切的指标口径和数据池差异尚未证明，故不混写。
- **闭环状态**（`npm run cycle` 当前输出）：champion 仍为 **`base`**；飞轮 **93/93** 对通过 dev/内容闸；CPU 排序器 `ready`、LOO-CV **0.763**，但尺子效度为 **`suspect (n=304)`**，不等于已验证泛化。稳定决策：在 L2 端到端验证前不采纳 `p-1490eefcdf`。
- **金标**：`node tools/gold-score.mjs --dedup` 当前为 **19 个唯一 id：4 gold / 15 not-gold**；在册 `transfer/gold/` 13 条中是 **4 gold / 9 not-gold**。`node tools/gold-attest.mjs --check` 当前处理 23 条，**4 gold / 19 not-gold，0 过期章**。R2 `n=1` 已测但未达 ≥2 阈值，应是 `not-gold`（见 `docs/GOLD-STANDARD.md`；本轮同步修正文档与测试）。
- **微模型**：最后一份完整入库报告 `transfer/models/cfb-micro-97m-report.json` 的 `completedAt=2026-10-04T13:57:17Z`，记为 `accepted=false`、`promoted=false`，且 `freshIndependentNewFamilyTestPassed=false`，状态 `blocked-no-new-independent-family`；这不是 06g 的新结果。`docs/STATUS-2026-10-07.md` 记录的 06g 数字属于快照，06g 折报告/折候选权重未入库，不能独立复算。盲测账本已有 1 个家族记录（`case-fold-collision`），终态 `evaluated-below-90-percent-gates`（unit-pair accuracy 0.8333、draft-pair accuracy 0），一次性盲测已消耗，不重跑刷分。
- **通用压缩器原型**：`src/universal-select.js` 尚未接入生产；归档探针声称同预算锚点覆盖 50.3% vs 生产 27.4%，但 math oracle 57.3% 低于 random 65.4%，故不批准接线。探针脚本含 `/home/user/cfb` 绝对路径，且随机对照未固定种子；在当前干净克隆实际运行 `universal_bench.mjs` 会因找不到该路径失败。因此上述探针表是**未复现的归档读数**，不是本轮实测结论。
- **历史读数（未在本轮重跑）**：`transfer/models/micro-gap-map.json` 标注 `measuredAt=2026-10-04`、7 组真机对；当时 `archetypeProduction.distanceScore=1.000`、`generalProduction=0.1631`（W1 前 `0.1549`；W1.1 后 `0.1596`）。这组原型/兜底差距是旧测量，不是当前泛化成绩；编译延迟（13 条 × 20 次）与 Mode 1 `t10–t14` 9 组配对也来自已有记录。本轮没有重做，需按各自冻结口径复测后才能作为新版本现状引用。

---

## 6. 延伸阅读（文档全部位于 `docs/`）

- [`docs/README.md`](docs/README.md) — 文档总目录与 5 分钟阅读路线图
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 生产插件与认知编译器技术架构、12 条不变式、「改哪里」速查
- [`docs/TRAINING-AND-BENCHMARK.md`](docs/TRAINING-AND-BENCHMARK.md) — v14.20 训练设计与本地代理指标历史指南（非官方基准成绩）
- [`docs/HISTORY-AND-EXPERIMENTS.md`](docs/HISTORY-AND-EXPERIMENTS.md) — 历史实验数据、经济模型定律与工程审计汇总
- [`transfer/HANDOFF.md`](transfer/HANDOFF.md) — 面向新模型 / 新开发者的 30 秒一页交接卡
