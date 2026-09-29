# dsh-cot-form-b — reasoning 块「出生即压缩」

> **当前实现：v12.3（2026-09-28，单一路径：birth + compress；opt-in 的 compress-v4-ops 认知编译器 + 流式增量编译）** · 自测：`npm test` 全绿（固定 1 项 SKIP，逐版数字见 CHANGELOG） · 真实产品验收：**未验收**
> CI：`.github/workflows/ci.yml` 在 Node 20 / 22 上跑完整性清单 + 全部自测 + 类型契约。
> 版本沿革见 [`CHANGELOG.md`](CHANGELOG.md)；开发者视角的模块与数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

DSH 外部插件（Cordis 协议）。主模型每写完一段 reasoning，插件在它进入会话**之前**：

1. 把原文写进 CAS（内容寻址存储，可按 `art://` 句柄取回）；
2. 同时请副模型把这段推理压成短摘要；
3. 在 `finish` 前限时收网：归档成功 **且** 摘要成功 **且** 摘要没有编造标识符 **且** 净省达标 ⇒ 用摘要替换这段 reasoning；
   否则原文放行（可附句柄）。任何内部异常只会降级成「原样透传」，绝不碰坏主流。

替换发生在宿主装配 assistant 消息之前，走的是**普通 append**，不需要 `surfaceOp: replace`。
后续每一轮携带的都是短摘要。字符数只是上下文余量的度量，**不是费用节省**。

---

## 快速开始

```bash
npm test                    # = node verify.mjs：并发跑全部自测套件（本地 HTTP，零外部 API 调用，约 8s）
node verify.mjs birth hedge # 只跑文件名含关键字的套件
node verify.mjs --serial    # 串行（排查定时相关问题时用）；-j N 指定并发度
npm run manifest:check      # = node manifest.mjs --check：校验 MANIFEST.sha256（换机器后第一件事）
npm run manifest            # 改过文件后重新生成清单
npm run onboard             # = node deploy/onboard.mjs：体检插件在本机的注册与部署漂移
```

- 零第三方依赖，只用 Node 内置模块（Node ≥ 20，实测 v22）。
- 每个套件都在**临时 `DSH_HOME`** 里跑，自测绝不写真实 `~/.dsh`。
- 固定跳过 1 项：T13（句柄公式与真实 CMB store 逐字比对）需要宿主兄弟包 `dsh-context-memory-bundle`；
  找不到就 SKIP，不算通过 —— 独立仓库的自测不能替代真实宿主验收。

---

## 目录结构

```
dsh-cot-form-b/
├── index.js              包入口：只导出 name / inject / apply 与自测用的纯函数（实现全在 src/）
├── index.d.ts            对外类型契约
├── cordis.patch.yml      bundle 层：用包名把插件插进组合树（零绝对路径）
├── package.json          npm 包清单（dsh.bundle.patch、scripts）
├── verify.mjs            一键跑全部自测（自动发现 test/*.selftest.mjs）
├── manifest.mjs          sha256 完整性清单生成 / 校验 → MANIFEST.sha256
├── CHANGELOG.md          版本沿革
│
├── src/                  实现（全部 ESM，零依赖）
│   ├── plugin.js         apply()：只做接线 —— 注册 agent/pre-step、llm/stream 钩子；BOOT 上岗自证（SELF_ID/DEP_ID）
│   ├── boot-record.js    BOOT 行内容（生效配置与版本号）
│   ├── host-follow.js    宿主模型 / provider 跟随：每次调用派生专属配置，共享配置永不改写（v11.11）
│   ├── session-tracker.js 流归属检测：多会话交错 ⇒ 不可证（v11.11）
│   ├── handle-probe.js   句柄读回探针（三态：可读回 / 读不回 / 不可证）
│   ├── config.js         DEFAULTS + normalizeConfig（退役/未知键留痕）
│   ├── birth.js          ★ 出生即压缩：birthTransform / birthStart / birthFinish / 成本模型 / 水位读数
│   ├── distill.js        副模型调用：重试降级、对冲、传输 trace；makeBirthCompiler（compress-only）
│   ├── prompts.js        提示词（compress-v3 缺省 / compress-v2 / compress-v4-ops）与版本号
│   ├── compile-v4.js     v12.2：v4 确定性编译器（解析 → 不变量校验 → 选取 → 渲染）
│   ├── segment-v4.js     v12.3：v4 流式增量编译（边写边分段起飞，收网只等最后一段）
│   ├── transport.js      HTTP 传输（keep-alive、4MB 上限、SSE/JSON 按实际协议解析）
│   ├── provider.js       端点与凭据解析（跟随宿主 provider，解析不出来不猜）
│   ├── messages.js       出站消息溯源（只观测）
│   ├── trace.js          trace 落盘（v11.10 按大小轮转）与 settled 字段白名单
│   ├── tokens.js         按书写系统区分的 token 粗估（中文 0.6/字、其余 0.3/字；估算不是账单）
│   └── fidelity.js       受保护 token、逐字标识符召回率、发明标识符闸（v12.1）
│
├── test/                 *.selftest.mjs 套件（verify.mjs 自动发现）+ fixtures/（真机原文错误样本）
├── .github/workflows/    CI：完整性清单 + 全部自测 + 类型契约（Node 20 / 22）
├── tools/                离线分析：analyze-trace / analyze-efficiency
│                         cf-eval（反事实续写评测，raw / v3 / v4）+ cf-fixtures/
│                         v4-live（真机：录制 DeepSeek 推理流 → 按原时序回放进生产管线，v3 / v4 / v4 增量对比）
│                         2026-09-27：phase0-report（决议阶段 0 的六个数字 N1–N6，一条命令出判定）
├── deploy/onboard.mjs    部署体检（注册形态、部署漂移；跨机器、无硬编码路径）
└── docs/                 现行文档 + theory/（完整理论）+ analysis/（历史审计与调研）；索引见 docs/README.md
```

