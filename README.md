# dsh-cot-form-b (`cfb`) — 思维链「出生即压缩」认知编译器

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
> **当前版本：v14.25.1** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块）
> **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**
> · 验收口径 `npm run verify:offline`（真断网 Linux 命名空间）：40/40 套件全绿 · `1207 通过 / 0 失败 / 1 跳过`
> · 快速自检 `npm test`（联网机上跑，需要隔离的那条断言按设计跳过）：41/41 套件全绿 · `1216 通过 / 0 失败 / 2 跳过`
> 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。
> **规模**：`src/` 23 个零依赖模块 · `tools/` 60 个脚本 + 29 个 helpers · `test/` 41 套自测 · `transfer/gold/` 13 条（4 个家族）
<!-- watermark:end -->

> **核心定位**：Cordis 协议外部插件。在主模型每轮 `reasoning` 块**出生时（进入会话历史之前）**，同步完成 CAS 原文归档与认知编译压缩（支持**零 API 成本的本地认知图微模型 `compressLocalModel: true`** 与副模型编译双路径）；收网门逐条列在下面 §4.1，任何一步不达标或异常即 **100% 无损回退原文放行**。
>
> **本文件的数字一律不手抄**：规模、版本、自测读数、六道门清单都由 `tools/doc-watermark.mjs` 现算现渲染；`verify.mjs` 的 `doc-watermark` 套件会在文档漂走时报错（含 5 个负例夹具证明这道门会咬人）。
>
> **两条"跳过"分别是什么**（水位块里的 `N 跳过` 就是它们，不是丢了的测试）：
> · `test/birth.selftest.mjs` 的 **T13**（`deriveArtHandle ≡ dshb-store.deriveHandle`）—— 私有宿主兄弟包 `dsh-context-memory-bundle` 不随 npm 发布，本机没有 ⇒ 整条跳过；设 `CMB_STORE_PATH` 指向该包才会真跑。
> · `test/eval-ready.selftest.mjs` 的 **第 38 项**（需要真断网命名空间才能取证）—— 只在 `npm run verify:offline` 里跑，联网机上按设计跳过。
> ⇒ 所以"隔离内 1 跳过 / 联网 2 跳过"，且 `verify.mjs` 的结论行永远写"存在跳过项，非完整宿主验证"，不会替宿主侧契约背书。
---

## 1. 三十秒极速上手（人类 & AI 模型通用）

```bash
# 1. 新克隆或跨环境恢复：重建可再生离线状态 → 校验完整性 → 真断网跑全量自测套件
npm run restore             # = node tools/cfb-cycle.mjs restore（从 transfer/cycle-state.json 恢复 .cfb-offline）
npm run manifest:check      # = node manifest.mjs --check（校验 MANIFEST.sha256 零漂移）
npm run verify:offline      # = node tools/verify-offline.mjs（真断网跑全部 selftest；用时见文首水位块）

# 2. 查看闭环训练状态与五大国际官方基准综合成绩单（$0 API，1 秒出表）
npm run cycle               # = node tools/cfb-cycle.mjs status（策略池、Pareto 前沿、飞轮、效度账本）
npm run bench               # = node tools/cfb-cycle.mjs benchmark（SWE-bench Pro / TAU pass^k / Arena Elo / AA 指数）
npm run next                # = node tools/cfb-cycle.mjs next（自动诊断瓶颈并给出单条最优下一步命令）
```

---

## 2. 常用命令速查表

| 场景 | 命令 (`npm run ...` 或 `node ...`) | API 成本 | 说明 |
|---|---|---:|---|
| **全量自检（断网）** | `npm run verify:offline` | `$0` | 在 Linux 网络隔离命名空间跑满全部 `test/*.selftest.mjs`；套件数/断言数见文首水位块（`--record` 记账） |
| **快速自检（并发）** | `npm test` / `node verify.mjs birth v4` | `$0` | 并发跑全部或指定关键字的自测套件（联网机上需要隔离的那条断言按设计记为跳过） |
| **官方基准总表（Tier 0）** | `npm run bench` | **`$0`** | 融合 SWE-bench Pro、TAU-bench `pass^k`、LMArena Elo、Artificial Analysis 与 LiveBench 的 L2+L1 成绩单 |
| **零 API 预筛 + 析因** | `npm run prescreen` | **`$0`** | 在冻结金标上跑生产 `compileV4Direct + spliceProgramParts + birthAccept + ranker` 并做四维正交因子归因 |
| **闭环全景状态** | `npm run cycle` | **`$0`** | 查看金标池、8 条策略、Pareto 前沿、CPU 排序器（LOO-CV `92.9%`）与飞轮数据 |
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
├── deploy/                      onboard.mjs 部署漂移体检 + eval-profile 配置模板 + probe/ 探针 + systemd/
├── docs/                        ③ 合一化文档体系（索引见 docs/README.md）
│   ├── README.md                文档总目录与阅读路线图
│   ├── ARCHITECTURE.md          生产插件与认知编译器技术架构
│   ├── TRAINING-AND-BENCHMARK.md 统一科学训练闭环、双轨裁判与五大官方基准指南（合一版）
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
   - 在 `llm/stream` 中拦截 `reasoning` 块；计算动态门槛 `effectiveBirthMinChars(cfg, meta)`：
   - 缺省门槛 `birthMinChars: 3100`（基于缓存命中率与后续阅读轮数 $K$ 的盈亏平衡点）；开启 `birthAdaptiveFloor: true` 时，早期轮次（`round ≤ 2`）抬高门槛至 `4200` 保护原生探索，深轮次（`round ≥ 4`）降至 `1800` 及时清理上下文膨胀，连续只读停滞（`stagnantRounds ≥ 2`）降至 `1200` 注入已排除死路疫苗。
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
3. **无发明标识符** —— 稿里的路径 / 反引号代码 / camelCase / snake_case 必须逐字出自 `raw ∪ ctx ∪ 程序部件`，否则 `invented-identifier`
4. **字符净省** —— `raw − candidate ≥ birthMinSavedChars`（默认 50），否则 `no-gain`
5. **token 严格下降** —— 字符变短而 token 没降 ⇒ `no-token-gain`（估算按书写系统区分，不是真 tokenizer）
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

