# CFB 源码扫描与第一批优化

基线：`liaocr/cfb@5a4def6daed0da4e0d2678d36d398d80f258aef2`。
工作目录：`/home/user/cfb`。本报告对应本地修改版；未推送 GitHub、未部署或重启用户网关。

## 结论

当前最值得做的不是继续放大提示词或新增一次模型判断，而是先让**已支付的编译结果可靠地保留、可靠地消费，并确保省略证据时确有完整记忆替代**。

本轮已修改确定性通路，保持：

- finish 等待、调用 timeout、模型选择、输出上限不变；
- 原始 reasoning/CAS 原文不变；
- 六栏提示词和记忆语义不变；
- surface replace 协议、keepTail 与工具配对规则不变；
- 不新增外部 API 调用、不增加第三方运行依赖。

没有宣称实现了此前讨论的全部上下文工程方案，也没有宣称实际 API 提速、任务正确率或账单收益已被验证。

## 1. 扫描范围与验证边界

仓库全部文件做了清点和静态检索；重点逐路径检查全部 8 个运行时 JS 模块：`index.js`、`state-memory.js`、`snapshot-store.js`、`emitter.js`、`balanced-span.js`、`rules.js`、`imperative.js`、`headroom.js`。同时检查类型声明、部署与校验脚本、现有测试和设计文档。历史文档存在相互冲突的路线，不作为现行代码行为的证明。

本仓库不是整个 DSH monorepo。没有真实宿主 session/surface/token-meter/CAS 实现，没有生产会话与 trace，没有商户凭据。因此：

- 可以验证纯函数、本地磁盘、真实本地 HTTP，以及通过 `apply()` 注册的生产 hook；
- 不能据此证明真实宿主投影和计费行为，也不能重现实机 25k 提示词的调用延迟；
- 原有 birth 套件中 1 项宿主兄弟包集成断言被跳过；
- 类型声明本轮作了同步修正，但仓库没有 TypeScript 构建链，未声明 tsc 验证通过。

## 2. 已修复的问题

### 2.1 覆盖过滤回滚开关原来没有接入

位置：`index.js / birthStart`。

`stateCoveredEvidence:false` 在 DEFAULTS 和文档存在，但过滤快照覆盖集合的分支并不检查它。

**修改**：只有开关开启、快照存在且完整渲染成功，才使用该快照的覆盖集合。增加真实 birthStart 输入捕获测试：开启保留尾部 8 条，关闭恢复全部 12 条。

### 2.2 截断快照不能替代完整覆盖集合

位置：`snapshot-store.js / snapshotToText`、`index.js / birthStart`。

原实现将超过 12,000 字符的快照截断，随后仍根据整份覆盖集合过滤旧证据。即模型可能既没看到被截掉的状态，也没看到原证据。

**修改**：默认 12,000 字符上限不变；超过上限、条目非法或渲染失败时，不返回半份视图，也不做覆盖过滤。落 `state-snapshot-view-unavailable`。原始证据照常发送。

这是正确性修复，不是新的体积优化。超大状态的有界投影仍须单独实现，不能靠截断冒充已完成。

### 2.3 迟到结果过早消费，替换失败就丢掉已支付的结果

位置：`index.js / agent/pre-step`、`peekLateMemory`、`acknowledgeLateMemory`。

原调用 `claimLateMemory()` 后才进行工具提取、归档、live surface 复检和 append；任一步失败或 dry-run 都会失去暂存结果。

**修改**：先 peek，保留精确 receipt；只有 emitter 返回 emitted=true 后才确认消费。receipt 绑定取出时的对象身份，异步等待期间同 raw 的新结果不会被旧确认删除。

生产 `apply()` hook 回归覆盖：append 抛错 → 暂存仍在 → 第二次成功 → 只消费一次；dry-run 不消费。

### 2.4 多块乱序完成时，队列删除下标错误

位置：`index.js / claimLateMemory`。

