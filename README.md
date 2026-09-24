# dsh-cot-form-b — reasoning 块「出生即压缩」

> **当前实现：v11.8（2026-09-24）** · 自测 **1102 通过 / 0 失败 / 1 跳过，19 套件** · 真实产品验收：**未验收**
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
npm test                    # = node verify.mjs：跑全部 19 个自测套件（本地 HTTP，零外部 API 调用）
node verify.mjs birth hedge # 只跑文件名含关键字的套件
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
│   ├── plugin.js         apply()：注册 agent/pre-step、llm/stream 钩子；BOOT 上岗自证（SELF_ID/DEP_ID）
│   ├── config.js         DEFAULTS + normalizeConfig（退役/未知键留痕）+ 编译模式裁决
│   ├── birth.js          ★ 出生即压缩：birthTransform / birthStart / birthFinish / 成本模型
│   ├── distill.js        副模型调用：重试降级、对冲、传输 trace；memory 模式的状态编译
│   ├── prompts.js        提示词（legacy / compress-v2 / compress-v3）与版本号
│   ├── transport.js      HTTP 传输（keep-alive、4MB 上限、SSE/JSON 按实际协议解析）
│   ├── provider.js       端点与凭据解析（跟随宿主 provider，解析不出来不猜）
│   ├── late-memory.js    迟到结果暂存区（Deferred Claim，实验）
│   ├── evidence.js       从会话只读采集证据（memory 模式）
│   ├── messages.js       出站消息溯源（只观测）
│   ├── trace.js          trace 落盘与 settled 字段白名单
│   ├── fidelity.js       受保护 token 与逐字标识符召回率
│   ├── state-memory.js   证据信封 / 判断编译 / 记忆投影 / 渲染（纯函数）
│   ├── snapshot-store.js 结构化状态快照持久化（原子写、归并、精确覆盖集合）
│   ├── evidence-ledger.js / evidence-input.js / evidence-storage.js   确定性证据账本（memory 模式）
│   ├── emitter.js / balanced-span.js / headroom.js / imperative.js   pre-step 看板发射器（迟到认领 / checkpoint）
│   └── exact-flights.js / consumption.js   精确在途请求共享 / 认领消费计量
│
├── test/                 19 个 *.selftest.mjs 套件 + fixtures/（真机原文错误样本）
├── tools/                离线分析：analyze-trace / analyze-efficiency / analyze-consumption / replay / benchmark-index
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
| `compressPrompt` | `'v2'` | `v1` 旧蒸馏 · `v2` 相对长度 · `v3` 绝对长度（`compressTargetMin/Max` = 250/450） |
| `birth.minChars` | `3100` | 短于此长度不压缩（成本模型反解：R=60、d=0.02、B′≈450 ⇒ 保本原长 2,747，保守取整且不下调） |
| `birth.finishWaitMs` | `1500` | finish 处收网等待上限 |
| `birth.finishHeadersGraceMs` | `1500` | 到点时若副模型已收到 200 响应头（正在生成），再多等的上限；`0` 关 |
| `timeoutMs` | `8000` | 副模型请求硬超时。birth 且未开迟到认领时，自动抬到 ≥ `finishWaitMs + finishHeadersGraceMs + 2000`（BOOT `configAdjusted` 留痕） |
| `maxOutputTokens` | `850` | 恒定，不随输入放大 |
| `distill.hedgeAfterMs` | `0`（关） | 对冲请求：N ms 内没有 200 响应头就再发一份，先回头者胜；建议 ≥ TTFB p50（约 3000） |
| `compressSystemPrompt` | `false` | 压缩提示词拆成 system（规则前缀）+ user（原文），字节等价，便于前缀缓存命中；promptVersion 追加 `:sys` |
| `emitHandleProbeMax` | `2` | **P0-2**：checkpoint 发射前按句柄读回抽样验证此条数；只有「正面证伪」才拦住发射（保持原文）。无读 API 的宿主自动退化为只记录 |
| `birth.probeTimeoutMs` | `800` | **P0-2**：birth 内存预推句柄的读回验证限时；超时=不可证 ⇒ 原文放行（绝不用没验证过的地址顶替原文） |
| `birthDeferredClaim` | `false` | **实验**：没赶上 finish 的结果进暂存区、下一轮 pre-step 认领（见「当前状态」缺陷 B）；只认显式 `true` |
| `followHostModel` / `followHostProvider` | `true` / `true` | 副模型、端点、钥匙都跟随宿主当前对话所用的 provider；解析不出来就不发起（不猜） |
| `trace` / `traceFile` | `true` / `$DSH_HOME/storages/cot-form-b/trace.log` | 观测 |