---

## 模式

| `mode` | 做什么 | 状态 |
|---|---|---|
| `'birth'`（缺省） | 在 `llm/stream` 里扣住 reasoning 块，CAS 归档 + 副模型压缩后放行 | **唯一生产路径** |
| `'off'` | 完全不介入 | — |
| `'distill'` / `'rules'` | **v11.8 退役**：写回路径被宿主协议永久禁止（恒为 `replace-refused-h2`），`distill` 还会白发副模型调用 | 按 `'off'` 处理，BOOT 的 `retiredMode` 可见 |
| `'checkpoint'` | **v12.1 退役**：pre-step 用看板整段替换已出站推理（上下文里出现「非用户发言的 user 消息」、要维护 carry/区间/净省闸门一整套机器，且从未验收） | 按 `'off'` 处理，BOOT 的 `retiredMode` 可见 |

`dryRun` 缺省 **`true`**：birth 模式下零副模型调用、零改写，只落观测 trace。必须由 profile 显式设 `dryRun: false` 才合闸。

编译只有一种：**compress** —— 副模型只看这段 reasoning，输出它的摘要（提示词见 `compressPrompt`）。
v12.1 前的 `memory`（证据账本 + 快照 → 两栏判断稿）与 `legacy`（三态蒸馏）编译模式已删除；
`stateMemory` / `stateCompress` 成为退役键（`stateMemory: true` 另在 `configAdjusted` 写明现在跑的是 compress）。

### compress-v4（`compressPrompt: 'v4'` 打开；v12.8.8 起缺省走**直写** `compressV4Direct:true`，v12.8.9 提示词 `compress-v4d6`）

> **v12.8.9 现状**：`compressPrompt:'v4'` 时缺省是 **v4 直写**（`compress-v4d6` 提示词：副模型直接写主模型语域的散文；程序把本轮工具结果里的**在手代码行**剥好标记列进提示词，
> 落点只能从中选；程序门 `compileV4Direct` 做机械核真——反引号逐字校验、判读分支闭合、no-op 三元组、new_text 出处、宿主工具名替换）。下面描述的 ops→模板路（`compressV4Direct:false`）仍完整保留。
> 实测（`transfer/effect-23`，同后端 `--require-fp`，两份独立自动稿 × 8 题）：综合 8.5 / 8.6（原文 5.0；手写 oracle 同 8 题 ≈ 8.3），死路 / 错改 / 回头 read 全 0——见 CHANGELOG v12.8.9、理论 S8-R11。
> 真机到位率 4/5 = 80%（v12.8.8 数据），代价是 finish 多扣 p50 ≈ 6 s（`compressV4DirectMinWaitMs`）；稿长均值 ≈ 1630 字、中转抖动是到位率的主要风险。

#### compress-v4-ops（v12.2；`compressV4Direct:false` 时的 v4）

