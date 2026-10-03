# 生产插件与认知编译器架构（v14.18，开发者视角）

> 面向改代码的开发者与 AI 模型：模块怎么分、数据怎么流、哪些不变式不能碰、加功能该改哪里。
> 快速上手见根目录 [`README.md`](../README.md)；闭环训练与官方基准见 [`TRAINING-AND-BENCHMARK.md`](TRAINING-AND-BENCHMARK.md)；历史实验与成本定律见 [`HISTORY-AND-EXPERIMENTS.md`](HISTORY-AND-EXPERIMENTS.md)。

---

## 0. 架构全景（三个内聚平面）

仓库 100% 聚焦于 **思维链出生即压缩（Birth-time CoT Compression / 认知编译器）**，由三个内聚平面组成：

| 平面 | 入口 | 职责 | 守恒纪律 |
|---|---|---|---|
| **① 生产插件核心** | `index.js` → `src/`（22 个零依赖 ESM 模块） | 在宿主流 `llm/stream` 内拦截 `reasoning` 块，完成 CAS 归档 + 副模型认知编译 + 程序门核真（`compileV4Direct`）+ 程序部件拼接（`spliceProgramParts`）+ 六道放行门（`birthAccept`） | 267 份历史稿逐字回归 + 29 套 selftest 零失败 |
| **② 统一科学训练闭环与双轨裁判** | `tools/cfb-cycle.mjs` + `tools/cfb-judge.mjs` + `tools/bench-run.mjs` + `tools/traj-run.mjs` | 三模式闭环（手写探顶 → 金标基准 → 影子分叉轨迹）+ 四维全空间策略搜索 + 双轨（确定性规则 × LLM 语义）交叉验证与岭回归校准 + 五大国际官方基准成绩单 | 零污染客观锚点 + 跨计划 CAS 缓存 + 序贯 $e$-value 安全晋升 |
| **③ 有界 API 账本与训练数据核** | `tools/effect-ready.mjs` + `tools/bounded-ab.mjs` + `src/training-core.js` | 双平面预占 API 预算（一 scope 一冻结批准，收据入库 `transfer/`）+ 5 家族连通组严格隔离的 SFT / DPO / In-Context DPO 导出 | 严禁跨家族泄漏与未批准真实扣费 |

**状态目录职责**：
- `.cfb-offline/`（gitignored）：**可再生**离线闭环状态（策略池 / 计划 / 金标 / 效度账本 / 飞轮对）。新克隆执行 `npm run restore` 即可从 `transfer/cycle-state.json` 完整重建。
- `.cfb-runtime/`（gitignored）：**不可再生**私有运行仓与轨迹回执（bounded-ab 各 scope 私有仓、`traj/tN`）。
- `transfer/`（入库）：公开水位收据、周期快照 `cycle-state.json`、`gold/` 金标库、历史实验数据与 [`HANDOFF.md`](../transfer/HANDOFF.md)。

---

## 1. `src/` 模块依赖地图（自顶向下，无环）

包入口 `index.js` 只做导出（`package.json` 的 `exports` 仅开放 `.`），宿主拿到 `name` / `inject` / `apply`，其余纯函数导出供自测与离线闭环工具直接调用：

```
plugin.js ─────────────────────────────── 组合根：apply() 注册 agent/pre-step 与 llm/stream 钩子
  ├─ boot-record.js       BOOT 上岗自证（生效配置、SELF_ID / DEP_ID、版本号）
  ├─ host-follow.js       调用级模型 / provider 跟随（派生单次调用配置副本，共享 cfg 永不改写）
  ├─ session-tracker.js   会话归属追踪（多会话交错 ⇒ 不可证，原文放行）
  ├─ handle-probe.js      CAS 句柄读回探针（可读回 / 读不回 / 不可证）
  ├─ birth.js ─────────── ★ 出生即压缩主干：birthTransform / birthStart / birthFinish / effectiveBirthMinChars(λ) / readPressure
  │    ├─ fidelity.js       逐字标识符召回率（观测）+ 发明标识符拦截闸（inventedIdentifiers）
  │    ├─ tokens.js         按书写系统区分的 token 粗估（中文 0.6/字、其余 0.3/字）
  │    └─ trace.js          trace 落盘（64 MiB 轮转）与 settled 字段白名单
  ├─ distill.js ───────── 副模型调用（重试降级 / 对冲 hedge / 传输 trace）+ makeBirthCompiler + In-Context DPO 范例注入
  │    ├─ prompts.js        提示词（v3 / v2 / v4-ops / v4d6 直写）+ modularPromptPrune 反稀释动态裁剪
  │    ├─ compile-v4.js     ★ v4 认知编译器：JSON ops 编译（parse→validate→select→render）+ compileV4Direct 直写程序门 + compactStateParts
  │    ├─ segment-v4.js     v4 流式增量分段编译（长思维链边写边编，收网只等尾段）
  │    ├─ policy.js         可训练策略空间（提示词 / 部件开关 / 制度参数 / 范例对）校验与 digest 计算
  │    └─ transport.js ─ provider.js ─ config.js
  ├─ messages.js          出站消息溯源、台账（ledgerBlock）提取、有界延续段（continuationPath:'bounded'）与曾涉文件出处保留
  ├─ evidence-program.js ─ evidence-store.js   宿主显式类型化证据程序与 CAS 签名块仓（默认关）
  └─ training-core.js     纯函数训练内核：5 家族连通组切分、SFT/DPO 导出、严格逐项发布门
```

