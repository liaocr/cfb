# dsh-cot-form-b — reasoning 块「出生即压缩」

> **当前实现：v11.11（2026-09-24）** · 自测：`npm test` 全绿（固定 1 项 SKIP，逐版数字见 CHANGELOG） · 真实产品验收：**未验收**
> CI：`.github/workflows/ci.yml` 在 Node 20 / 22 上跑完整性清单 + 全部自测 + 类型契约。
> 版本沿革见 [`CHANGELOG.md`](CHANGELOG.md)；开发者视角的模块与数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

DSH 外部插件（Cordis 协议）。主模型每写完一段 reasoning，插件在它进入会话**之前**：

1. 把原文写进 CAS（内容寻址存储，可按 `art://` 句柄取回）；
2. 同时请副模型把这段推理压成短摘要；
3. 在 `finish` 前限时收网：归档成功 **且** 摘要成功 **且** 净省达标 ⇒ 用摘要替换这段 reasoning；
   否则原文放行（可附句柄）。任何内部异常只会降级成「原样透传」，绝不碰坏主流。

替换发生在宿主装配 assistant 消息之前，走的是**普通 append**，不需要 `surfaceOp: replace`。
后续每一轮携带的都是短摘要。字符数只是上下文余量的度量，**不是费用节省**。

---

## 快速开始

```bash
npm test                    # = node verify.mjs：并发跑全部自测套件（本地 HTTP，零外部 API 调用，约 9s）
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
│   ├── birth-claim.js    下轮收网（Deferred Claim，实验）的 pre-step 逻辑
│   ├── checkpoint.js     checkpoint 模式：early-fire + pre-step 看板发射
│   ├── handle-probe.js   句柄读回探针（三态：可读回 / 读不回 / 不可证）
│   ├── config.js         DEFAULTS + normalizeConfig（退役/未知键留痕）+ 编译模式裁决
│   ├── birth.js          ★ 出生即压缩：birthTransform / birthStart / birthFinish / 成本模型
│   ├── distill.js        副模型调用：重试降级、对冲、传输 trace；memory 模式的状态编译
│   ├── prompts.js        提示词（legacy / compress-v2 / compress-v3）与版本号
│   ├── extractive.js     v11.12 compress-x1 抽取式：切句 / 选择解析 / 逐字拼装与硬校验（缺省关）
│   ├── transport.js      HTTP 传输（keep-alive、4MB 上限、SSE/JSON 按实际协议解析）
│   ├── provider.js       端点与凭据解析（跟随宿主 provider，解析不出来不猜）
│   ├── late-memory.js    迟到结果暂存区（Deferred Claim，实验）
│   ├── evidence.js       从会话只读采集证据（memory 模式）
│   ├── messages.js       出站消息溯源（只观测）
│   ├── trace.js          trace 落盘（v11.10 按大小轮转）与 settled 字段白名单
│   ├── tokens.js         按书写系统区分的 token 粗估（中文 0.6/字、其余 0.3/字；估算不是账单）
│   ├── fs-lock.js        独占锁文件 + 「持锁进程已死」的保守接管（三处持久化共用）
│   ├── fidelity.js       受保护 token 与逐字标识符召回率
│   ├── state-memory.js   证据信封 / 判断编译 / 记忆投影 / 渲染（纯函数）
│   ├── snapshot-store.js 结构化状态快照持久化（原子写、归并、精确覆盖集合）
│   ├── evidence-ledger.js / evidence-input.js / evidence-storage.js   确定性证据账本（memory 模式）
│   ├── emitter.js / balanced-span.js / headroom.js / imperative.js   pre-step 看板发射器（迟到认领 / checkpoint）
│   └── exact-flights.js / consumption.js   精确在途请求共享 / 认领消费计量
│
├── test/                 *.selftest.mjs 套件（verify.mjs 自动发现）+ fixtures/（真机原文错误样本）
├── .github/workflows/    CI：完整性清单 + 全部自测 + 类型契约（Node 20 / 22）
├── tools/                离线分析：analyze-trace / analyze-efficiency / analyze-consumption / replay / benchmark-index
│                         v11.12：cf-eval（反事实续写评测）/ acon-optimize（抽取准则自进化）/ cf-fixtures/
├── deploy/onboard.mjs    部署体检（注册形态、部署漂移；跨机器、无硬编码路径）
└── docs/                 现行文档；docs/archive/ = 历史报告与证据（只进不出）
```