v3 是「请副模型写一份更短的摘要」。v4 把理论（[`docs/theory/CFB-THEORY-COMPLETE.md`](docs/theory/CFB-THEORY-COMPLETE.md) 第五卷 S1–S5）
落成代码：**副模型不写出生文本，只把推理拆成带类型的原子条目（JSON）；出生文本由 `src/compile-v4.js` 确定性地写出。**

| 阶段 | 做什么 | 为什么让主模型更好 |
|---|---|---|
| 标注（副模型） | 八类条目：FACT / COMPUTED / INCUMBENT（当前方案）/ REFUTED（被观测证伪）/ SHELVED（无证据搁置）/ OPEN / PLAN / **READY（原文已想好的具体改法 + 采用前提，v12.4）**；每条带依据（tool/derived/guess）、作用（pivot/verify/restate…）、**原文逐字锚点** | 过程（转弯打折、左右互搏）不再有位置：只剩状态 |
| 校验（代码） | I1 锚点必须逐字在原文；I2 标识符必须有出处；I3 证伪必须带替代方案；I4 无观测的否定降为「搁置」；I5 工具来源不得写成「我决定」；I7 同一量只留最新值；I8 无第二人称。关键结论编造 / 拒绝率过高 ⇒ 整块原文 | 编造被机械检出，而不是靠提示词劝说；「以为证伪了其实只是没试」不会被写成定论 |
| 选取（代码） | 当前方案 / 证伪路 / 未决问题 / 最后 2 条 READY **必留**；复述工具输出、复核已知结论直接剔除；其余按价值/字符在预算内贪心；依赖闭包 | 死路以「疫苗」形式保留，防止重走；冗余不再稀释注意力 |
| 渲染（代码） | 证据定粘性（tool → 陈述带来源；derived → 「目前判断」；guess → 「未验证的猜测」）；**替代先行、否定就近**（「查路径配置（已排除权限问题：chmod 777 后仍 EACCES）」）；计划写过去时；分组：状态 → 当前方案 → 排除/搁置 → 计划 → 未决 → 已备好的改法；尾段 = 关键结论 + 待确认（陈述句）+「若 <前提>，就 <改法>」收束；语言跟随原文 | 否定不单独出现（避免越强调越违反）；确定程度不被抬高；观察一旦证实前提，下一步就是现成的改法（v12.4 效果评测：末尾问句会把主模型推向继续取证） |

失败语义与 v3 相同：任何一步不成立 ⇒ 这块原文放行；渲染稿仍要过发明标识符闸、token 闸与净省判定。
trace：`compiler-v4-compiled`（每次编译的条目数、各不变量拒绝数、选取/丢弃、语言、预算、失败原因）；
`birth-distill-settled` / `birth-distill-failed` 带同一份 `v4` 统计。离线对照：`tools/cf-eval.mjs --variants raw,v3,v4`。

**整块 / 增量自动选择（v12.4）**：`compressV4Incremental: 'auto'`（缺省）⇒ 收网窗口 `birthFinishWaitMs` ≥ 5000 走整块，否则增量。
真机 8 s 窗口：整块 5/5 完整替换（压到 5–9%，多扣 ≈3 s，一次调用、全局视野去重更好、输入 token 少一个数量级）；
增量在同一窗口反而有掉队段（偶发 13 s+）。1.5 s 窗口下整块 0/5、增量 5/5。增量模式另有非尾段对冲（`compressV4SegmentHedgeMs` 7000）与在飞上限（`compressV4MaxInFlight` 3）。

**流式增量编译（v12.3）**：v4 的输出是 JSON（带锚点），比 v3 散文长 2–3 倍，整块等到 block-end 才起飞会装不下收网窗口。
所以思考还在流时，每攒够 `compressV4SegmentChars`（1200）字就在段落 / 行 / 句末处切一段、立即起飞副模型调用；
block-end 时只剩最后一段在飞。到点仍没落定 ⇒ **已编译的连续前缀 + 原文尾巴（逐字）**，结局 `condensed-partial`。
某段失败 ⇒ 该段原文放在渲染稿前面，其余段照用。后段提示词带前段已通过校验的条目，可用 `retracts` 推翻前段结论；
合并时状态后写者胜（只有最新的当前方案 / 未决算数，死路永远保留）。真机记录：[`docs/analysis/V4-LIVE-2026-09-28.md`](docs/analysis/V4-LIVE-2026-09-28.md)。
trace：`v4-segment-fired/settled`、`v4-segments-cancelled`。`compressV4Incremental: false / true` 强制整块 / 增量。