---

## 2. 核心数据流与四维极限化机制

### 2.1 `birth`：一个 `reasoning` 块的完整生命期（`src/birth.js`）

```
birthTransform(inner, deps)
  block-start(reasoning) → birthHoldNew + 立即透传
  reasoning-delta        → 累积原文 + 实时透传（live）；若开启 v4 流式增量则同步喂给 segmenter
  block-end(reasoning)   → birthStart(entry, deps)   ← 同步返回 task，绝不阻塞主流
                              1. 动态 λ 门槛判定：effectiveBirthMinChars(cfg, meta)
                                 - 默认 birthMinChars = 3100
                                 - birthAdaptiveFloor: true 时：round ≤ 2 → 4200（保护早期探索）；
                                   round ≥ 4 → 1800（清理深轮膨胀）；stagnantRounds ≥ 2 → 1200（停滞期强制注入死路疫苗）
                              2. 内存秒算句柄：deriveArtHandle(sessionId, raw)
                              3. 并行发起：diskP = deps.archive(raw) 与 distillP = deps.distill(raw, signal, ...)
  finish                 → birthFinish(task, deps)   ← 押后至流结束收网
                              等 min(finishWaitMs, 实际耗时)；已收到 200 响应头则宽限 finishHeadersGraceMs（一次）
                              六道门禁顺序：归档成功 → 编译非空 → 无发明标识符 → 字符净省 → token 严格下降 → 替换成功（condensed）
                              任何一道未过 ⇒ birthCancelFlying 立即取消在途请求，100% 原文放行（passthrough）
```

### 2.2 `compile-v4`：两条认知编译通路（`src/compile-v4.js`）

1. **`v4d6` 直写通路（`compressPrompt: 'v4', compressV4Direct: true`，当前主力）**：
   - **压缩前准备**：`messages.js` 从本轮工具输出中剥出带行号的**在手代码行**（`inHandLines`）与历史**台账/延续段**（`applyCtxContinuationPolicy`），若策略含 `exemplars` 则由 `distill.js` 自动拼入 In-Context DPO 正反对比范例，若开启 `modularPromptPrune: true` 则由 `prompts.js` 动态剥离当轮不触发的提示词规则块。
   - **程序门核真（`compileV4Direct`）**：副模型输出主模型原生语域的紧凑散文后，代码机械校验：
     - 反引号标识符与代码锚点必须逐字有出处；
     - 尾段判读分支必须闭合（`如果…就…`），不得留悬空问句；
     - `edit_file` 三元组 `old_text` 必须出自【在手】行，且 `new_text ≠ old_text`；
     - 宿主工具名自动对齐。
   - **程序部件拼接（`spliceProgramParts`）**：
     - `continuationPath: 'bounded'`：将 O(轮数) 增长的已走路径截断为最近 2 条，并在 `【台账】` 摘要末尾保留被截断轮次涉及的文件/标识符出处（`；曾涉 ...`），彻底消除 bounded 续接下的 `invented-identifier` 误杀；
     - `statePartsMode: 'compact'`（`compactStateParts`）：自动扫描压缩正文已逐字包含的反引号锚点，剔除 `【已排除】` 与 `【未解】` 中的重复复述行（当轮净省再增 `+50~+90 tok`）。

2. **`v4-ops` 结构化条目通路（`compressV4Direct: false`）**：
   - 副模型只输出八类带类型的 JSON 原子条目（`FACT / COMPUTED / INCUMBENT / REFUTED / SHELVED / OPEN / PLAN / READY`）；
   - `compileV4` 依次执行 `parseOps` → `validateOps`（I1 锚点逐字、I2 标识符出处、I3 证伪带替代、I4 无观测否定降级为搁置、I5 工具来源不写主观决定、I7 同键留最新、I8 禁第二人称）→ `selectOps`（必留项 + 价值/字符比贪心装箱 + 依赖闭包）→ `renderOps`（证据定粘性、替代先行+否定就近）。

---

