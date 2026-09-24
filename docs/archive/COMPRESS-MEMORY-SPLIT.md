> 历史记录说明：本文记录 v10 切分时的实现与测量；其中 `compress-v1`、旧 `compressRatio` 名称及“迟到结果会丢弃”等状态不是当前结论。当前 promptVersion 与迟到漏斗见 [`CORRECTNESS-V11.md`](../CORRECTNESS-V11.md)。历史计数保留为当时事实。

# v10：压缩与状态记忆开关切分

日期：2026-09-23。基线：v9（commit 5a4def6 之后的 v9 交付）。未部署到他人机器、未改宿主 profile。

## 结论先行

v9 的 `stateMemory: true` 把两件不同的事焊在同一个开关上：

- **压缩** —— 把这段 reasoning 改写成更短的摘要；
- **状态记忆** —— 用整段会话的证据重建一份跨轮状态判断。

结果是「想压缩的人打开了 stateMemory，拿到的却是整窗证据编译」。

本轮把两者拆成独立开关，并把裁决收进唯一函数 `resolveCompileMode()`。

## 实测病征（本机 trace.log，27 次副编译）

| 指标 | 值 |
|---|---|
| 要压缩的原文（`birth-fired.rawChars`） | 均值 **5,371** / 合计 145,009 |
| 实际发出的 prompt（`promptChars`） | 均值 **40,522** / 合计 1,094,097 |
| **放大倍数** | **7.5x** |
| 其中工具正文（`toolBodyChars`） | 均值 23,800，占 **58.7%** |
| 编译终局 | ok 1 / bad 26 |
| 失败构成 | `empty distillate (finish=length)` 17 / `timeout 8000ms` 8 / `invalid judgment-only` 1 |
| 替换成功 | **0** |

### 根因

触发粒度是「每段 reasoning 结束」，输入范围却是「整个 60 节点证据窗口」。

```
每编译 5,371 字符的推理 → 重发 23,800 字符的窗口证据
⇒ prompt 40,522，输出上限 1200 必然不够
⇒ finish=length 62.5% / timeout 33.3%
```

`evidencePolicy` 的取值直接说明了这一点：

```
all-visible-prefix + failure-and-latest-detail + shared-range-union-v2
```

`all-visible-prefix` = 当前可见窗口里所有工具的正文都塞进去。这不是「减少证据」，而是 v8 明确承诺的
「不减少原有选取证据」。承诺本身合理，错的是**输入组织单位**：以「可见窗口」为单位，而不是以
「当前推理块」为单位。

## 切分设计

```js
export function resolveCompileMode(cfg) {
  if (cfg.stateMemory === true)   return 'memory'    // 证据账本 + 快照 + 两栏判断
  if (cfg.stateCompress === true) return 'compress'  // 本段 reasoning 的摘要
  return 'legacy'                                    // 旧行为，完全不变
}
```

三条硬约束：

1. **`compress` 不采集任何证据。** `collectEvidence` / `buildEnvelope` / `prepareEvidence`
   三个依赖在该模式下**一次都不被调用**（有回归钉死）。
2. **两个都开时显式报冲突，绝不静默二选一。** 结果落进 `BOOT.compileModeConflict`。
3. **`legacy` 路径完全不变**，旧配置行为不变。

`compileModeOf(cfg)` 是容错读取器：`birthStart`/`birthFinish` 可能收到未经 `normalizeConfig`
的 cfg（裸库直调、旧回归夹具），缺字段时就地裁决，避免「配了却没生效」。

## 新增验收字段

```
inputChars      真正要压缩的输入长度
promptChars     实际发出的 prompt 长度
inputAmplificationRatio   promptChars / inputChars（旧字段 compressRatio 仅作兼容别名）
```

**输入放大比只是输入组织判据，不是输出压缩率、真实 token 节省或产品收益判据。** 设计预期 ≈ 1.x；切分前实测 7.5。

## 切分后实测（本机，compress 模式）

```
compileMode      "compress"       ← BOOT 确认
compilerMode     "compress-v1"
promptVersion    "compress-v1"
```

| 编译 | inputChars | promptChars | ratio | 结果 |
|---|---|---|---|---|
| 1 | 624 | 1,250 | **2.0** | ok=true，259 字符，finish=stop，totalMs 3061 |
| 2 | 4,019 | 4,645 | **1.16** | timeout（ttfb=null，首字节未到） |

证据链事件全部归零，证明「不采集证据」确实生效：

```
evidence-prepare-cost          0
evidence-ledger-committed      0
state-envelope                 0
compiler-input-prepared        0
compiler-flight-started        0
```

**7.5x → 1.16x。** 4,019 字符的推理，prompt 只有 4,645 —— 模板开销 626 字符，证据正文一个字没带。

`finish=length` 消失：切分前它是 60% 的主因（1200 输出装不下两栏判断）；现在输入只剩 4.6K，
模型 259 字符就正常收尾。

## 遗留问题（诚实记录）

### 1. 置换仍为 0 —— 瓶颈从「体量」换成「时间」

```
birth-passthrough  why=distill-timeout  waitedMs=1505/1516/1506
```

成功那次 `totalMs=3061`（ttfb 2956 + 生成 104），只差 1.5 秒就命中 1500ms 预算。

**这是 `finishWaitMs` 的取值问题，不是切分能解决的。** 用户已决定提到 4000ms。

### 2. compress 模式的迟到产物会被丢弃

迟到认领的门禁要求 `s.entries`：

```js
if (s.ok && s.entries && archived && archived.ok && task.passedThrough && cfg.birthDeferredClaim !== false) {
```

但 `compress` 的产物来自 `generateDistillation`，返回 `{ text, meta }` —— **没有 `entries`**。
所以迟到跑完的摘要直接被丢弃。

实测印证：`birth-late-memory-stored` 与 `birth-late-memory-refused` **都是 0** ——
`refused` 也是 0 说明门禁压根没进去，被 `s.entries` 挡在门外。

**后果：`ready-only`（零前台等待 + 迟到认领）这条路在 compress 模式下走不通。**
要同时拿到「零延迟」与「不丢压缩」，需要给 compress 产物一个 entries 等价物，或对 compress
放宽门禁。**这是代码改动，尚未实施。**

### 3. compress 模式退回 budgeted 等待

`readyOnly` 要求 `task.deterministic`，而该标记只在 memory 分支里设置。

```
birth-finish-enter  gapMs=13  waitPolicy="budgeted"
```

**所以 compress 模式拿不到 ready-only，退回全额等待。** 未命中时每轮白等 `finishWaitMs`。

## 验证

```
1141 通过 / 0 失败 / 0 跳过   (17/17 套件)
```

新增 3 项切分语义回归：

1. `compile mode is adjudicated in one place; memory wins but conflict is reported`
2. `stateCompress NEVER collects evidence: prompt carries only this reasoning`
3. `stateMemory still collects evidence`（确保切分没破坏原有能力）

## 回滚

| 想要 | 配置 |
|---|---|
| 纯压缩（当前） | `stateMemory: false` + `stateCompress: true` |
| 状态记忆 | `stateMemory: true` + `stateCompress: false` |
| 旧行为 | 两个都 `false` |

## 未验收声明

以上均为**本机单会话实测**，样本量小（compress 模式 2 次编译）。以下**均未宣称达标**：

- 真实工作负载下的压缩率与费用下降；
- 主模型行为、重复探索下降；
- 端到端时延分位数；
- 独立错误归因与任务结局审核。

`compressRatio` 是结构判据（输入组织是否切对），不是产品收益判据。