**真机测试**：`DEEPSEEK_API_KEY=… node tools/v4-live.mjs --out live-out`（录制 6 个 Agent 调试回合的真实推理流，
按原时序回放进生产管线，对比 v3 / v4 整块 / v4 增量；`--replay live-out/recordings.json` 复用录音；
`--recompile live-out/report.json` 零调用复用捕获的副模型结果重编译）。

**效果评测**（v12.4）：`node tools/effect-eval.mjs --recordings … --report v4=report.json …` —— 带 tools 的真实请求形态，
把上一轮 `reasoning_content` 换成各变体，给一条后续工具结果，看主模型下一步（盲评 + 规则），并逐次核验中转通道确实把思考送进了模型。
结果与方法：[`docs/analysis/EFFECT-EVAL-2026-09-28.md`](docs/analysis/EFFECT-EVAL-2026-09-28.md)。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（`- id: cot-form-b` + `config:`）。⚠ patch 的 `config` 是**整体替换**、不是深合并。
嵌套写法 `distill: {...}` / `birth: {...}` 与扁平键等价，嵌套优先。

**起步示例**（数值依据见 [`docs/analysis/AUDIT-V11.5.md`](docs/analysis/AUDIT-V11.5.md)）：

```yaml
- id: cot-form-b
  config:
    mode: birth
    dryRun: false            # 先保持 true 跑一段金丝雀，确认 BOOT 与 trace 正常后再合闸
    birth:
      finishWaitMs: 12000    # finish 处最多等多久（线上用值）
    timeoutMs: 20000         # 副模型单次请求硬超时（线上用值）
```

**常用键**（完整列表与每个值的来历见 `src/config.js` 的 `DEFAULTS`，类型见 `index.d.ts`）：

