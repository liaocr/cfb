# dsh-cot-form-b — 尾部即时思维链提纯 + 结构化状态记忆

> **当前实现：v11.7（2026-09-23）** · 验证 **1242 通过 / 0 失败 / 1 跳过，19 套件**。
> 版本沿革与每版细节见 [`CHANGELOG.md`](CHANGELOG.md)；成本模型见 [`docs/AUDIT-V11.5.md`](docs/AUDIT-V11.5.md)。
> ⚠ 判定行为的唯一变化 = 门槛与输出上限；动态门槛、保真放行、提前起火**均未接管**，等真实 trace 数据。
>
> 三条当前要点：
> 1. `birthMinChars=3100`（成本模型反解保本原长 2,959 保守取整）、`maxOutputTokens=850` 恒定；
> 2. v11.7 三个可关的延迟/缓存开关：`hedgeAfterMs`（对冲，缺省关）、`finishHeadersGraceMs=1500`、`compressSystemPrompt`（缓存友好拆分，缺省关）；
> 3. 配置未知键会进 `unknownOptions` 并落 BOOT（不再静默吞掉）；凭据读取已锚定行首，防子串误命中。

DSH 外部插件。当前 `birth + stateMemory` 路径：

1. 固定并记录采集证据；持久化不依赖模型成功。
2. 副模型接收 reasoning、用户／运行材料、工具正文视图及事件状态。普通结果保留原1200字符前缀；错误和最近结果扩展，缺失区间明示。
3. 两栏承载原 reasoning 的必要语义，不把生命周期表当项目状态。
4. 正常迟到认领开启时 ready-only，未就绪原文先走；没有消费者、没有 sessionId 或原文超出保守迟到容量时保留原配置的等待机会。
5. 满额／I/O失败时以当轮内存证据继续编译，不伪造索引，不因记录失败直接停掉副模型。

配置1500／8000／1200、生产模型和 profile 未修改，没有新增启用开关或模型调用链。
原始工具消息不遮蔽、不删除。真实产品验收仍为未验收。

---

## 快速开始

```bash
node verify.mjs        # 跑全部 19 个自测套件（含本地 HTTP；零外部 API 调用）
node manifest.mjs      # 生成 MANIFEST.sha256
node manifest.mjs --check   # 校验完整性（换机器后第一件事）
node deploy/onboard.mjs     # 体检：确认插件在本机装好了
```

`verify.mjs` 只用 Node 内置模块，**无第三方依赖、无硬编码路径** —— 复制到任何机器/容器都能跑。
跑不起来的套件报 `SKIP`；当前独立仓库还会跳过 1 项需要宿主兄弟包的断言，不能视为真实宿主验收。

---

## 目录结构

```
dsh-cot-form-b/
├── verify.mjs                 一键跑全部自测（可移植）
├── manifest.mjs               sha256 清单生成 / 校验
├── README.md                  本文件
├── MANIFEST.sha256            完整性清单
│
├── index.js            245 KB  插件入口：生命周期、证据采集、覆盖过滤、快照接线
├── state-memory.js      96 KB  四层状态记忆：信封 / 编译器 / 投影 / 渲染器
├── emitter.js           33 KB  收网器：唯一发射出口（官方 surfaceOp replace）
├── snapshot-store.js    29 KB  ★ 结构化状态快照持久化（CAS + 原子指针）
├── evidence-ledger.js   17 KB  证据账本准备与判断提示词
├── rules.js             13 KB  规则层压缩（离线、确定性，与模型提纯互为回退）
├── balanced-span.js     12 KB  平衡整步：找可安全替换的 span 边界
├── evidence-storage.js 6.0 KB  证据 CAS 存储
├── imperative.js       3.8 KB  祈使句提取（哪些推理块值得进记忆）
├── evidence-input.js   4.8 KB  证据正文截取
├── headroom.js / evidence-views.js / exact-flights.js /
│   compile-lane.js / consumption.js         小模块（预算、视图、航班、编译道、计量）
├── index.d.ts / rules.d.ts     TypeScript 类型声明
├── package.json                npm 包清单（声明 dsh.bundle.patch）
├── cordis.patch.yml            bundle 层：把插件挂进组合树（写包名，零绝对路径）
├── CHANGELOG.md                版本沿革（自 README 迁出）
│
├── 自测（node verify.mjs 一键，共 19 套件 / 1242 断言）
│   selftest.mjs 317 · selftest-birth.mjs 164 · state-memory 245 · emitter 101
│   balanced-span 60 · optimization 43 · evidence-views 41 · coverage-provenance 41
│   memory-quality 33 · headroom 33 · incremental 29 · provider-endpoint 28
│   imperative 25 · hybrid 16 · hedge 15 · late-identity 15 · efficiency 13
│   grounding 13 · evidence-sharing 10
│
├── analyze-efficiency.mjs / analyze-consumption.mjs / replay.mjs   离线 trace 分析
├── fixtures/                  真机原文错误样本（非合成）
├── deploy/onboard.mjs         安装体检（跨机器，无硬编码路径）
└── docs/                      现行文档；docs/archive/ = 历史报告与证据（不删）
```

