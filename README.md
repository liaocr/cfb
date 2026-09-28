# dsh-cot-form-b — reasoning 块「出生即压缩」

> **当前实现：v12.1（2026-09-28，单一路径：birth + compress。checkpoint / 迟到认领 / memory 模式 / legacy v1 提示词已删除）** · 自测：`npm test` 全绿（固定 1 项 SKIP，逐版数字见 CHANGELOG） · 真实产品验收：**未验收**
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
│   ├── prompts.js        提示词（compress-v3 缺省 / compress-v2）与版本号
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
│                         cf-eval（反事实续写评测，raw vs v3）+ cf-fixtures/
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
| `compressPrompt` | `'v3'` | `v3` 绝对长度（`compressTargetMin/Max` = 250/450）· `v2` 相对长度（20%~35%）。两者保真规则逐字相同。`x1`（v12.0）/ `v1`（v12.1）已退役，旧配置自动回落 `v3` 并记 `configAdjusted` |
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
**v12.1 发明标识符闸**（摘要编造路径 / 代码标识符 ⇒ 原文放行）；评估态零副作用；
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
- 真实产品验收（完整会话、任务质量 A/B、真实 token 账单）**未做**。本地回归不能替代。

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