配置自检（全部进 BOOT，只报不抛）：
- `unknownOptions`：不认识的键，包括嵌套容器里拼错的（如 `birth.finishWait`）；
- `retiredOptions`：已退役的键（v7 的 4 个旧开关、v11.8 随 distill/rules 退役的键与整个 `rules:` 容器），已从生效配置删除；
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
| `compressPrompt: 'v2'` / `'v1'` | 回到相对长度目标 / 旧蒸馏提示词 |
| `distill: { hedgeAfterMs: 0 }` | 关闭对冲（缺省即关） |
| `birth: { finishHeadersGraceMs: 0 }` | 关闭响应头宽限 |
| `birthDeferredClaim: false` | 关闭下轮认领（缺省即关） |
| `birthArchive: false` | 关闭 CAS 归档（⚠ 同时意味着不再压缩：归档先于压缩） |
| `stateSnapshot: false` | memory 模式停止读写快照与证据账本 |
| `stateCoveredEvidence: false` | memory 模式停止按覆盖集合过滤旧证据（全量发送） |
| `birth: { minChars: N }` | 调整压缩门槛 |

⚠ 扁平的 `finishWaitMs` 不是配置键（会进 `unknownOptions`），只认 `birth.finishWaitMs` 或 `birthFinishWaitMs`。

---

## 观测

trace 写在 `$DSH_HOME/storages/cot-form-b/trace.log`，一行一条：`[ISO时间] [事件名] {JSON}`。

⚠ 必须**锚定**解析：`llm-stream` 行会内嵌对话正文（可能含字面量 `[BOOT]`）。正则：
`/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[([A-Za-z0-9_-]+)\] (\{.*\})$/`

| 事件 | 看什么 |
|---|---|
| `BOOT` | 生效配置、`selfId`/`deps` 上岗判据、`retired*`/`unknownOptions`/`configAdjusted` |
| `birth-fired` / `birth-condensed` / `birth-passthrough` | 起火、替换成功（含 `fidelity.identifierRecall`）、放行原因 |
| `birth-distill-settled` | 副模型真工期与阶段：`ttfbMs`、`totalMs`、`promptVersion`、`hedged`、失败 `stage` |
| `compiler-transport-*` / `compiler-hedge-*` | 每次请求的发出与结算、对冲是否触发与胜者 |
| `birth-econ` / `birth-window-probe` | 成本模型三态判定、免费窗口时刻（只记录，不参与判定） |
| `state-envelope` / `state-snapshot-committed` | memory 模式的输入画像与快照提交 |
| `birth-claim-*` | 迟到认领漏斗（仅 `birthDeferredClaim:true`） |

离线分析：`npm run trace:audit -- trace.log`（按 BOOT 分组，不同构建绝不混算）、`npm run trace:efficiency -- trace.log`（耗时、promptVersion 分桶、保真度、对冲）。

---

## 当前状态（诚实版）

**已完成、自测覆盖**：birth 压缩主路径与四条硬约束；compress-v3；成本模型门槛（3100）与恒定输出上限（850）；
**v11.9 评估态零副作用**（评估态不写 CAS、不改表面，且仍能算出净收益与真 token 水位）；
**v11.9 句柄读回验证**（发射前抽样按句柄取回；birth 内存预推句柄须先验证，无证据则原文放行）；
对冲、响应头宽限、缓存友好拆分（均可关）；配置自检；memory 模式的证据账本与有界快照；测试隔离。

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