---

## 运行时架构

### 一次「出生」的完整生命周期

```
主模型流式输出
  │
  ├─ reasoning-delta ──► 累积到 task.raw（同时**逐字实时冲出**，主流程零延迟）
  │
  ├─ block-end ────────► birthStart()
  │                        ├─ diskP    : CAS 归档原文（独立超时护栏）
  │                        └─ distillP : 状态编译（一次模型调用）
  │
  └─ finish ───────────► birthFinish()
                          等 min(finishWaitMs, 真工期)
                          赶上 → 用压缩产物替换本块
                          没赶上 → 原文放行（passthrough）
                                    └─ 迟到结果存 lateMemory
                                         └─ 下一轮 agent/pre-step 认领发射
```

**关键不变式**：观测层出任何问题都**绝不**碰坏主流程。信封构造失败、过滤失败、快照读写失败
一律回落「原文全量」，绝不抛错。

### 四层状态记忆

```
EvidenceEnvelope   纯数据、冻结的时间截面（此后不再补入"后来才发生"的事实）
      ↓
StateCompiler      六栏编译：目标/状态/判断/约束/尝试/差距
      ↓
MemoryProjection   证据驱动归并（时间只决定处理顺序，证据决定能否替代）
      ↓
MemoryRenderer     birth 用增量渲染 / checkpoint 用完整看板
```

六栏固定顺序：`【目标与验收条件】【当前有效状态】【关键判断与依据】【约束与禁止】【已试路径】【未决差距】`

---

## 结构化状态快照持久化（当前工作重点）

### 它要解决的真实死锁

真机 trace + 会话日志逐条核对确认的因果链：

1. 编译成功产出的**结构化条目只存在于内存**；
2. 宿主压缩会把带看板的消息从 surface 上**整段删除**
   （实测 `seq=27097` 替换掉 `[26309,26733]`，171 个节点消失，两个看板一并消失）；
3. 于是下一轮 `priorMemory=0` ⇒ 覆盖判据不成立 ⇒ 全量重发 ~24.5k 字符
   ⇒ 提纯超时 ⇒ 又没有新看板 ⇒ **自锁**。

结论：**「从看板里捞快照」这条路本身不可靠** —— 看板是渲染产物，且会被宿主回收。
正确做法是把编译成功后的完整有效状态**直接存下来**，看板只负责展示。

### 快照形状

```js
{
  schemaVersion, compilerVersion, rendererVersion,
  sessionId, branchId,
  revision, parentRevision,        // 单调递增，可审计
  sourceCutSeq,                    // 本轮时间截面
  coverage: {
    coveredSeqs: [...],            // ★ 本轮真正编译进去的工具结果 seq 集合
    upTo, entries, at, sourceCutSeq
  },
  applied: { at, revision, mode, seq } | null,   // ★ 宿主已应用（与"编译已覆盖"严格分开）
  entries: [...]                   // 完整有效状态，非本轮局部摘要、非展示文本
}
```

### 三条硬规则

| 规则 | 为什么 |
|---|---|
| **先归并再写**：磁盘现值是权威基线，本轮 entries 与它归并 | 迟到的旧任务只会被并进去，**不可能覆盖更新的快照** |
| **先写完整快照，再原子替换指针**（tmp + rename，单文件） | 不存在「水位推进了但 entries 没落盘」的中间态 |
| **精确成员判定**，不用水位线 | 水位线会连带跳过"未采集"和"迟到返回"的结果；集合不会 |

### 关联方式：不解析消息文本

**不**靠 role、**不**靠 `<cot-ledger>` 标记判断来源 —— 标记可能出现在引用、日志和普通回答里。
关联 = 插件自己保存的 `(sessionId, branchId)` 指针，这比认标记更强。

### 「编译已覆盖」≠「宿主已应用」

| 字段 | 含义 | 何时写 |
|---|---|---|
| `coverage.at` | 编译已覆盖：这批证据进入了一份**已可靠保存**的有效状态 | 编译成功时 |
| `applied.at` | 宿主已应用：这份记忆**已提交到主请求面** | 真的发射时（唯一写入点） |

两者**永不互相赋值**。

---

## 安装到 DSH

插件是 npm 包，通过 `package.json` 的 `dsh.bundle.patch` 自携 patch 层，
patch 里 `name` 写**包名**（不是路径）⇒ 跨机器、跨盘符、跨 checkout 直接能装，**零绝对路径**。

profile 侧只需在 `dsh.profile.bundles` 里列出包名，并在 profile 的 `cordis.patch.yml` 用
`- id: cot-form-b` + `config` 覆盖配置（patch 的 config 是**整体替换**，不是深合并）。

开发时用 `file:` 依赖，注意 pnpm 会**复制**而不是链接 —— 改了源码必须重装：