匹配结果按源块顺序排列，但该顺序不是队列下标顺序。原来将源顺序倒过来 splice，可能删错、漏删。

**修改**：返回内容仍按源块顺序，删除则对队列下标数值降序操作。

### 2.5 快照锁会同步阻塞，失败后还会无锁写

位置：`snapshot-store.js / acquireLock / commitSnapshot / markSnapshotApplied / materializeSnapshot`。

原实现使用 Atomics.wait，竞争时最多阻塞主线程 2.5 秒；拿不到锁仍继续读-归并-写。单靠锁文件年龄抢占也不能证明旧写者已死。

**修改**：一次非阻塞尝试；竞争立即返回 lock-busy，不进行无锁写入；不按年龄偷锁。materialize 同样参加锁协议，统一原子写入并清理临时文件。

**取舍**：本轮没有增加后台重试队列；失败提交不会推进覆盖，下次可能多发原证据。崩溃遗留锁应先确认没有活跃写者再清理。普通同步文件 I/O 仍然存在，未声称快照 I/O 完全异步或提供断电 fsync 保证。

### 2.6 归并异常不能丢掉旧状态却保留其覆盖集合

位置：`snapshot-store.js / commitSnapshot`。

原 catch 分支使用本轮 incoming 覆盖旧 entries，同时保留旧 coverage 并集。这会使后续过滤掉已经没有状态承载的证据。

**修改**：归并失败立即拒绝本次提交，旧快照字节不变。拒绝空或非法条目推进覆盖；加载时拒绝“有覆盖而无状态”、非法 revision 和非法覆盖 seq。

### 2.7 归档失败仍可能产生可回收状态

位置：`index.js / birthStart` 编译 settle 分支。

原来持久化／迟到暂存只检查编译成功，没有等待对应 reasoning 归档成功。

**修改**：后台提交与暂存也必须通过 diskP 成功条件。finish 保持自己原有的 deadline，不新增等待预算。

### 2.8 JSON／协议错配路径接受被截断的正文

位置：`index.js / requireCompleteDistill / distillOnce / distillOnceStream`。

原 SSE 主分支拒绝 finish=length，但非流式 JSON 和“流式请求收到 JSON”分支只检查正文是否非空。截断但非空的正文会被当成功。

**修改**：统一完整结束门禁，接受 stop/completed；拒绝 length、缺失结束状态、其他不正常结束。失败保留 promptChars、finish、reasoningChars 和已输出字符数。

新增真实 loopback HTTP 测试覆盖 JSON、SSE、双向错配、截断、有 DONE 却缺 finish，以及成功情况。尚未声称 SSE 所有厂商扩展语义已验证。

### 2.9 索引缓存既会过期误命中，也会反复解析全表面

位置：`index.js / evidenceIndex`。

原缓存键只包含节点数、首尾节点、可选 generation；中间节点被替换且 generation 不可得时，缓存可能仍被命中。每次新增节点又重新读取、规范化全部 surface 事件。

**修改**：缓存身份包含完整节点序列；按 append-only 的宿主事件契约复用仍在表面的已规范化事件，仅新增节点需要读取／解析。

局部微基准（真实原提交代码 vs 本地修改代码；合成会话）：

| 项目 | 原版 | 修改版 |
|---|---:|---:|
| 初始 1000 节点，随后逐次追加 100 节点 | — | — |
| eventAt 调用次数 | 106050 | 1100 |
| 一次本地运行耗时 | 51.861ms | 15.972ms |

读取次数减少 **98.963%**。时间仅为单次微基准，不能换算成 API 延迟、全局吞吐或费用收益。仍有 O(surface 节点数) 的身份检查／遍历，不是整个采集 O(1)。

复跑：`node deploy/benchmark-index.mjs`，需要含基线提交的 Git checkout；下载的无 .git 源码包不能单独运行该基准。

### 2.10 应用标记、路径与部署观测修正