| 键 | 缺省 | 说明 |
|---|---|---|
| `mode` / `dryRun` | `'birth'` / `true` | 见上 |
| `compressPrompt` | `'v3'` | `v3` 绝对长度（`compressTargetMin/Max` = 250/450）· `v2` 相对长度（20%~35%）· **`v4`（v12.2）认知编译器，见上节**。两者保真规则逐字相同。`x1`（v12.0）/ `v1`（v12.1）已退役，旧配置自动回落 `v3` 并记 `configAdjusted` |
| `compressV4BudgetChars` | `null` | 仅 v4：渲染预算（字符），`null` 跟随 `compressTargetMax`。当前方案 / 证伪路 / 未决问题必留，不受预算限制 |
| `compressV4MaxOutputTokens` | `1600` | 仅 v4：副模型输出上限（只抬不降：取 `max(maxOutputTokens, 本项)`） |
| `compressV4Tail` | `true` | 仅 v4：尾段（关键结论 + 待确认 + 已备好的改法） |
| `compressV4MaxRejectRatio` | `0.5` | 仅 v4：硬不变量拒绝占比超过它 ⇒ 整块原文 |
| `compressV4Incremental` | `'auto'` | 仅 v4：`'auto'` ⇒ `birthFinishWaitMs` ≥ 5000 整块、否则流式增量；`true` / `false` 强制 |
| `compressV4SegmentHedgeMs` | `7000` | 仅 v4 增量：非尾段超过这么久没结果 ⇒ 对冲一份（0 关） |
| `compressV4MaxInFlight` | `3` | 仅 v4 增量：同时在飞的段数上限（突发到达时不一次放一串请求） |
| `compressV4SegmentChars` | `1200` | 仅 v4 增量：目标段长（字符，0.6–1.5 倍浮动） |
| `compressV4SegmentTimeoutMs` | `30000` | 仅 v4 增量：非尾段请求超时（不在关键路径上）；尾段仍用 `timeoutMs` |
| `compressV4SegmentMaxOutputTokens` | `1200` | 仅 v4 增量：每段副模型输出上限 |
| `compressV4FirstSegmentChars` | `null` | 仅 v4 增量：首段目标长度（null ⇒ 段长一半，短块更早开编） |
| `compressV4TailStream` | `false` | 仅 v4 增量：尾段走流式，使响应头宽限生效（多等最多 `finishHeadersGraceMs`）；真机实测不划算，缺省关 |
| `birth.identifierGate` | `true` | **v12.1**：摘要里出现原文没有的路径 / URL / 反引号代码 / camelCase / snake_case / `file.ext` ⇒ 原文放行（`why=invented-identifier`，trace 带样本）。`false` 关闭（A/B 对照腿） |
| `birth.minChars` | `3100` | 短于此长度不压缩（成本模型反解：R=60、d=0.02、B′≈450 ⇒ 保本原长 2,747，保守取整且不下调） |
| `birth.minTokens` | `null` | **v11.10 opt-in**：正数 ⇒ 按 token 估算判定、完全接管 `minChars`（3100 字符对英文 ≈ 930 token、对中文 ≈ 1,860 token，同一门槛随语言差 2 倍） |
| `birth.tokenGate` / `birth.minSavedTokens` | `true` / `0` | **v11.10**：字符净省达标但估算 token 不降 ⇒ 原文放行（`why=no-token-gain`；典型是英文原文 → 中文摘要）。`minSavedTokens` 0 按 1 计 |
| `birth.finishWaitMs` | `1500` | finish 处收网等待上限 |
| `birth.finishHeadersGraceMs` | `1500` | 到点时若副模型已收到 200 响应头（正在生成），再多等的上限；`0` 关 |
| `timeoutMs` | `8000` | 副模型请求硬超时。birth 下自动抬到 ≥ `finishWaitMs + finishHeadersGraceMs + 2000`（BOOT `configAdjusted` 留痕） |
| `maxOutputTokens` | `850` | 恒定，不随输入放大 |
| `distill.hedgeAfterMs` | `0`（关） | 对冲请求：N ms 内没有 200 响应头就再发一份，先回头者胜；建议 ≥ TTFB p50（约 3000） |
| `compressSystemPrompt` | `false` | 压缩提示词拆成 system（规则前缀）+ user（原文），字节等价，便于前缀缓存命中；promptVersion 追加 `:sys` |
| `birth.probeTimeoutMs` | `800` | **P0-2**：birth 内存预推句柄的读回验证限时；超时=不可证 ⇒ 原文放行（绝不用没验证过的地址顶替原文） |
| `followHostModel` / `followHostProvider` | `true` / `true` | 副模型、端点、钥匙都跟随宿主当前对话所用的 provider；解析不出来就不发起（不猜）。v11.11 起按**每次调用**派生（本次调用带的模型 → 最近见过的宿主模型 → 显式 `model`），不再改写共享配置 |
| `birthSessionAmbiguity` | `'passthrough'` | **v11.11**：多个会话交错进入 pre-step、这条流属于谁不可证时：`passthrough` 原文放行（不归档不压缩），`'latest'` 回到旧行为（按最近 pre-step 的会话）。单会话宿主永不触发 |
| `trace` / `traceFile` | `true` / `$DSH_HOME/storages/cot-form-b/trace.log` | 观测 |
| `traceMaxBytes` | `64 MiB` | **v11.10**：超限把 `trace.log` 改名 `trace.log.1`（覆盖上一份）再续写，新文件首行 `trace-rotated`、紧跟一份 `BOOT` 副本（`rotatedCopy:true`，保证离线分析仍能按构建归组）；`0` = 不轮转 |
| `tracePreviewChars` | `48` | **v11.10**：`llm-stream` 溯源里用户原话开头片段长度；`0` = 不记录任何正文片段 |

配置自检（全部进 BOOT，只报不抛）：
- `unknownOptions`：不认识的键，包括嵌套容器里拼错的（如 `birth.finishWait`）；
- `retiredOptions`：已退役的键（v7 的 4 个旧开关、v11.8 随 distill/rules 退役的键与整个 `rules:` 容器、v11.10 的 `birthHandleInText`、v12.0 的 `extractive*`、v12.1 的 checkpoint / 迟到认领 / memory 相关键如 `stateMemory` `birthDeferredClaim` `earlyFire` `keepTail` `emitter*` `state*`），已从生效配置删除；
- `retiredMode` / `invalidMode`：写了退役或不认识的 `mode`（生效值为 `'off'`）；
- `configAdjusted`：自动调整（`timeoutMs` 抬高、退役的 `compressPrompt` 回落 `v3`、`stateMemory:true` 改跑 compress）。

---

## 一次 birth 的生命周期

```
主模型流式输出（birth.js · birthTransform）
  ├─ block-start / reasoning-delta ─► 立即透传（主流零延迟）
  ├─ block-end ───────────────────► birthStart()：同步起火，绝不 await
  │                                   ├─ 内存算句柄 art://…（与 CMB store 同一公式）
  │                                   ├─ diskP    : CAS 归档原文（独立超时护栏）
  │                                   └─ distillP : 副模型压缩（一次请求；可对冲）
  └─ finish（押后到最后）─────────► birthFinish()：最多等 finishWaitMs（+ 响应头宽限）
                                      ├─ 归档成功 && 压缩成功 && 非空白 && 无编造标识符 && 净省达标 ⇒ 改写 block-end.text
                                      └─ 否则原文放行（+句柄）；在飞请求被取消
```