## 5. 当前实测基线（官方五大基准融合）

下列读数记于 **v14.25.1（2026-10-06）**，来源逐条写在括号里 ⇒ 换版本必须重跑，不抄旧数；
**规模类**数字（模块/套件/金标条数）不在这里手抄，一律以文首水位块为准（`npm run watermark:check` 会核对）。

- **L2 端到端多轮编码轨迹**（`npm run bench`，已落盘真轨迹零 API 复算；`raw n=8 / auto n=7 / ledger n=6`）：
  `auto`（出生即压缩）SWE 严苛解决率 **85.7%**（伪修好水分 `0.0%`）、`pass@1 0.889`、`pass^2 0.778`、平均 **4.86 轮**（较 raw `-13.7%`）、思维链字符 **-27.4%**、**LMArena Elo 1110，95% CI `[926, 1345]`**（`raw = 1000`，`ledger = 951`）。
  **区间跨过 1000 ⇒ 这张表本身不足以宣称"稳赢 raw"**，要看下面的 L1 与真机配对。
- **L1 零污染金标基准**（尺子 = `transfer/gold/`）：榜首 **`p-1490eefcdf`** 金标过闸 **12/13**（净省 431 tok），距离分 **`dd = 0.724 [实测]`**（距理论极限 `-0.276`），池题全轮 `8/8`、均省 482 tok，5 题人类 Oracle `dd = 0.908`（`npm run bench` 第二表）。
  尺子本身带判词：逐条 `goldStandard.status` 现算得 **4 条 `gold` / 9 条 `not-gold`**（`tools/gold-attest.mjs` 的降级只降不升）。旧版本在册 11 项时测出的 `1.000` 是**历史成绩**，条目集已变，不再是当前尺子上的读数。
- **本地认知图微模型的真实状态**（`transfer/models/cfb-micro-97m-report.json`）：**`accepted = false`、`promoted = false`**，唯一未过的预登记门是 `freshIndependentNewFamilyTestPassed`（`blocked-no-new-independent-family`）；一次性盲测账本 `cfb-micro-final-test-ledger.json` 只有 1 条记录（`case-fold-collision`：unit 30 对 `0.8333` / draft 8 对 `0.0` ⇒ `evaluated-below-90-percent-gates`），**该盲测集已消耗，不许重跑刷分**。生产权重 `transfer/models/v5-micro-weights.json` 未被任何一轮改动覆盖。
- **最要紧的一个数**（`transfer/models/micro-gap-map.json`，`measuredAt 2026-10-04`，7 条真机对）：`archetypeProduction.distanceScore = 1.000` vs `generalProduction = 0.1631`（W1 前 `0.1549`、W1.1 后 `0.1596`）——**原型命中路径满分，"真实用户仓处境"（raw 不含本项目标识符、走兜底路径）远未达标**。`forceGeneralPath` 是这条测量臂的开关（`src/policy.js`）。
- **单次本地编译延迟**（`compileV5Local`，真金标 13 条 × 每条 20 次 warm 复测，n=260，raw 均值 3.4k 字）：三次独立复测均值 **4.1 / 6.3 / 7.4 ms**，p50 5.3–6.1 ms，p95 14.6–20.5 ms；`meta.localMs` 与外部计时逐次吻合（差 <0.1 ms）⇒ **量级是"几毫秒"，负载敏感，写死任何单点数都会撒谎**。合成超长输入会把数拉到几十毫秒，不作数。
- **Mode 1（`raw vs hand`）理论天花板**（`t10`–`t14`，9 对同起点真机配对，`.cfb-offline/ruler/ceiling-8.json`）：**`7W-0L-2T`**，序贯显著性 **`e = 31.875 >= 10.0`** ⇒ `verdict: 'hand-better'`，严苛解决率 **`100%`（`9/9`）vs `66.7%`（`6/9`）**（`headroom = +33.3%`），压缩比 **`0.300`**。

---

## 6. 延伸阅读（文档全部位于 `docs/`）

- [`docs/README.md`](docs/README.md) — 文档总目录与 5 分钟阅读路线图
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 生产插件与认知编译器技术架构、12 条不变式、「改哪里」速查
- [`docs/TRAINING-AND-BENCHMARK.md`](docs/TRAINING-AND-BENCHMARK.md) — 统一科学训练闭环、双轨裁判与五大官方基准完整指南
- [`docs/HISTORY-AND-EXPERIMENTS.md`](docs/HISTORY-AND-EXPERIMENTS.md) — 历史实验数据、经济模型定律与工程审计汇总
- [`transfer/HANDOFF.md`](transfer/HANDOFF.md) — 面向新模型 / 新开发者的 30 秒一页交接卡