---

## 模式

| `mode` | 做什么 | 状态 |
|---|---|---|
| `'birth'`（缺省） | 在 `llm/stream` 里扣住 reasoning 块，CAS 归档 + 副模型压缩后放行 | **唯一生产路径** |
| `'checkpoint'` | pre-step 用官方 `user/message` 看板整段替换已出站的推理（emitter.js） | 实验 |
| `'off'` | 完全不介入 | — |
| `'distill'` / `'rules'` | **v11.8 退役**：写回路径被宿主协议永久禁止（恒为 `replace-refused-h2`），`distill` 还会白发副模型调用 | 按 `'off'` 处理，BOOT 的 `retiredMode` 可见 |

`dryRun` 缺省 **`true`**：birth 模式下零副模型调用、零改写，只落观测 trace。必须由 profile 显式设 `dryRun: false` 才合闸。

birth 模式内部再按编译模式三选一（唯一裁决点 `resolveCompileMode`）：

| 开关 | 编译模式 | 副模型输入 → 产物 |
|---|---|---|
| `stateCompress: true` | `compress` | 只有这段 reasoning → 它的摘要（**压缩**；配合 `compressPrompt`） |
| `stateMemory: true` | `memory` | 证据账本 + 状态快照 + 这段 reasoning → 两栏判断稿（**状态记忆**） |
| 都不开 | `legacy` | 这段 reasoning → 旧三态蒸馏提示词 |

两者都开时 `memory` 生效，BOOT 记 `compileModeConflict`（不抛错）。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（`- id: cot-form-b` + `config:`）。⚠ patch 的 `config` 是**整体替换**、不是深合并。
嵌套写法 `distill: {...}` / `birth: {...}` 与扁平键等价，嵌套优先。

**起步示例**（压缩模式；数值依据见 [`docs/AUDIT-V11.5.md`](docs/AUDIT-V11.5.md)）：

```yaml
- id: cot-form-b
  config:
    mode: birth
    dryRun: false            # 先保持 true 跑一段金丝雀，确认 BOOT 与 trace 正常后再合闸
    stateCompress: true
    compressPrompt: v3       # 绝对长度目标 250~450 字符
    birth:
      finishWaitMs: 12000    # finish 处最多等多久（线上用值）
    timeoutMs: 20000         # 副模型单次请求硬超时（线上用值）
```

**常用键**（完整列表与每个值的来历见 `src/config.js` 的 `DEFAULTS`，类型见 `index.d.ts`）：

