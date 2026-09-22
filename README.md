# dsh-cot-form-b — 尾部即时思维链提纯 + 结构化状态记忆

DSH 外部插件。在**模型思考结束的那一刻**（`llm/stream` 的 `block-end`）并行起飞两条后台任务：

1. **CAS 归档** —— 把原始 reasoning 原文写进内容寻址存储（字节保真，永不改写）；
2. **状态编译** —— 调一次宿主模型，把「原始推理 + 工具证据 + 用户要求」编译成六栏结构化状态。

收尾时等 `birthFinishWaitMs`（默认 1500ms）：赶上了就把压缩产物顶上，没赶上就**原文放行**（绝不阻塞主流）。
迟到的结果不会丢 —— 存进暂存区，下一轮 `agent/pre-step` 用官方 `user/message` + `surfaceOp:replace` 认领发射。

---

## 快速开始

```bash
node verify.mjs        # 跑全部 8 个自测套件（928 项断言，零网络、零 API 调用）
node manifest.mjs      # 生成 MANIFEST.sha256
node manifest.mjs --check   # 校验完整性（换机器后第一件事）
node deploy/onboard.mjs     # 体检：确认插件在本机装好了
```

`verify.mjs` 只用 Node 内置模块，**无第三方依赖、无硬编码路径** —— 复制到任何机器/容器都能跑。
跑不起来的套件报 `SKIP`，**绝不**报 `PASS`。

---

## 目录结构

```
dsh-cot-form-b/
├── verify.mjs                 一键跑全部自测（可移植）
├── manifest.mjs               sha256 清单生成 / 校验
├── README.md                  本文件
├── MANIFEST.sha256            完整性清单
│
├── index.js            184 KB  插件入口：生命周期、证据采集、覆盖过滤、快照接线
├── state-memory.js      90 KB  四层状态记忆：信封 / 编译器 / 投影 / 渲染器
├── snapshot-store.js    26 KB  ★ 结构化状态快照持久化（CAS + 原子指针）
├── emitter.js           17 KB  收网器：唯一发射出口（官方 surfaceOp replace）
├── rules.js             13 KB  规则层压缩（离线、确定性，与模型提纯互为回退）
├── balanced-span.js     12 KB  平衡整步：找可安全替换的 span 边界
├── imperative.js       3.8 KB  祈使句提取（哪些推理块值得进记忆）
├── headroom.js         3.2 KB  预算余量计算
├── index.d.ts / rules.d.ts     TypeScript 类型声明
├── package.json                npm 包清单（声明 dsh.bundle.patch）
├── cordis.patch.yml            bundle 层：把插件挂进组合树（写包名，零绝对路径）
│
├── selftest.mjs               281 项  端到端 + 规则层 + 覆盖/快照
├── selftest-birth.mjs         155 项  birth 流式拦截器（真实 dsh-llm 不变式当裁判）
├── state-memory.selftest.mjs  245 项  四层状态记忆
├── emitter.selftest.mjs       101 项  收网器
├── balanced-span.selftest.mjs  60 项
├── headroom.selftest.mjs       33 项
├── provider-endpoint.selftest.mjs 28 项
├── imperative.selftest.mjs     25 项
├── fixtures/                  真机原文错误样本（非合成）
├── deploy/onboard.mjs         安装体检（跨机器，无硬编码路径）
└── docs/                      设计文档与运行手册
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
| `finishWaitMs: 6000` | 回到旧的长等待 |
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

`docs/` 里的设计文档按用途分：

| 文件 | 内容 |
|---|---|
| `INSTALL.md` | 安装与配置 |
| `ARCHITECTURE-CONSOLIDATED.md` | 架构总览 |
| `at-birth-interception.md` | birth 模式（出生即拦截）设计 |
| `brief-cot-form-b-why-we-wait.md` | 为什么要等 / 预算怎么定 |
| `brief-cot-form-b-late-claim.md` | 下轮认领（迟到结果回收）设计 |
| `phase2-settler-design.md` | 收网器设计 |
| `next-stage-spec.md` | 下一阶段规格 |
| `phase2-go-live-runbook.md` | 上线运行手册 |
| `STATE.md` / `PROJECT-REPORT.md` | 项目状态与总报告 |

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