四条硬约束（违反即坏，出处见 `src/birth.js` 文件头）：`block-start` 立即透传；`finish` 押后到最后；
**归档先于压缩**（归档失败 ⇒ 原样透传，原始推理绝不因压缩而丢失）；主流自己的错误原样抛出，插件内部异常只降级为原样重放。

---

## 安装与上岗

详见 [`docs/INSTALL.md`](docs/INSTALL.md)。要点：

- 插件按**包名**注册（`dsh.profile.bundles` 列包名 + 包内自带 `cordis.patch.yml`），跨机器、跨盘符零改动；
- `file:` 依赖装进 profile 时是**复制**，改完源码必须删掉副本重装，再 `npm run onboard` 确认 **drift 0**，最后**重启网关**；
- 上岗判据看 BOOT 行：`selfId` = `src/plugin.js` 的 `size@mtimeMs`，`deps` = 包入口与 `src/` 下全部其他模块的 `size@mtimeMs`
  （v11.8 起自动枚举，新增模块不会漏报）。旧模块在内存里根本没有这段代码，所以这是可证伪的判据。

---

## 回滚开关

任何一项都可以单独改，不需要改代码：

| 开关 | 效果 |
|---|---|
| `dryRun: true` | 只观测：零副模型调用、零改写 |
| `mode: 'off'` | 整体停用 |
| `enabled: false` | 总开关关闭 |
| `compressPrompt: 'v3'` | 从 v4 回到散文摘要（缺省） |
| `compressV4Direct: false` | 从 v4 直写散文（v12.8.8 起 v4 的缺省；effect-20 基题 8.5 / 反驳错改 0 / 到位率 80%，见 CHANGELOG v12.8.8）回到 ops→散文路。直写 = 整块编译，收网窗口自动抬到 `compressV4DirectMinWaitMs`（6000），真机 finish 多扣 p50 ≈ 6 s |
| `compressV4DirectBind: false` | 关闭直写稿判读分支的落点绑定（理论 S8-R7；缺省开，见 CHANGELOG v12.7.0）。v12.8 起同一开关还管 R8a 的文件逐字改写（diff `+` / grep 行号剥掉再作 old_text） |
| `compressV4DirectMaxChars: 1300` | 直写稿超长熔断（缺省 2000；v12.7.1 起 1600、v12.8.6 起 1800、v12.8.9 起 2000——v4d5 完整闭合稿 1600–1950 字，2/10 撞 1800 被整份丢掉换原文；熔断的职责只是拦「跑飞」照抄原文） |
| `compressV4DirectMinWaitMs: 0` | 打开直写时不再自动把收网窗口抬到 6000（直写是整块编译，真机 3.6–10.9 s / 块；不抬 ⇒ 几乎必然原文放行） |
| `compressCtxAuto: false` | 不再自动把本回合任务 + 工具结果作为压缩上下文（逐字核真 / 落点绑定会退化为只看推理原文） |
| `compressV4Incremental: false` | v4 回到整块编译（不分段） |
| `compressPrompt: 'v2'` | 回到相对长度目标 |
| `birth: { identifierGate: false }` | 关闭发明标识符闸 |
| `distill: { hedgeAfterMs: 0 }` | 关闭对冲（缺省即关） |
| `birth: { finishHeadersGraceMs: 0 }` | 关闭响应头宽限 |
| `birthArchive: false` | 关闭 CAS 归档（⚠ 同时意味着不再压缩：归档先于压缩） |
| `birth: { minChars: N }` | 调整压缩门槛 |
| `birth: { tokenGate: false }` | 关闭 v11.10 token 闸门（回到纯字符判定） |
| `birthSessionAmbiguity: 'latest'` | 流归属不可证时照旧按最近会话处理（v11.10 行为） |
| `traceMaxBytes: 0` | 关闭 trace 轮转 |

⚠ 扁平的 `finishWaitMs` 不是配置键（会进 `unknownOptions`），只认 `birth.finishWaitMs` 或 `birthFinishWaitMs`。

---

## 观测

trace 写在 `$DSH_HOME/storages/cot-form-b/trace.log`，一行一条：`[ISO时间] [事件名] {JSON}`。