| 键 | 缺省 | 说明 |
|---|---|---|
| `mode` / `dryRun` | `'birth'` / `true` | 见上 |
| `stateCompress` / `stateMemory` | `false` / `false` | 编译模式 |
| `compressPrompt` | `'v2'` | `v1` 旧蒸馏 · `v2` 相对长度 · `v3` 绝对长度（`compressTargetMin/Max` = 250/450）· **`x1` 抽取式**（v11.12，见下行） |
| `extractive*` | 见 `DEFAULTS` | **v11.12，仅 `compressPrompt: x1`**：副模型只回句子编号、证实/否定标签和状态变量，正文由本地从原文逐字拼装；「证实」必须有逐字证据，否则降级；句柄已验证时首行写原文句柄。`extractiveTailChars` 400 · `extractiveMaxKeepRatio` 0.7 · `extractiveRepairMax` 6 · `extractiveEvidence` true · `extractiveEvidenceLimit` 12 · `extractiveHandleLine` true · `extractiveGuideline` ''（`tools/acon-optimize.mjs` 的产物）。详见 `docs/RESEARCH-COT-SHAPING.md` §10 |
| `birth.minChars` | `3100` | 短于此长度不压缩（成本模型反解：R=60、d=0.02、B′≈450 ⇒ 保本原长 2,747，保守取整且不下调） |
| `birth.minTokens` | `null` | **v11.10 opt-in**：正数 ⇒ 按 token 估算判定、完全接管 `minChars`（3100 字符对英文 ≈ 930 token、对中文 ≈ 1,860 token，同一门槛随语言差 2 倍） |
| `birth.tokenGate` / `birth.minSavedTokens` | `true` / `0` | **v11.10**：字符净省达标但估算 token 不降 ⇒ 原文放行（`why=no-token-gain`；典型是英文原文 → 中文摘要）。`minSavedTokens` 0 按 1 计 |
| `birth.finishWaitMs` | `1500` | finish 处收网等待上限 |
| `birth.finishHeadersGraceMs` | `1500` | 到点时若副模型已收到 200 响应头（正在生成），再多等的上限；`0` 关 |
| `timeoutMs` | `8000` | 副模型请求硬超时。birth 且未开迟到认领时，自动抬到 ≥ `finishWaitMs + finishHeadersGraceMs + 2000`（BOOT `configAdjusted` 留痕） |
| `maxOutputTokens` | `850` | 恒定，不随输入放大 |
| `distill.hedgeAfterMs` | `0`（关） | 对冲请求：N ms 内没有 200 响应头就再发一份，先回头者胜；建议 ≥ TTFB p50（约 3000） |
| `compressSystemPrompt` | `false` | 压缩提示词拆成 system（规则前缀）+ user（原文），字节等价，便于前缀缓存命中；promptVersion 追加 `:sys` |
| `emitterSelectiveArchive` | `true` | **P1**：归档行后附「工具名 + 参数摘要 + 内容样本 +（选择性）头尾摘录」。只改视图，归档一律原文；关掉 = 只留句柄（A/B 对照腿） |
| `emitterToolSampleChars` | `120` | **P1**：内容样本长度上限（`0` = 连富化段都不出，最省） |
| `emitterExcerptChars` | `800` | **P1**：选择性摘录预算。错误现场给「错误行 + 上下文」，最近结果给头尾；中间显式标出省略 |
| `emitterKeepRecentToolResults` | `2` | **P1**：「最近 N 条工具结果」判定（模型刚跑完、大概率正在引用 ⇒ 先给一眼，省一次回读） |
| `emitHandleProbeMax` | `2` | **P0-2**：checkpoint 发射前按句柄读回抽样验证此条数；只有「正面证伪」才拦住发射（保持原文）。无读 API 的宿主自动退化为只记录 |
| `birth.probeTimeoutMs` | `800` | **P0-2**：birth 内存预推句柄的读回验证限时；超时=不可证 ⇒ 原文放行（绝不用没验证过的地址顶替原文） |
| `birthDeferredClaim` | `false` | **实验**：没赶上 finish 的结果进暂存区、下一轮 pre-step 认领（见「当前状态」缺陷 B）；只认显式 `true` |
| `followHostModel` / `followHostProvider` | `true` / `true` | 副模型、端点、钥匙都跟随宿主当前对话所用的 provider；解析不出来就不发起（不猜）。v11.11 起按**每次调用**派生（本次调用带的模型 → 最近见过的宿主模型 → 显式 `model`），不再改写共享配置 |
| `birthSessionAmbiguity` | `'passthrough'` | **v11.11**：多个会话交错进入 pre-step、这条流属于谁不可证时：`passthrough` 原文放行（不归档不压缩），`'latest'` 回到旧行为（按最近 pre-step 的会话）。单会话宿主永不触发 |
| `trace` / `traceFile` | `true` / `$DSH_HOME/storages/cot-form-b/trace.log` | 观测 |
| `traceMaxBytes` | `64 MiB` | **v11.10**：超限把 `trace.log` 改名 `trace.log.1`（覆盖上一份）再续写，新文件首行 `trace-rotated`、紧跟一份 `BOOT` 副本（`rotatedCopy:true`，保证离线分析仍能按构建归组）；`0` = 不轮转 |
| `tracePreviewChars` | `48` | **v11.10**：`llm-stream` 溯源里用户原话开头片段长度；`0` = 不记录任何正文片段 |