- 块级 ledger 发射不再把磁盘最新的整份快照标成 applied。该 ledger 不一定包含最新 revision 的所有条目。用 `birth-claim-acknowledged` 表示本次块级认领；完整快照 applied 接口要求显式匹配 revision。
- 快照目录及恢复 catalog 路径遵循 `DSH_HOME`，不再固定写入另一个 `~/.dsh`。
- BOOT 增加 birth 等待／deferredClaim 以及状态开关；模块指纹包含 state-memory.js 和 snapshot-store.js。
- 修复 birthStart 调用 apply 内部局部 sha256Hex 导致 stateCacheKeyTrace 开启时抛错的问题。
- 未归一化配置调用 birthStart 时，跨窗口结构检索仍默认关，不再因为 undefined 被当开启。
- onboard.mjs 自动识别独立插件仓库；不再在本仓库寻找不存在的 packages/dsh-cot-form-b 和四个兄弟包。临时 profile 测试验证正常副本退出 0，修改部署文件后退出 4。
- verify 汇总明确报告跳过项；更新类型声明中的模式／状态开关、package 描述及 README 入口。

## 3. 验证结果

### 基线

`node verify.mjs`：927 通过、0 失败、1 跳过，8 套件。

### 修改后

`node verify.mjs`：**970 通过、0 失败、1 跳过，9 套件**。

新增 `optimization.selftest.mjs`：43 个检查，直接调用生产函数／生产 hook，不手抄另一份过滤器。包含文件锁竞争、磁盘不变、完整视图配对、真实 hook 的失败重试、真实本地 HTTP 协议矩阵与独立部署漂移检查。

### 反证

分别撤销以下 7 项修改后再跑新增套件，全部出现对应失败，然后恢复代码：

1. 忽略覆盖开关；
2. 允许截断快照返回；
3. 在 append 前消费迟到结果；
4. 使用错误的多块删除顺序；
5. 绕过统一结束门禁；
6. 回到首尾节点缓存键；
7. 去掉归档成功前置条件。

反证摘要随报告提供在 `docs/archive/optimization-evidence/mutations.json`。

## 4. 尚未修复，但已找到具体代码原因

这些不是模糊的“以后可优化”，而是后续架构工作的真实入口。

### P0：生成结果被统一升级为 observed

`index.js / generateStateMemory` 调用：

```js
mp.ingest(parsed, { at: Date.now(), origin: 'model', evidence: 'observed', blockIndex })
```

模型输出包含推断、用户报告、未确认状态，却全被赋予 observed。提示词中的谨慎措辞不能替代结构化来源权限。

**下一步**：编译输出增加可验证的证据引用／关系字段；宿主核验引用存在与作用域后再赋权限，无法独立验证的条目默认 inferred/unknown。涉及旧快照迁移，应作为单独 compilerVersion/schema 升级，不在性能修复里悄悄改变旧记忆含义。

### P0：条目 ID 每次编译从 m1 重新开始

`createMemoryProjection()` 每次创建新的计数器；`objectKey()` 在没有 objectId/scope 时使用条目 id。不同编译中的 m1 可能被放入同一比较槽。当前文本六栏解析也没有产出真实的 objectId、scope、propositionKind 结构。

**下一步**：条目身份带 compile/session/branch 命名空间；对象身份与条目身份分离。不能靠同名 m1 推导同一命题。再做跨快照去重、修正、增量输出。

### P0：多会话并发身份与文本认领

apply 保存可变的 birthSession/birthSessionId/cfg；流处理通过闭包读取这些共享变量。宿主并发多个 session 时，需要核实并冻结本流所属身份、模型／provider、分支。

lateMemory 当前仍以 sessionId + raw 为主要关联，同 raw 入队会覆盖；没有可靠源消息身份时不能宣称不会错认。

**下一步**：流创建时冻结宿主提供的请求身份，并在最终 assistant append 后建立 `(session, branch, message/stream, block)` 关联。需要宿主字段契约，独立插件仓库不能猜。

### P1：持久化现在是本地文件，不是完整 CAS 恢复闭环

