# dsh-cot-form-b (`cfb`) — 思维链「出生即压缩」认知编译器

> **当前版本：v14.20.0（2026-10-04）** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块） · **自测：`31/31` 套件全绿（`916 pass / 0 fail / 1 skip`）**
> **核心定位**：Cordis 协议外部插件。在主模型每轮 `reasoning` 块**出生时（进入会话历史之前）**，同步完成 CAS 原文归档与认知编译压缩（支持**零 API 成本、~9ms 极速本地认知图微模型 `compressLocalModel: true`** 与副模型编译双路径）；通过 6 道确定性程序门（非空、零编造标识符、结构闭合、净省字符、token 必降、死路不复活）后原位替换，任何一步不达标或异常即 **100% 无损回退原文放行**。

---

## 1. 三十秒极速上手（人类 & AI 模型通用）

```bash
# 1. 新克隆或跨环境恢复：重建可再生离线状态 → 校验完整性 → 真断网跑全量 31 套自检
npm run restore             # = node tools/cfb-cycle.mjs restore（从 transfer/cycle-state.json 恢复 .cfb-offline）
npm run manifest:check      # = node manifest.mjs --check（校验 MANIFEST.sha256 零漂移）
npm run verify:offline      # = node tools/verify-offline.mjs（真断网跑全部 31 套 selftest，约 30s）

# 2. 查看闭环训练状态与五大国际官方基准综合成绩单（$0 API，1 秒出表）
npm run cycle               # = node tools/cfb-cycle.mjs status（策略池、Pareto 前沿、飞轮、效度账本）
npm run bench               # = node tools/cfb-cycle.mjs benchmark（SWE-bench Pro / TAU pass^k / Arena Elo / AA 指数）
npm run next                # = node tools/cfb-cycle.mjs next（自动诊断瓶颈并给出单条最优下一步命令）
```

---

## 2. 常用命令速查表

| 场景 | 命令 (`npm run ...` 或 `node ...`) | API 成本 | 说明 |
|---|---|---:|---|
| **全量自检（断网）** | `npm run verify:offline` | `$0` | 在 Linux 网络隔离命名空间跑满 31 套 `test/*.selftest.mjs`（916 项断言） |
| **快速自检（并发）** | `npm test` / `node verify.mjs birth v4` | `$0` | 并发跑全部或指定关键字的自测套件 |
| **官方基准总表（Tier 0）** | `npm run bench` | **`$0`** | 融合 SWE-bench Pro、TAU-bench `pass^k`、LMArena Elo、Artificial Analysis 与 LiveBench 的 L2+L1 成绩单 |
| **零 API 预筛 + 析因** | `npm run prescreen` | **`$0`** | 在冻结金标上跑生产 `compileV4Direct + spliceProgramParts + birthAccept + ranker` 并做四维正交因子归因 |
| **闭环全景状态** | `npm run cycle` | **`$0`** | 查看金标池、8 条策略、Pareto 前沿、CPU 排序器（LOO-CV `92.9%`）与飞轮数据 |
| **双轨语义裁判** | `npm run judge` | **`$0`** | 确定性规则 × LLM 语义双轨裁判（支持 `capacity` / `audit-draft` / `audit-traj` / `audit-bench` / `calibrate`） |
| **极简基准实测（Tier 1）** | `npm run bench:lite` | **`≈ $0.004`** | **省钱首选**：复用缓存 `base` 臂，仅对新候选策略发 **1 次**副模型调用即可完成配对比较 |
| **极简轨迹实测（Tier 2）** | `npm run traj:lite` | **`≈ $0.068`** | **真机验效**：IRT 自动挑信息量最高 1 题 × 4 轮上限 × 影子分叉（分歧前零主调用）+ `$0.08` 硬熔断 |
| **导出训练数据** | `npm run train:export` | **`$0`** | 按 5 家族严格组隔离导出 SFT / DPO 数据集与 In-Context DPO 黄金范例对 |
| **更新哈希清单** | `npm run manifest` | **`$0`** | 修改任何入库文件后重新生成 `MANIFEST.sha256` |

---

## 3. 仓库架构与目录地图

仓库收敛为**三个内聚平面**，零冗余旁路：