配置自检（全部进 BOOT，只报不抛）：
- `unknownOptions`：不认识的键，包括嵌套容器里拼错的（如 `birth.finishWait`）；
- `retiredOptions`：已退役的键（v7 的 4 个旧开关、v11.8 随 distill/rules 退役的键与整个 `rules:` 容器、v11.10 的 `birthHandleInText` / `birth.handleInText`），已从生效配置删除；
- `retiredMode` / `invalidMode`：写了退役或不认识的 `mode`（生效值为 `'off'`）；
- `configAdjusted`：自动调整（目前只有 `timeoutMs` 抬高）。

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
                                      ├─ 归档成功 && 压缩成功 && 净省 ≥ birthMinSavedChars ⇒ 改写 block-end.text
                                      └─ 否则原文放行（+句柄）；在飞请求被取消
                                          └─ 仅 birthDeferredClaim:true：不取消、结果进暂存区，下一轮 pre-step 认领
```

四条硬约束（违反即坏，出处见 `src/birth.js` 文件头）：`block-start` 立即透传；`finish` 押后到最后；
**归档先于压缩**（归档失败 ⇒ 原样透传，原始推理绝不因压缩而丢失）；主流自己的错误原样抛出，插件内部异常只降级为原样重放。

---

## 状态记忆与快照（`stateMemory: true` 时）

compress 模式不采集证据、不写快照；以下只在 memory 模式生效。

- **确定性证据账本**（`evidence-ledger.js`）：工具事件先落盘到 `$DSH_HOME/storages/cot-form-b/evidence-v1/`（总配额 256MB / 10 万文件，单作用域 64MB / 2 万文件），
  持久化不依赖副模型成功；满额或 I/O 失败时用当轮内存证据继续编译，不伪造索引。
- **结构化快照**（`snapshot-store.js`，`$DSH_HOME/storages/cot-form-b/snapshots/`）：编译成功后把完整有效状态存下来，看板只负责展示。
  - 先归并再写（磁盘现值是权威基线，迟到的旧任务不可能覆盖更新的快照）；先写完整快照再原子替换（tmp + rename）；
  - 覆盖判定用**精确成员集合** `coverage.coveredSeqs`，不用水位线（水位线会连带跳过未采集和迟到返回的结果）；
  - 「编译已覆盖」（`coverage.at`）与「宿主已应用」（`applied`）严格分开，永不互相赋值；
  - v11.8：同一陈述反复提交只留最后一次，条目总数封顶 256（此前会无限增长）。
- 关联靠插件自己保存的 `(sessionId, branchId)` 指针，**不**解析消息文本、不认 role、不认看板标记。
- **锁**（v11.10，`fs-lock.js`）：三处持久化都用独占锁文件，内容为 `pid@hostname@ms`。只有**同机且持锁 pid 已不存在**时才接管
  （崩溃残留锁不再让 memory 模式永久降级）；活进程、别的机器、旧格式/空锁文件一律照旧 fail-closed。
  v11.10 之前崩溃留下的**空锁文件**无法证明持有者已死，仍需人工确认后删除。

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
| `stateCompress: false`（且 `stateMemory: false`） | 回到 legacy 蒸馏提示词 |
| `compressPrompt: 'v2'` / `'v1'` | 回到相对长度目标 / 旧蒸馏提示词（x1 抽取式同样一键回滚） |
| `distill: { hedgeAfterMs: 0 }` | 关闭对冲（缺省即关） |
| `birth: { finishHeadersGraceMs: 0 }` | 关闭响应头宽限 |
| `birthDeferredClaim: false` | 关闭下轮认领（缺省即关） |
| `birthArchive: false` | 关闭 CAS 归档（⚠ 同时意味着不再压缩：归档先于压缩） |
| `stateSnapshot: false` | memory 模式停止读写快照与证据账本 |
| `stateCoveredEvidence: false` | memory 模式停止按覆盖集合过滤旧证据（全量发送） |
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
| `birth-fired` / `birth-condensed` / `birth-passthrough` | 起火、替换成功（含 `fidelity.identifierRecall`、v11.10 `rawTokensEst/outTokensEst/netSavedTokensEst`）、放行原因（含 `no-token-gain`） |
| `birth-flush` / `birth-consumer-return` / `birth-distill-cancelled` | **v11.10**：硬停 / 源流无 finish / 源流抛错时的降级放行，消费者提前退出；在飞提纯是否被取消（`why`） |
| `llm-stream` | 出站消息溯源；v11.10 起 `roles` 为游程字符串（`system user assistant tool*3`），`reasoningChars` 为稀疏 `[[下标, 字符数], …]` |
| `trace-rotated` | **v11.10**：轮转后新文件的第一行（上一份文件名与字节数） |
| `birth-session-ambiguous` | **v11.11**：流归属不可证（`candidates` = 窗口里的会话，`action` = 处置） |
| `birth-distill-settled` 的 `prompt/output{Wide,Other}Chars` | **v11.11**：按书写系统的字符数（只有数量），与同行 `providerReportedUsage` 一起用于校准 token 估算 |
| `birth-distill-settled` | 副模型真工期与阶段：`ttfbMs`、`totalMs`、`promptVersion`、`hedged`、失败 `stage` |
| `compiler-transport-*` / `compiler-hedge-*` | 每次请求的发出与结算、对冲是否触发与胜者 |
| `birth-econ` / `birth-window-probe` | 成本模型三态判定、免费窗口时刻（只记录，不参与判定） |
| `state-envelope` / `state-snapshot-committed` | memory 模式的输入画像与快照提交 |
| `birth-claim-*` | 迟到认领漏斗（仅 `birthDeferredClaim:true`） |
| `emit-gate` / `emit-net-savings` / `emit-net-savings-result` | checkpoint 闸门读数：`sourceChars`、`netSavedChars`、`enrichChars`、`casWrites`、真 token 水位 |
| `ledger-built` / `ledger-archive-commit` | 看板构成（`toolResultBuckets` 四桶直方图）、归档写入量与失败数、富化代价 |
| `emit-handle-verify` / `handle-probe-*` | **句柄读回验证**：`resolved` / `unresolvable` / `unverifiable` 三态（读不回是唯一的静默失效模式） |

离线分析：`npm run trace:audit -- trace.log`（按 BOOT 分组，不同构建绝不混算）、`npm run trace:efficiency -- trace.log`（耗时、promptVersion 分桶、保真度、对冲）。

### 工具结果路径的验收口径（真机 A/B 怎么判）

`npm run trace:audit -- trace.log` 输出里的 `toolResultPath` 就是判据本身：

- `chars.netSavedChars` —— **只算真正发射的尝试**（被闸门拦下的尝试既没省上下文也没改表面，不得计入），
  且已扣掉 P1 富化的视图代价（`enrichChars`）；`netSavedIfHandleOnly` 是「完全不做富化」的对照上界。
- `breakeven.fullReadBacksAffordable` —— **净下降 ÷ 归档条目均长** = 还能整块回读几次；超出即亏。
  这就是判据「净下降 − 读回成本 > 0」的可读数形式（宿主侧的回读次数只有宿主 trace 看得到，故给预算而非常量）。
- `handle.*` —— 句柄读回验证的三态分布；`archive.rechecks` > 0 表示归档失败真实发生过（看板已被迫回退内联）。
- 单位纪律：`chars` 是字符，不是钱。真账单必须用宿主 `tokenMeter` / `usage`；
  `measuredSurfaceTokenDelta` 仅在配置了 `emitterMeasureTokens` 且**非**评估态时才有值。

### token 估算要不要改系数（v11.11）

`npm run trace:audit -- trace.log` 每组新增 `tokenCalibration`：用副模型自报的 usage 对
`tokens ≈ 中文字数·W + 其他字数·O + C` 做最小二乘，给出拟合系数、现行 0.6/0.3 的偏差（`estimateOverActual`）
与两者的平均百分比误差（`currentMape` / `fitMape`）。`followHostModel`（缺省）下副模型 = 对话模型，
所以拟合出的就是 token 闸门该用的系数。样本少于 3 条、只有一种书写系统、或样本共线时不给该维度的系数（不猜）。
memory 模式的提示词在内部拼装，不产生校准样本。

### birth 收网等待该给多少（v11.10）

`npm run trace:audit -- trace.log` 每组新增 `birth`：结局漏斗（`outcomes`、`condensedRate`、`flush`、`cancelled`）与
`needWaitMs` = 副模型真工期 − 免费窗口（block-end → finish 本来就有的时间，按 `taskId` 关联）——
即「这一块要在 finish 处**再等多久**才能拿到摘要」。`finishWait.coverageAtConfigured / coverageWithGrace`
给出当前 `finishWaitMs`（+响应头宽限）覆盖了多少比例的成功结果，`candidates` 给 p50/p75/p90 候选值。
取值是延迟与收益的产品权衡，工具只给数据、不下结论。

---

## 当前状态（诚实版）

**已完成、自测覆盖**：birth 压缩主路径与四条硬约束；compress-v3；成本模型门槛（3100）与恒定输出上限（850）；
**v11.9 评估态零副作用**（评估态不写 CAS、不改表面，且仍能算出净收益与真 token 水位）；
**v11.9 句柄读回验证**（发射前抽样按句柄取回；birth 内存预推句柄须先验证，无证据则原文放行）；
对冲、响应头宽限、缓存友好拆分（均可关）；配置自检；memory 模式的证据账本与有界快照；测试隔离。

**v11.11 并发正确性**：模型/provider 跟随不再改写共享配置（此前 checkpoint 的 early-fire 会用到**别的调用**的模型，已由测试复现）；
流归属交错检测（缺省原文放行）；Responses 协议端到端测试；token 估算校准链路；`plugin.js` 拆为接线层（618 → 188 行）。

**v11.10 加固**：放弃应用的每条路径都取消在飞提纯（此前硬停 / 无 finish / 源流抛错 / 用户取消四条路径会白跑到 `timeoutMs`）；
token 闸门；崩溃残留锁的保守接管；trace 轮转；provider/凭据解析按文件身份缓存；编译器工厂可单测；测试并发（36s → 14s）；CI。

**v11.9 P1 工具结果可检索化**：归档行带工具名/参数/样本，错误现场与最近结果附摘录 —— 目标是**压低回看概率**
（保本点 = 每项平均读回一次，读回粒度比压缩率更决定胜负）。代价口径单列：`enrichChars` 与
`netSavedIfHandleOnly`，供 A/B 归因。

**只观测、未接管判定**：按剩余窗口的动态门槛（`birth-econ`）、保真度放行门槛（`identifierRecall`）、
提前到「第一个非 reasoning 块」起火（`birth-window-probe`）—— 等真实 trace 标定。

**已知缺陷 / 未完成**：
- **缺陷 B**（迟到认领的多块匹配）未修：`birthDeferredClaim` 缺省关闭时休眠；打开前请读 [`docs/AUDIT-V11.5.md`](docs/AUDIT-V11.5.md) §四；
- **冷启动未解决**：快照只在本机文件里；`recoverSnapshot`（从 CAS 恢复）、`markSnapshotApplied`（宿主已应用标记）、
  `createEvidenceArchiver` 代码在但**未接线**；
- 真实产品验收（完整会话、任务质量 A/B、真实 token 账单）**未做**。本地回归不能替代。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | 文档索引（现行 / 历史） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 模块地图、数据流、不变式、改哪里 |
| [`docs/INSTALL.md`](docs/INSTALL.md) | 安装、注册形态、改完源码如何生效、排错 |
| [`docs/AUDIT-V11.5.md`](docs/AUDIT-V11.5.md) | 成本模型与收益判据审计（门槛反解表；仍有未落实的建议） |
| [`docs/archive/`](docs/archive/README.md) | 各版本详报、设计稿、简报、原始证据（只进不出） |

---

## 本包不包含什么

有意排除（避免把「某台机器的状态」伪装成「可交付代码」）：`*.bak` 历史备份；绑死本机仓库布局或含硬编码路径的一次性脚本
（`_roles-ab*.mjs`、`restart-gateway.mjs`、`verify-all.mjs` 等）；会话日志、CAS blob、trace 原文（体量巨大且含真实对话内容）。
这些留在原开发机的仓库里，需要时再单独取。