仓库存在 `recoverSnapshot()` 和 catalog 扫描，但没有快照 producer='cot-snapshot' 的实际 putText 调用；recoverSnapshot 被传给 birthTransform，却没有被后者调用。

**下一步**：本地快照优先保证可用；CAS 镜像作为异步独立写入，不阻塞 finish；本地缺失时在会话初始化或后台恢复阶段加载镜像。无法找回结构化快照时，仍需一次完整成功，冷启动没有凭空解决。

### P1：背景工作仍按块重复起飞

多个块可以各自带重复证据发请求，没有会话级编译批次调度。

**下一步**：一个分支一个运行批次，新增证据进入下一批，固定截面，成功后提交 coverage；不是无限 debounce，也不是不断 abort 重开。涉及一次编译结果如何关联多个 reasoning 块，应独立测试后上线。

### P1：当前状态会无限变长

持久化状态累计，renderer 默认把 historical、superseded 等旧条目也完整输出。修复后大于默认视图上限将拒绝覆盖过滤，虽不丢证据，但优化收益会退化。

**下一步**：完整历史保留在快照／CAS；生成带完整覆盖依赖的“当前工作集”，优先当前有效状态与本轮相关证据。未进入视图的状态不能继续授权省略其唯一原证据。不能简单 slice 或只发最后几条。

### P1：emitter 替换区间的信息覆盖仍需独立核查

span 可以包含目标之外的 assistant／旧看板，buildLedger 主要保留目标 reasoning 摘要和 tool/result；目标正文及其他被遮蔽节点是否完整承载，需要与真实宿主约束逐项核对。本轮没有扩大 span，也未宣称工具配对平衡就等于语义全覆盖。

### P2：开关与网络层仍有边界问题

- `enabled`、birth dryRun 在 stream 应用路径的完整门禁值得补专门回归；本轮仅验证 deferred 发射 dryRun 不消费。
- provider 跟随更新绑定在 model 变化条件下；同 model 换 provider 可能不更新。
- 错误重试把所有 HTTP 4xx 当参数拒绝，不应对 401/403/429 盲目裸重试。
- SSE 帧及行缓冲总量没有严格统一上限；坏帧跳过可能使完整性判定不够严格。
- cacheIdentity 的快照身份只含 revision/长度/覆盖数而非内容；当前主要用于 trace，但不能直接拿去做生产结果缓存。
- d.ts 和多个历史文档仍有陈旧注释；本轮只同步现行关键配置，不把文档称作运行事实。

## 5. 后续优化顺序（按实际收益）

1. **先修记忆可信度**：编译身份唯一、证据来源不自动升级；完成快照 schema 迁移设计。
2. **再控后台调用数**：会话级增量批次队列，避免同批工具历史多次编译。
3. **再控输入与输出量**：工作集投影 + 状态增量输出，不反复抄写整份历史。
4. **最后改呈现策略**：完成可靠源消息身份与合法收网后，再显式选择不等待编译的 finish 策略。当前预算完全未改。

这条路线比继续修“日志样板”更可能提高模型接续质量；但正确率提升必须在有明确验收标准的真实任务上测，不能用本地断言数代替。

## 6. 使用与部署

在已修改仓库中：

```sh
node verify.mjs
node manifest.mjs --check
```

在基线 Git checkout 上使用补丁时：

```sh
git apply --check cfb-optimization.patch
git apply cfb-optimization.patch
node verify.mjs
node manifest.mjs --check
```

回到本机 DSH 时，只替换此插件包，不把独立仓库覆盖整个 monorepo。依照原流程删除 file: 安装副本、`pnpm install --ignore-scripts`、体检，再重启。不要改当前 profile 预算配置。

本地快照锁竞争现在会明确返回 lock-busy；不要自动删除不明锁。若遇陈旧锁，先停止并确认旧网关进程退出，再备份并清理锁文件，保留快照文件。

**本交付可直接用于代码审阅／本地回归，但仍需真实网关验证。没有执行任何 GitHub 推送、商户请求或生产部署。**
