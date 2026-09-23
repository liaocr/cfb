# v11 正确性修正：覆盖完整性 / 迟到候选反查 / 来源解析 / compress 迟到通路

日期 2026-09-23。基于 v10 `531d180` 的静态审查 + 本地最小复现，修正四类问题并补传输层小项。
**本文只陈述代码事实与本地自测结果；真实宿主上的效果仍未验收。**

## 结论先行

| # | 问题 | 复现方式 | 修正 | 验收 |
|---|---|---|---|---|
| P1 | 整段 replace（deferred claim / checkpoint）只把「目标 reasoning 摘要 + tool/result」写进新看板；被吞并的旧看板正文、区间内 assistant 可见回答、tool-call 参数被遮蔽后**消失** | 哨兵脚本：OLD_BOARD / VISIBLE_ANSWER / ARGS 三类全丢 | `emitter.collectSpanCarry()` 抽取三类内容，交给 `buildLedger` 走「短内联 / 长归档 / 归档失败内联」同一通路；形状不认识 ⇒ 拒发 `span-unreadable` | `coverage-provenance.selftest` P1 ×3 |
| P3 | `normalizeEvidenceEvent` 把 `data.source`（宿主真实形状是对象 `{kind}`）整个当 hostOrigin，`String()` 后为 `"[object Object]"` ⇒ 插件注入的无标头消息被 inboxDefault **提权为 human**；显式 `{kind:'user'}` + 粘贴看板标头反被降级 | 直接调用归一化函数 | 新增 `hostOriginKind()` 统一抽取 kind；显式非人类创建路径不再落 inboxDefault；`classifyUserEventMetadata` 同步 | P3 ×5；`state-memory.selftest` 245 不变 |
| P2 | 发射器只询问缺省目标（倒数第 keepTail+1 条 assistant）；它未就绪时，更早且**已就绪**的迟到结果永不被回头询问 | 3 条 assistant，仅最旧就绪 ⇒ `distill-not-ready` | `runPreStepEmit` 新增可选 `deps.isReady(raw)`：缺省目标未就绪时按从旧到新反查尾部之前的其它 assistant，每条重新走 `selectBalancedSpan({targetSeq})`，三道闸（keepTail / 人类围栏 / 平衡切点）原样生效；index.js birth 认领路径接入 `peekLateMemory` 作零等待探测 | P2 ×3 |
| P4 | compress 结果无 `entries` ⇒ 被迟到暂存门禁挡掉；`task.deterministic` 缺失 ⇒ finish 处仍等 finishWaitMs（线上 4000ms）却大概率拿不到 | `birthStart/birthFinish` 直调 | compress 成功结果包成一条最小 entry（`category:'state'`, `basis:'compressed-reasoning'`）进入暂存区；finish 走 ready-only；**快照提交加 `compileMode==='memory'` 门**，compress 绝不写持久快照；legacy 无消费者 ⇒ 仍 budgeted | P4 ×2 |

**P2 定级说明**：本地 trace 显示 `birth-claim-hit 5/5`，即生产中尚未观察到饥饿；修正是机制层面的补齐，不是已发生的生产事故。

## 附带修正

- `requestOnce` 响应体加 4MiB 上限（与 `requestStream` 对齐，常量 `RESPONSE_BYTES_MAX`）。
- SSE 帧只 `JSON.parse` 一次：`events[i].json` 由采集侧填好，`parseStreamEvents` 直接使用；坏帧仍按原逻辑计入 `badFrame`。
- 重试退避改为 `retryDelayMs(e, attempt)`：401/403/404/400/422/取消 ⇒ 不重试（trace `compiler-retry-skipped`）；429/5xx/网络类 ⇒ `1200·attempt ±30%` 抖动。
- `index.js:278` 注释「两者都开会被显式拒绝」改为与代码一致的「记录 compileModeConflict，不抛错」。
- `index.d.ts` 补 `stateCompress / compileMode / compileModeConflict / keepTail / pluginName / maxInlineToolResultChars / staticMinRawChars / emitterProducer / birthCancelOnGiveUp / birthDiskWaitMs`，以及 `resolveCompileMode / retryDelayMs`。
- README / verify.mjs 套件数对齐为 18。

## 未改动的边界

- `emitCheckpoint` 的 `startSeq > endSeq` 守卫保留；「吞并后表面非单调」是否合法需要真实宿主合约，未放宽。
- compress 提示词仍是 `buildDistillPrompt`（与 legacy 逐字相同）；本轮不改提示词语义。
- `compressRatio` 语义不变（输入侧放大比）。
- 未拆分 `index.js`。

## 验证

```
node verify.mjs            # 1155 通过 / 0 失败 / 1 跳过（宿主依赖检查），18/18 套件
node manifest.mjs --check
```

跳过项为宿主依赖检查，本轮结果不构成完整宿主验收。

---

# v11.1 追加（同日）：对 v11 评审的回应

评审指出 v11 的两处自引入回归与若干未交代事项。逐条处理如下。