## 3. 十二条核心不变式（违反即判定回归失败）

1. **H2 首次出站不变律**：`reasoning` 块只能在尚未出站装配前替换（`birth` 模式天然满足）。
2. **归档先于压缩**：拿不到可读回的 CAS 句柄，绝不替换原文。
3. **观测绝不碰坏主流**：任何内部或网络异常只降级为「原文放行」，主流自身的错误原样抛出。
4. **零硬编码猜测**：模型名、端点、密钥均跟随宿主 provider，解析不出即放行。
5. **零编造标识符（I2）**：压缩稿中的路径、URL、反引号代码、`camelCase`、`snake_case`、`file.ext` 必须逐字出现在原文或程序部件出处中，否则 `invented-identifier` 原文放行。
6. **字符 ≠ 账单费用**：字符数仅度量上下文余量；真实省钱与否以端到端 token 账单与 `birthMinChars` 成本模型为准。
7. **评估态零副作用**：`dryRun: true`（默认）下不写 CAS、不调副模型、不改流。
8. **句柄可读回验证**：内存预推句柄必须通过读回探针验证后才生效。
9. **放弃即取消**：任何走原文放行的分支都经由 `birthCancelFlying` 立即取消在途请求。
10. **Token 必降门禁**：字符缩短但估算 token 未降 ⇒ `no-token-gain` 原文放行。
11. **共享配置不可变**：运行期随调用变化的模型/provider 仅写入 `host-follow.js` 派生的单次调用副本。
12. **流归属不可证不归档**：多会话交错时缺省原文放行，严禁跨会话污染 CAS。

---

## 4. 「改哪里」速查表

| 需求场景 | 修改位置与同步要求 |
|---|---|
| 新增生产配置项 | `src/config.js` 的 `DEFAULTS` → `index.d.ts` → `test/core.selftest.mjs` §10 |
| 开放新的可训练策略旋钮 | `src/policy.js` 的 `CONFIG_KEYS` / `REGIME_KEYS` → `test/closed-loop-v4.selftest.mjs` |
| 修改提示词或反稀释规则 | `src/prompts.js`（版本号由 `compressPromptVersion` 统一裁决；v2/v3 共享规则 1~6 由 `compress.selftest.mjs` §1b 守护） |
| 修改 v4 程序门或部件拼接 | `src/compile-v4.js`（`compileV4Direct` / `spliceProgramParts` / `compactStateParts`）+ `src/messages.js`（`applyCtxContinuationPolicy`） |
| 修改闭环评测或官方基准公式 | `tools/helpers/ruler.mjs`（`passAtK` / `passHatK` / `arenaElo` / `industryScorecard`）+ `tools/cfb-cycle.mjs` |
| 修改双轨语义裁判或校准器 | `tools/helpers/judge-layer.mjs` + `tools/cfb-judge.mjs` |
| 新增自测套件 | `test/<name>.selftest.mjs`（末尾打印 `PASS=n FAIL=m`），加入 `verify.mjs` 的 `ORDER` |
| 修改任何入库文件后 | 运行 `npm run manifest` 更新 `MANIFEST.sha256`，再跑 `npm run verify:offline` 确认 `884 pass / 0 fail` |

---

## 5. 自测套件矩阵（`29` 套，`884 pass / 0 fail / 1 skip`）

运行 `npm run verify:offline` 并发执行全部 29 套自检（每个套件使用独立临时 `DSH_HOME`）：

| 类别 | 套件名称 | 覆盖范围 |
|---|---|---|
| **生产核心与传输（15 套）** | `provider-endpoint`, `core`, `compress`, `v4`, `v4-live`, `birth`, `robustness`, `hedge`, `hook-wiring`, `hardening`, `concurrency`, `protocol`, `branches`, `audit-2026-09-27`, `v12` | 端点解析、配置归一化、v3/v4/v4d6 全链路编译、流式增量分段、有界延续段、自适应 $\lambda$ 门槛、对冲请求、并发隔离与退役兼容 |
| **科学闭环与双轨裁判（4 套）** | `closed-loop-v4`（A1–A40）, `cfb-judge`, `eval-ready`, `training-ready` | 三模式闭环、跨计划 CAS 缓存、正交因子归因、In-Context DPO、规则×LLM 双轨裁判、岭回归校准、五大官方基准与 `--lite` 省钱模式、5 家族隔离训练导出 |
| **宿主证据与评测（10 套）** | `evidence-program`, `active-checks`, `effect-archive`, `evidence-runtime`, `local-iterations`, `repair-hardening`, `bounded-api`, `live-v8`, `offline-cycle`, `phase0` | 宿主类型化证据块仓、有界 API 预算水位、v8 回放协议与阶段 0 观测审计 |