⚠ 必须**锚定**解析：`llm-stream` 行会内嵌对话正文（可能含字面量 `[BOOT]`）。正则：
`/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/`

| 事件 | 看什么 |
|---|---|
| `BOOT` | 生效配置、`selfId`/`deps` 上岗判据、`retired*`/`unknownOptions`/`configAdjusted` |
| `birth-below-floor` | **2026-09-27**：门槛之下（或 archive-off / no-store）直接放行的块，只记 `rawChars` 与 `why` —— reasoning 块长度分布的唯一精确来源（`tools/phase0-report.mjs` 用它算 N2） |
| `birth-fired` / `birth-condensed` / `birth-passthrough` | 起火、替换成功（含 `fidelity.identifierRecall`、v11.10 `rawTokensEst/outTokensEst/netSavedTokensEst`）、放行原因（含 `no-token-gain`、v12.1 `invented-identifier` + `invented` 样本） |
| `birth-flush` / `birth-consumer-return` / `birth-distill-cancelled` | **v11.10**：硬停 / 源流无 finish / 源流抛错时的降级放行，消费者提前退出；在飞提纯是否被取消（`why`） |
| `llm-stream` | 出站消息溯源；v11.10 起 `roles` 为游程字符串（`system user assistant tool*3`），`reasoningChars` 为稀疏 `[[下标, 字符数], …]` |
| `trace-rotated` | **v11.10**：轮转后新文件的第一行（上一份文件名与字节数） |
| `birth-session-ambiguous` | **v11.11**：流归属不可证（`candidates` = 窗口里的会话，`action` = 处置） |
| `birth-distill-settled` 的 `prompt/output{Wide,Other}Chars` | **v11.11**：按书写系统的字符数（只有数量），与同行 `providerReportedUsage` 一起用于校准 token 估算 |
| `birth-distill-settled` | 副模型真工期与阶段：`ttfbMs`、`totalMs`、`promptVersion`、`hedged`、失败 `stage` |
| `compiler-transport-*` / `compiler-hedge-*` | 每次请求的发出与结算、对冲是否触发与胜者 |
| `birth-econ` / `birth-window-probe` | 成本模型三态判定、免费窗口时刻（只记录，不参与判定） |
| `birth-handle-*` / `handle-probe-*` | **句柄读回验证**：birth 内存预推句柄须读回验证通过才采用（读不回是唯一的静默失效模式） |

离线分析：`npm run trace:audit -- trace.log`（按 BOOT 分组，不同构建绝不混算）、`npm run trace:efficiency -- trace.log`（耗时、promptVersion 分桶、放行原因分布 `outcomes`、保真度、对冲）。
决议阶段 0：`node tools/phase0-report.mjs trace.log`（N1 历史 reasoning 是否跨轮保留 / N2 块长度分布 / N3–N4 免费窗口 / N5 宿主模型 / N6 基线 / 健康），操作步骤见 [`docs/RUNBOOK-PHASE0.md`](docs/RUNBOOK-PHASE0.md)。

### token 估算要不要改系数（v11.11）

`npm run trace:audit -- trace.log` 每组新增 `tokenCalibration`：用副模型自报的 usage 对
`tokens ≈ 中文字数·W + 其他字数·O + C` 做最小二乘，给出拟合系数、现行 0.6/0.3 的偏差（`estimateOverActual`）
与两者的平均百分比误差（`currentMape` / `fitMape`）。`followHostModel`（缺省）下副模型 = 对话模型，
所以拟合出的就是 token 闸门该用的系数。样本少于 3 条、只有一种书写系统、或样本共线时不给该维度的系数（不猜）。

### birth 收网等待该给多少（v11.10）

`npm run trace:audit -- trace.log` 每组新增 `birth`：结局漏斗（`outcomes`、`condensedRate`、`flush`、`cancelled`）与
`needWaitMs` = 副模型真工期 − 免费窗口（block-end → finish 本来就有的时间，按 `taskId` 关联）——
即「这一块要在 finish 处**再等多久**才能拿到摘要」。`finishWait.coverageAtConfigured / coverageWithGrace`
给出当前 `finishWaitMs`（+响应头宽限）覆盖了多少比例的成功结果，`candidates` 给 p50/p75/p90 候选值。
取值是延迟与收益的产品权衡，工具只给数据、不下结论。

---

## 当前状态（诚实版）