| 评审点 | 处理 | 验收 |
|---|---|---|
| ③ carry 无预算、跨轮累积 | `flattenCarriedBoard()`：carry 旧看板时剥掉其中已内联的 `[早前看板/早前回答/工具调用/工具结果]` 段，只留顶层摘要与句柄行（幂等）；`maxCarryChars`（缺省 3000）限制 carry 内联总量，超出项整体归档为句柄、归档失败才内联；`ledger-built` trace 新增 `carryChars / carryInlineChars / carryOverflow` | 三轮连续 replace 看板长度有界、两轮前正文不再出现 |
| ⑤ retarget 打穿看板单例 | 反查候选时要求既有看板全部在新区间内（`absorbSeqs` 只向左吞并，右侧看板吞不到）；否则 `emit-retarget-refused-board-singleton`，本轮不发 | 看板位于候选右侧的场景：拒绝，表面不出现两份看板 |
| ② compress 验收口径 | 新增 `explainLateMiss()` 与 `birth-claim-miss{why}` trace（`empty / no-candidate / ambiguous / partial-coverage`）；`analyze-efficiency.mjs` 输出 `claimFunnel`（compiled → passedThrough → stored → opportunity → claimHit/claimMiss → emitted → acknowledged → presentedInOptions）。**验收看 `claimHit`，不看 `stored`。** 实测双块 compress 场景可用拼接原文全覆盖认领 | 漏斗自测 |
| ⑥ P3 反转安全决定 | 退回：既有契约 I7/I8（创建路径已确认 ⇒ 不因正文标头降级、适配层完全采信）**保持不变**。新增 `markerConflict` 审计标记；`pickUserAsks(events, { excludeMarkerConflict: true })` 提供可选排除。是否信任「能写 `kind:'user'` 的写入者」留给宿主层裁决 | I7/I8 继续通过 |
| ① 表格"可取消"措辞 | 更正：compress **不取消**在飞编译，与 memory 缺省行为一致（T18a 契约） | — |
| ⑦ 重试分类全局生效 | 说明：`DEFAULTS.maxAttempts = 1`，缺省不触发退避；仅影响显式配置 `maxAttempts > 1` 的部署 | — |
| compress 提示词有名无实 | 新增 `buildCompressPrompt()`（`compress-v2`，缺省）：保留不确定性与被否决备选、不做不可逆裁决、无祈使句；`compressPrompt: 'v1'` 回滚为 legacy 文本，`promptVersion` 可 A/B | 提示词自测 |
| all-or-nothing 认领 | 新增 `peekLateMemoryPartial()`（opt-in `lateClaimPartial`，缺省 **false**）：已就绪块用摘要、未就绪段逐字保留，回执只含用到的记录；歧义候选一律拒绝 | 混合认领自测 ×2 |
| 新 trace 可观测 | `analyze-efficiency.mjs` 新增 `v11` 段：retargetReady / retargetRefusedBoardSingleton / spanUnreadable / retrySkipped / carryChars 分布 / carryOverflow | 漏斗自测 |

未量化项（诚实记录）：`span-unreadable` 的线上触发频率未知（真机 assistant 形状固定，理论上不触发），已加计数；compress-v2 的语义保真只有提示词层面的约束，没有模型侧验收。

---

# v11.2 追加：真机 trace（boot26）回读后的修正

真机漏斗：`stored 11 → claimHit 10`（91%），`claimMiss` 全为 `no-candidate`（9），`partial-coverage` 0 ⇒ `lateClaimPartial` 保持关闭。

| 信号 | 成因 | 修正 |
|---|---|---|
| v1/v2 无法从 trace 区分 | BOOT 硬编码 `compress-v1`；`birth-distill-settled` 缺 `promptVersion` | 新增 `compressPromptVersion(cfg)` 作唯一裁决点，BOOT / 每次编译 / transport meta 三处共用；`settled` 现在带 `promptVersion`；`analyze-efficiency.v11.promptVersions` 按版本分桶（成功率 + 输出字符分布，**不是语义保真**）。自测断言源码中不再出现硬编码 |
| `no-raw` 5 次 | 缺省目标是一条没有 reasoning 的 assistant（纯 text/tool-call），旧逻辑直接放弃 | 与「未就绪」同等对待：进入候选反查（三道闸 + 看板单例闸原样生效），反查不到才 `no-raw{retargetTried:true}` |
| `no-candidate` 9 次 | 暂存区里没有匹配这条原文的记录 —— 可能是「编译还在飞」也可能是「根本没这条」 | 新增 in-flight 登记（放行时登记、编译落地时清除、TTL 同暂存区）；`birth-claim-miss` 带 `inFlight / stored`；分析工具拆成 `claimMissNoCandidateInFlight / Idle`。**Idle 占比高才说明候选选择或身份匹配有问题** |
| `invalid-range` 2 次 | 最可能是吞并的旧看板 seq 数值大于区间右端（表面顺序 ≠ seq 顺序） | 守卫**不放宽**（宿主 `assertCurrentSurfaceSpan` 用 `surface.indexOf` 定位，合约未知）；`emit-refused-range` 带 `shadowedSeqs / startIsAbsorbedBoard / monotonic`，分析工具计 `refusedRangeNonMonotonic` |
| `retargetRefusedBoardSingleton` 4 | 闸在工作 | 无改动 |
| carry 预算 | `carryInlineChars` max 2189 ≤ 3000，溢出 4 次走归档；看板 p50 2943 | 无改动 |

下一轮 trace 要看的三个数：`v11.promptVersions['compress-v2'].ok/settled`、`claimFunnel.claimMissNoCandidateIdle`、`v11.refusedRangeNonMonotonic`。
