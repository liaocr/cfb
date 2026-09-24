# v5：迟到记忆的身份隔离、发射复检与容量约束

2026-09-22。基于 v4 完整源码继续开发。未推送、未部署、不改模型或预算。

## 为什么做这一项

v4 已着手降低后台编译输入，并接通可选 CAS 恢复。但成功结果如果在迟到认领时贴错消息，前面的节省就失去意义。

源码存在三个可复现问题：

1. 持久快照按会话＋分支隔离，迟到缓存却只按会话隔离。
2. 同一 raw 再次入队直接覆盖旧记录，匹配函数又遇到逐字相同就返回第一条；注释所称“同文歧义自动 no-op”并不成立。
3. 第一批已保证 emit 成功后才消费，但异步组装期间候选可能已经更新或出现歧义；只保护消费，还不足以防止把过时内容发出去。

本次选择解决这些已能定位、能用生产路径复现的问题，而非继续堆叠未经语义验收的压缩策略。

## 已完成

### 1. 全链路分支隔离

缓存键采用 JSON([sessionId, branchId])，不是容易碰撞的字符串拼接。

生产 birth 成功暂存使用该流捕获的 branchId；pre-step 查询、发射资格复检和最终 acknowledge 使用同一份冻结分支上下文。

兼容接口增加可选 opts：

```js
pushLateMemory(sid, raw, entries, board, { branchId, taskId })
peekLateMemory(sid, raw, { branchId })
claimLateMemory(sid, raw, { branchId })
acknowledgeLateMemory(sid, receipt, { branchId })
lateMemorySize(sid, { branchId })
```

不提供分支时只访问 main，而不是聚合所有分支。修复 birthStart 直接传字符串 branchId 时被忽略的问题；原有 branchId 回调方式保留。

### 2. 相同文字不是相同任务

- 生产暂存带本插件生成的 taskId。
- 同 taskId、同 raw 的再次保存可替换旧记录；旧 receipt 失效。
- 不同任务或没有任务身份的同 raw 不再覆盖，显式标成 ambiguous，拒绝认领。
- 即使容量淘汰了其中一个候选，存活候选仍保持歧义标记，不会突然变得“可以确认”。

taskId 只用于辨认同一次插件任务的重试，不证明它对应哪条宿主消息，也不授予证据事实等级。

### 3. 主表面重复文本与最终发射资格门禁

birth 的迟到认领在现有 surface 中发现另一条 assistant/message 有相同完整推理时，拒绝认领，保留原文。只在确有迟到结果时执行，不新增模型调用。

增加 lateReceiptValid：异步 ledger 准备完成后、同步 emitCheckpoint 之前，重新检查候选是否仍在同一分支缓存、未过期、未被替换、未出现已知歧义。

不满足就返回 stale-distill，不发射、不消费。原来的“成功发射后 acknowledge”事务顺序继续保留。

### 4. 不可变缓存与有界资源

缓存 entries 采用独立深复制并冻结，避免调用方后续修改污染已准备好的记忆。

在原每键最多 8 条、TTL 10 分钟基础上，增加：

- 最多 128 个会话／分支键；
- 每项原文＋entries JSON＋看板序列化 UTF-8 体量最多 256 KiB；
- 全缓存上述体量合计最多 8 MiB；
- 入队时清理所有过期队列，避免长期不再访问的会话一直占位。

这些是序列化体量预算，不是 V8 堆内存的精确上限。达到限制时拒绝新的迟到暂存，记录 birth-late-memory-refused；原文仍保留，已有本地快照不因此撤销。

## 验证

新增 `late-identity.selftest.mjs` **15 项检查**：

- 分支隔离与键拼接碰撞；
- 同文不同任务歧义、同任务更新；
- 容量淘汰后歧义仍在；
- peek 后新增冲突会使 receipt 失效；
- 错分支 acknowledge 不消费；
- 缓存不受外部对象修改；
- 单项、总字节、全局键数与 TTL 限制；
- 实际 birthStart 成功暂存携带正确分支和 taskId；
- 实际 pre-step 错分支不发射，正确分支成功发射并消费；
- 实际 pre-step 遇到 surface 同文拒发；
- 实际 emitter 在异步准备后资格失效时不 append。

全量：**1088 通过、0 失败、1 项宿主相关检查跳过，13 套件**。

**7 项撤回反证全部检出**，包括删除分支键、取消歧义保留、取消发射前复检、漏传生产 branchId、接受表面重复 raw、绕过体量上限和重新共享可变 entries。

旧测试的有意变更：两条“同 raw 自动取最新版”断言改为“无任务身份时拒绝猜测”；原 receipt 更新竞态测试补上明确同 taskId，以继续验证合法重试。没有删掉失败测试来凑通过数。

证据保存在 `docs/archive/optimization-evidence-v5/`。

## 效果与代价

这轮优化的是**成功产物的应用可靠性**和内存约束，不宣称直接降低 token。

遇到歧义会少压缩一些文本；全表面重复检查也有本地计算开销。取舍是宁可保留原文，不将另一条任务的结论贴到当前消息。没有提高 finishWaitMs、timeoutMs、maxOutputTokens，没有新增串行模型调用。

无需新增策略开关；原 birthDeferredClaim:false 仍可关闭迟到认领。v4 的范围视图和镜像开关、快照格式与合法覆盖记录不变，本次不要求重建覆盖集合。

## 尚未解决的身份边界

没有可靠的宿主 request/message/block 标识从流生成端传到发射端，因此这仍是“分支隔离＋已知歧义拒绝”，不是完整的源消息身份认证。

表面之外的历史同文、多个块分别来自不同源消息等情况，不能仅凭 raw 与插件 taskId 完全证明归属。表面唯一性检查也不是整个宿主状态的事务锁。这里没有凭空猜宿主字段，更没有宣布所有错认路径都已消除。

## 交付

- 完整包 `cfb-optimized-v5.zip` 包含此前全部优化。
- 原始仓库应用累计 `cfb-optimization-v5.patch`。
- 已用 v4 的树应用 `cfb-v5-incremental.patch`。

```sh
node verify.mjs
node manifest.mjs --check
```

仍需按原 file: 依赖复制流程刷新插件副本、体检并重启网关。未进行真实宿主／商户 API 或 TypeScript 编译器验收。
