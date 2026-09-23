# dsh-cot-form-b — 尾部即时思维链提纯 + 结构化状态记忆

> **当前实现：v11.3（2026-09-23）**。compress PromptVersion 贯通 trace；迟到认领漏斗已在 boot26 真机 trace 命中 10/11；carry 有预算与去嵌套；只在字符估算满足至少 5% 且 100 字符净节省时发射看板，否则保留原文。验证套件当前 18 套。
> 这些是代码/单次 trace 事实，不代表每次发射都节省 tokenizer tokens 或模型质量已做 A/B。见 [`docs/CORRECTNESS-V11.md`](docs/CORRECTNESS-V11.md)。
> 下列 v10/v9…段落是对应版本的**历史记录**；其中的开关、待办、套件计数不得当作当前状态。历史套件数按当时记录保留，不做伪造性回写。

> **v10（历史版本记录）：压缩 与 状态记忆 开关切分。**
> 这两件事原本焊在 `stateMemory` 一个开关上：触发粒度是「每段 reasoning」，
> 输入范围却是「整个 60 节点证据窗口」⇒ 每编译 5,371 字符的推理要重发 23,800 字符的窗口证据，
> 实测放大 **7.5x**（工具正文占 58.7%），27 次副编译 0 次替换成功。
> 现在拆成两个独立开关，裁决只在 `resolveCompileMode()` 一处：
> `stateCompress` 只压本段 reasoning，**不采集任何证据**（实测 ratio 1.16~2.0）；
> `stateMemory` 保留证据账本 + 快照 + 两栏判断。
> 见 [`docs/COMPRESS-MEMORY-SPLIT.md`](docs/COMPRESS-MEMORY-SPLIT.md)。
> 当时遗留的 compress 迟到问题已在 v11 接通；压缩率/费用收益仍须按真实 token 用量与任务质量评估。

> **v9：减少无效编译，改善判断交接。**
> 默认路径精确共享相同在途请求；归档终局失败只取消对应消费者；提示词统计与发送复用一次构造。
> 判断保留适用条件、修正原因及待核对旧记忆；新增分阶段时延、请求级缓存用量和人工决策审核入口。
> 见 [`docs/COMPILER-EFFICIENCY-V9.md`](docs/COMPILER-EFFICIENCY-V9.md)。无新增开关或等待预算；真实产品收益仍未验收。

> **v8：保留证据，减少同请求内的重复展示与准备。**
> 相同采集正文按原可见区间取并集，调用身份、状态与完整性仍逐事件保留。
> 批内复用正文 hash 与文件校验；生产和重放共用证据准备入口。
> 见 [`docs/EVIDENCE-SHARING-V8.md`](docs/EVIDENCE-SHARING-V8.md)。真实产品指标仍未验收，无新增开关或等待预算。

> **v7：恢复有依据的判断编译，验证结果真正被消费。**
> 工具正文重新进入默认副编译请求，包含正常结果；不因已落盘而省略核对材料。
> 新增有上限的证据存储、满额后的内存证据回退、认领消费漏斗；四个旧生产开关退役。
> 见 [`docs/GROUNDED-COMPILER-V7.md`](docs/GROUNDED-COMPILER-V7.md)。
> **不承诺未经真实重放证明的性能／压缩率不下降。v6“工具正文跨轮零重发”的取舍已撤回。**

> **v6：确定性证据记录＋两栏判断编译（历史）**。用户现有 `birth + stateMemory:true` 路径直接切换，无新开关。
> 工具原文先落盘，失败不再触发旧正文全量重发；finish 只采用已就绪结果，不主动等副模型。
> 方案、代价与重放方法见 [`docs/HYBRID-COMPILER.md`](docs/HYBRID-COMPILER.md)。
> **真实产品指标尚未验收**：完整会话、主模型探索标注和运行凭据未提供。本地回归不能替代这些指标。

> **v5：迟到认领加固**，见 [`docs/LATE-CLAIM-HARDENING.md`](docs/LATE-CLAIM-HARDENING.md)。
> 当批验证：1088 通过、0 失败、1 跳过，13 套件。新增分支隔离、歧义拒绝、发射前复检及缓存体量限制。

> **统一优化版 v4**：范围回执、编译输入工作集、后台 CAS 镜像／恢复与故障门禁已接线。
> 见 [`docs/OPTIMIZATION-INTEGRATED.md`](docs/OPTIMIZATION-INTEGRATED.md)。
> 当批验证：1073 通过、0 失败、1 跳过，12 套件。
> 新策略 `stateEvidenceViews` / `stateSnapshotMirror` 默认关闭；配置、代价和真机验收边界见报告。
> 历史报告中“CAS 尚未接通”等描述仅适用于当时版本；不代表 v4 源码状态。

> **第三批更新：安全覆盖修复＋增量编译通道实验**，见
> [`docs/OPTIMIZATION-PHASE3.md`](docs/OPTIMIZATION-PHASE3.md)。
> 当批验证：1032 通过、0 失败、1 跳过，11 套件。
> 新实验 `stateCompileQueue` 默认关闭；policy 3 不再把截断工具结果整条标成已覆盖。
> policy 1/2 升级保留正文、重新积累覆盖，短期输入可能增加。

> **第二批更新：记忆可信度与执行隔离**，见
> [`docs/OPTIMIZATION-PHASE2.md`](docs/OPTIMIZATION-PHASE2.md)。
> 当批验证：1003 通过、0 失败、1 跳过，10 套件。
> 旧快照正文保留；旧覆盖集合需要通过新编译重新建立，迁移初期输入可能增加。

> **第一批优化记录（2026-09-22）**：当时的变更、验证与待办见
> [`docs/OPTIMIZATION-REPORT.md`](docs/OPTIMIZATION-REPORT.md)。
> 本轮不改等待预算、模型、输出上限或 surface 替换协议；未部署到真实网关。
> 第一批时快照只有本地原子文件存储；v4 已另行接通可选 CAS 镜像及后台恢复。
> 现有下文的历史设计说明不应被当成这些能力已经上线的证明。

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
node verify.mjs        # 跑全部 18 个自测套件（含本地 HTTP；零外部 API 调用）
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