```
dsh-cot-form-b/
├── index.js / index.d.ts        包入口与对外 TypeScript 类型契约
├── cordis.patch.yml             Cordis bundle 挂载声明（零硬编码路径）
├── verify.mjs / manifest.mjs    并发自测执行器 / SHA-256 完整性清单校验器
│
├── src/                         ① 生产插件核心（22 个零依赖 ESM 模块）
│   ├── plugin.js                组合根：注册 agent/pre-step 与 llm/stream 钩子、BOOT 自证
│   ├── config.js / policy.js    配置归一化与可训练策略空间白名单（提示词 + 部件 + 制度 + 范例）
│   ├── birth.js                 ★ 出生即压缩主干：流式拦截、CAS 归档、自适应 λ 地板（birthAdaptiveFloor）、6 道放行门
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
│   └── helpers/                 15 个内聚辅助模块（ruler / judge-layer / hand-draft / flywheel / proposer / gold-store 等）
│
├── test/                        31 套 *.selftest.mjs 套件 + fixtures/ 真机样本
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
4. **六道收网门禁（`birthFinish`）**：
   - 归档成功 ∧ 编译非空 ∧ **零编造标识符（`inventedIdentifiers = 0`）** ∧ 字符净省达标 ∧ **估算 token 严格下降** ⇒ 替换为短稿；否则立即取消在途请求并 **原文放行**。

### 4.2 关键配置项（`src/config.js` & `src/policy.js`）

| 配置键 | 默认值 | 最优策略值 (`p-1490eefcdf`) | 作用 |
|---|---|---|---|
| `mode` | `'birth'` | `'birth'` | 唯一生产路径（`'off'` 为关闭） |
| `dryRun` | `true` | 生产设 `false` | 评估态保护：默认只写观测 trace，显式设 `false` 才合闸改写 |
| `compressLocalModel` | `false` | **`true`** | **v5 本地超高精度认知图微模型（`src/compile-v5-local.js`）**：~9ms 延迟、`<1MB` 内存、`$0` 副模型 API 成本 |
| `compressPrompt` | `'v3'` | `'v4'` | `'v3'` 散文压缩 / `'v4'` 认知编译器（直写 + 程序门） |
| `continuationPath` | `'full'` | `'bounded'` | 将 O(轮数) 膨胀的【台账】已走路径收束为最近 2 条 + 历史文件出处 |
| `programParts` | `'all'` | `'compact'` | 剔除【已排除】/【未解】与验证提示中的冗余套话，消除双倍叠加 |
| `promptMode` | `'full'` | `'modular'` | 反稀释裁剪：按当轮上下文动态剥离不触发的冗余提示词规则块 |
| `birthAdaptiveFloor` | `false` | `true` | 轮次与停滞度感知的动态 $\lambda$ 压缩地板（理论第四卷控制器落地） |

---

## 5. 当前实测基线（官方五大基准融合）

运行 `npm run bench` 可直接复现以下零污染实测基线：

- **Mode 1（`raw vs hand`）理论天花板（`t10`–`t14`，9 对同起点真机配对，`ceiling-8.json`）**：
  - **7 胜 0 负 2 平（`7W-0L-2T`）**，序贯显著性 **`e = 31.875 >= 10.0`**（`verdict: 'hand-better'`），严苛解决率 **`100%`（`9/9`）vs `66.7%`（`6/9`）**（`headroom = +33.3%`），LMArena Elo **`1349`**（vs `raw = 1000`），压缩比 **`0.300`**。
- **L2 端到端多轮编码轨迹（`transfer/traj1..3`，21 条配对轨迹）**：
  - **`auto`（`birth` 出生即压缩）**：SWE 严苛解决率 **`85.7%`**（伪修好水分 **`0.0%`**），`pass@1 = 0.889`，TAU 稳定性 `pass^2 = 0.778`，平均步数 **`4.86` 轮（较原文 `-23.5%`）**，思维链字符 **`-27.4%`**，**LMArena Elo `1114`**（较 `raw` `1000` 净胜 `+114` 分，较 `ledger` `954` 净胜 `+160` 分）。
- **L1 零污染金标基准（`b9` 冠军 `p-1490eefcdf` 在当时的全量 11 条 Gold 标尺 `7 dev + 4 holdout` 上实测）**：
  - **注册表现状（v14.20.1 复算后）**：`transfer/gold/` 活跃 6 项（`sse-truncated` / `eacces-config` / `wrong-model`，`dev 2 + holdout 4`，全部 `[clean]`），另有 6 条改好的修订稿在 `transfer/gold-repair/staged/` 等模式 1 真机复测（`pending-retest.json`）。`b9` 的 `1.000` 是 11 项在册时测的历史成绩；条目集变了就按计划重建（`gold-changed` 会拒跑旧计划）。
  - **本地认知图微模型 `p-1490eefcdf`**：在 **11/11 条 Gold 标尺（含 4 条盲测留出题与 4 条 `:long-horizon` 多跳长程题）** 上取得 **`1.000 [实测]` 满分**（`dev = 1.000`，`holdout = 1.000`，泛化差 `0.000`，`G1 = 11/11`，`G2 = 11/11`，`e = 31.875 >= 10.0` ⇒ `promote`），金标均省 **`1,753 tok`**，5 题池全轮 `8/8` 过闸（均省 **`482 tok`**，5 题 Oracle `dd = 0.908`），单次编译平均耗时 **`9.38 ms`**，副模型 API 成本 **`$0.00`**。

---

## 6. 延伸阅读（文档全部位于 `docs/`）

- [`docs/README.md`](docs/README.md) — 文档总目录与 5 分钟阅读路线图
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 生产插件与认知编译器技术架构、12 条不变式、「改哪里」速查
- [`docs/TRAINING-AND-BENCHMARK.md`](docs/TRAINING-AND-BENCHMARK.md) — 统一科学训练闭环、双轨裁判与五大官方基准完整指南
- [`docs/HISTORY-AND-EXPERIMENTS.md`](docs/HISTORY-AND-EXPERIMENTS.md) — 历史实验数据、经济模型定律与工程审计汇总
- [`transfer/HANDOFF.md`](transfer/HANDOFF.md) — 面向新模型 / 新开发者的 30 秒一页交接卡