```powershell
Remove-Item -Recurse -Force "<profile>/node_modules/@dsh-external/dsh-cot-form-b"
pnpm install --ignore-scripts   # 在 profile 目录
node deploy/onboard.mjs         # 必须报 drift 0
```

改完源码要**重启网关**才生效（Node ESM 有模块缓存）。
`BOOT` 事件里的 `selfId` = 模块首次求值时读到的 `size@mtimeMs` ——
旧模块在内存里根本不含这段代码，不会打印它，所以这是**可证伪**的上岗判据。

---

## 回滚开关

任何一项都可以单独关掉，不需要改代码：

| 开关 | 关掉后 |
|---|---|
| `stateSnapshot: false` | 停止读写结构化快照（回到无状态注入） |
| `stateCoveredEvidence: false` | 停止按覆盖集合过滤证据（全量发送） |
| `stateStructuralFirst: false` | 关闭跨窗口结构节点检索（**当前默认已是 false**） |
| `birthDeferredClaim: false` | 关闭下轮认领（迟到结果直接丢弃） |
| `birthArchive: false` | 关闭 CAS 归档 |
| `birth: { finishWaitMs: 6000 }` | 回到旧的长等待（扁平 `finishWaitMs` 不生效，只认 `birth.finishWaitMs` / `birthFinishWaitMs`） |
| `mode: 'off'` | 整体停用 |

---

## 当前状态（诚实版）

**已完成并自测通过**：

- 结构化快照持久化（`snapshot-store.js`）：原子写、归并而非覆盖、精确成员判定、`applied` 与 `coverage` 分离；
- 下一轮编译直接注入快照（走独立字段，**不经过** `priorMemory` 的 1200 字符截断）；
- A 方案（跨窗口结构节点检索）已下线：实测 `priorMemory 0→0`、`userAsks 3→9`、
  `prompt.total 26381→30092`（**+3711 字符**），净负；
- 修掉两个"过滤从未生效"的根因：
  ① 对 `Object.freeze` 的冻结对象赋值（必然抛 TypeError，被自己的 catch 吞掉）；
  ② `toolsForPrompt` / `adapted.cut` 声明在 `try` 块内，settle 钩子引用必然 ReferenceError。

**未完成 / 未解决**：

- **快照持久化尚未部署到网关**（本包是源码态，网关里跑的是旧构建）；
- **冷启动未解决**：CAS catalog 里 `cot-snapshot` 记录数为 **0**；
  `cot-checkpoint` 记录停在 `2026-09-18T06:00:24Z`。三次成功编译的结构化 entries
  **一条都没留下**（只活在内存 `lateMemory` 里），现存的只有渲染后的六栏文本。
  ⇒ **必须重新跑出一次完整成功**，持久化才能真正起效。
  不要把「持久化已实现」误当成「冷启动也解决了」。

---

## 证据与文档

文档分两层（2026-09-24 整理；**只归档不删除**）：

**现行（`docs/` 顶层）**

| 文件 | 内容 |
|---|---|
| `INSTALL.md` | 安装与配置 |
| `ARCHITECTURE-CONSOLIDATED.md` | 架构总览（可逆上下文分层，读一条线） |
| `at-birth-interception.md` | birth 模式（出生即拦截）设计规范 |
| `AUDIT-V11.5.md` | v11.5 成本模型审计（门槛反解、收益判据） |
| `CORRECTNESS-V11.md` | v11 正确性修正（覆盖 / 迟到 / 来源 / compress 通路） |

**历史归档（`docs/archive/`）** —— 各版本详报、外部简报、phase2 设计/手册、
作废状态卡，以及 `optimization-evidence{,-v2..v9}/` 原始证据目录。
索引见 [`docs/archive/README.md`](docs/archive/README.md)；版本时间线见根目录 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 观测

运行痕迹写在 `<DSH_HOME>/storages/cot-form-b/trace.log`，格式：

```
[ISO-时间] [事件名] {JSON}
```

⚠ **必须锚定解析**：`llm-stream` 行里会内嵌对话正文（可能含字面量 `[BOOT]` 之类），
用 `indexOf` 过滤会被正文里的方括号带偏。正则：

```js
/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[([a-zA-Z0-9_\-\/]+)\]/
```

常用事件：`BOOT`（含 selfId 上岗判据）、`state-envelope`（本轮输入画像）、
`state-snapshot-committed`、`state-snapshot-applied`、`birth-distill-settled`（真工期）、
`birth-passthrough`（放行原因）、`state-cover`（覆盖过滤省了多少）。

---

## 本包不包含什么

有意排除（避免把"某台机器的状态"伪装成"可交付代码"）：

- `*.bak` 历史备份（13 个）；
- `_roles-ab*.mjs` 一次性 trace 分析脚本（路径绑死本机仓库布局）；
- `restart-gateway.mjs`、`verify-all.mjs` 等含硬编码本机路径的脚本；
- 会话日志、CAS blob、trace 原文（体量巨大且含真实对话内容）。

这些留在原仓库 `D:\dsh\` 下，需要时再单独取。
