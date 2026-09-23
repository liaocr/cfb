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