**已完成、自测覆盖**：birth 压缩主路径与四条硬约束；compress-v3（缺省）；成本模型门槛（3100）与恒定输出上限（850）；
**v12.1 发明标识符闸**（摘要编造路径 / 代码标识符 ⇒ 原文放行）；
**v12.2 compress-v4-ops**（副模型标注 → 代码校验 / 选取 / 渲染，opt-in；本机端到端覆盖，真机未跑）；
**v12.3 v4 流式增量编译**（边写边分段、到点取部分结果；真机 3 条推理流：v4 整块 0/3 → 增量 3/3，长块压到 17–22%）；评估态零副作用；
句柄读回验证（birth 内存预推句柄须先验证，无证据则原文放行）；
对冲、响应头宽限、缓存友好拆分（均可关）；配置自检；测试隔离。

**v11.11 并发正确性**：模型/provider 跟随不再改写共享配置（测试已改为在 birth 路径上复现）；
流归属交错检测（缺省原文放行）；Responses 协议端到端测试；token 估算校准链路；`plugin.js` 拆为接线层（618 → 188 行）。

**v11.10 加固**：放弃应用的每条路径都取消在飞提纯（此前硬停 / 无 finish / 源流抛错 / 用户取消四条路径会白跑到 `timeoutMs`）；
token 闸门；trace 轮转；provider/凭据解析按文件身份缓存；编译器工厂可单测；测试并发（36s → 14s）；CI。

**只观测、未接管判定**：按剩余窗口的动态门槛（`birth-econ`）、保真度放行门槛（`identifierRecall`）、
提前到「第一个非 reasoning 块」起火（`birth-window-probe`）—— 等真实 trace 标定。

**已知缺陷 / 未完成**：
- **工具结果**：本插件只压缩 reasoning；工具结果（上下文里常见的最大一块）不在 birth 能碰到的地方
  （它们来自宿主、不经过 `llm/stream`）。v12.1 删除的 checkpoint 路径曾尝试在 pre-step 里用看板替换它们，
  代价是整段 replace 与非用户发言的 user 消息。正路是宿主协议层的上下文编辑（服务端清理旧工具结果、留占位符），
  见 [`docs/theory/CFB-THEORY-COMPLETE.md`](docs/theory/CFB-THEORY-COMPLETE.md) 的宿主能力等级 C0–C3 —— 需要宿主支持，不在本插件内做；
- **效果（v12.4 首次实测，样本小）**：主模型下一步质量（盲评 0–10）raw 5.8 > v4r 4.6 > v3r 4.2 > 无思考 3.7。
  压缩稿目前**还不如原文**：原文里「已想好的改法」让主模型在观察证实后直接下手，旧 v3/v4 把它当推测删光（v3 更是几乎复述了可见的回答）。
  v12.4 加 READY 后，抽到改法的任务从 2.5 → 7.3；剩余差距主要是 READY 召回不足。详见 [`docs/analysis/EFFECT-EVAL-2026-09-28.md`](docs/analysis/EFFECT-EVAL-2026-09-28.md)。
- 真实产品验收（完整会话、真实 token 账单）**未做**。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | 文档索引（现行 / 理论 / 分析）+ v12.0 / v12.1 删除清单与取回方法 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 模块地图、数据流、不变式、改哪里 |
| [`docs/INSTALL.md`](docs/INSTALL.md) | 安装、注册形态、改完源码如何生效、排错 |
| [`docs/RUNBOOK-PHASE0.md`](docs/RUNBOOK-PHASE0.md) | 阶段 0 纯观测操作手册 |
| [`docs/theory/CFB-THEORY-COMPLETE.md`](docs/theory/CFB-THEORY-COMPLETE.md) | 完整理论：认知编译器、价值函数、v4 规格、疫苗记忆、宿主协议 |
| [`docs/analysis/`](docs/README.md) | 历史审计与调研（成本模型、F1–F11、四轮文献调研）；每篇开头标了 v12.0 下的有效范围 |

v12.0 / v12.1 删除的文件都可从 git 取回：`git show cfba57b:<路径>`（v12.0 前的全部文件）。

---

## 本包不包含什么

有意排除（避免把「某台机器的状态」伪装成「可交付代码」）：`*.bak` 历史备份；绑死本机仓库布局或含硬编码路径的一次性脚本
（`_roles-ab*.mjs`、`restart-gateway.mjs`、`verify-all.mjs` 等）；会话日志、CAS blob、trace 原文（体量巨大且含真实对话内容）。
这些留在原开发机的仓库里，需要时再单独取。
