# At-Birth Interception —— 出生即提纯架构规范

> 状态：**已实现，并通过真机端到端验证**（2026-09-16）。压缩落到消息上、原文可按句柄回查。
> 代码：`packages/dsh-cot-form-b/index.js`（`birthHoldNew` / `birthSettle` / `birthTransform`）
> 测试：`packages/dsh-cot-form-b/selftest-birth.mjs`（27/27，结构由真实 `dsh-llm` 不变式校验）

## 0. 一句话

在 `llm/stream` 里把推理 chunk 换掉，**而不是**事后用 `surfaceOp: replace` 改写历史 assistant 消息。

## 1. 为什么必须这样：被绕开的那堵墙

DSH 0.1.5-rc.1 的 `dsh-session/lib/types/surface.js` 规定：一次 replace 必须携带覆盖**全部**被遮蔽
节点的 `sourceEventSeqs`（`:353 assertProvenance(event, range.shadowedSeqs)`），而
`assistant/message` 被禁止携带该字段（`:207`）。两条合起来是死路：

| 载体 | 能否替换 assistant 消息 | 依据 |
|---|---|---|
| `assistant/message` | ❌ 永远不能 | 带 `sourceEventSeqs` → `:207` 抛；不带 → `sources` 空 → `:234` missing → `:236` 抛 |
| `tool/result` | ❌ | `assertToolResultRewrite:305` 要求被遮蔽节点本身是 tool/result |
| `system/message` | ❌ | `assertSystemHeadRewrite:332` 只允许改写头节点 |
| `user/message` | ✅ 唯一 | 官方 `compaction-basic:621` 即此法 —— 但会让推理变成 user 轮（角色混淆） |

实测抛出的原话：

    error: assistant/message embeds its source stream and cannot carry sourceEventSeqs

## 2. 接缝：为什么在 `llm/stream` 改写是合法的

- `dsh-llm/lib/index.js:1334`：`return this.ctx.waterfall(this, llm/stream, options, () => this.adapterStream(options, prepared))`
- 官方签名（`typert.host.js:551`）：`(options, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>`
- 官方注释（`index.js:1328`）：the chunk stream, possibly wrapped by `llm/stream` listeners

宿主消费链（`dsh-agent-loop/lib/index.js`）：

    1040  for await (const chunk of stream) { live.push(chunk) }    // ← 累积「我们改写后」的 chunk
    1100  const message = createAssistantMessage({ content: live.blocks(), ... })
    1108  live.settle(assistant/message, () => this.session.append(assistant/message, { ..., message }, { surfaceOp: append }).seq)

**自洽性**：因为改写发生在 `live.push` **之前**，`accumulator`、事件的 `stream` 字段
（`:455 [...this.accumulator.snapshot()]`）、`replayState` 全部记录的是改写后的流 —— 不存在
「日志与内容不一致」的问题。

## 3. 五条硬约束（违反即坏，每条都有源码出处）

1. **`block-start` 必须立刻透传。** `dsh-llm/lib/invariant.js:16 validateDelta` 要求 `reasoning-delta`
   落在「已开」的 reasoning 块上 ⇒ 我们自己后发的 delta 只有块已开时才合法。
2. **绝不许 unref 超时守卫。** unref 的定时器不维持事件循环：归档卡住时唯一待决的就是它，
   事件循环当场排空、守卫永不触发、顶层 await 永不结算。**已实测复现**（T4）。
3. **归档先于压缩。** 拿不到 CAS 句柄 ⇒ 绝不压缩、原样透传。原始 CoT 绝不允许因压缩而丢失。
4. **主流自己的错误必须原样抛出。** 我们内部的异常只许降级成「原样重放」，绝不许吞掉主流错误。
5. **`block-end.block.text` 必须与压缩结果同步改写。** `BlockAssembler.push`（`dsh-llm/lib/index.js:936-940`）
   在 `block-end` 分支执行 `partial.block = chunk.block`，此后该块**以 `block.text` 为权威**
   （`:924` 对已闭合块的 delta 直接 `return` 丢弃）。只改 delta 而不改 `block.text`，压缩结果会被原文整体覆盖。
   ★ **这条是真机首跑撞出来的，五条里唯一一条单测没能提前发现。** 原因见 §9。

> 注：`finish` 无需押后。因为规则引擎是同步的、且在 `block-end` 处**即时结算**，
> 结算发生在 `finish` 之前，块结构始终无悬空。早期设计曾把结算放在流末，
> 那会让 `block-end` 排到后面的 text 块之后（结构仍合法，但浏览器会看到「推理出现在答案之后」），已废弃。

## 4. 数据流

    [模型流式吐 reasoning]
      block-start{reasoning}  ──立刻透传──▶ 宿主（块已开）
      reasoning-delta × N     ──扣住、累积文本──▶ 内存
      block-end{reasoning}    ──触发结算──┐
                                          │
        ┌─────────────────────────────────┘
        │ 1. 归档：cmbStore.putText(raw, {producer, sessionId, retention: session}) → art://…
        │    （带超时护栏，超时/失败 ⇒ 原样透传）
        │ 2. 提纯：compressByRules(raw) —— 同步、零网络、自带「永不增肥」硬护栏
        │ 3. 真阳判断：candidate 长度（含句柄）必须比 raw 短 ≥ rulesMinSavingPct%
        └─▶ 发 reasoning-delta{压缩后} + block-end{block.text 同步改为压缩后}
      text / tool-call / usage ──原样立刻透传──▶ 宿主
      finish                   ──原样放行（仅把仍未关闭的块原文冲出）──▶ 宿主

## 5. 双轨回退（任一触发都退回原文，绝不丢数据）

| 情形 | 行为 |
|---|---|
| 推理短于 `birthMinChars` | 不归档、不压缩，原样透传 |
| 归档失败 / 超时 | 原样透传（**铁律③**） |
| `compressByRules` 压不动或增益 < `rulesMinSavingPct` | 原样透传（`no-gain`） |
| 结算内部异常 | 重放全部缓冲 delta（`birth-settle-error`） |
| 源流抛错 | 先冲出缓冲原文，再**原样抛出** |
| abort（块未关闭） | 冲出缓冲原文，**不补造 `block-end`**，保留 `aborted` finish |

## 6. 配置（`cordis.patch.yml` → `cot-form-b.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `distill` | 设 `birth` 启用本机制 |
| `birthArchive` | `true` | 是否先归档进 CAS |
| `birthMinChars` | `500` | 低于此长度不处理 |
| `birthHandleInText` | `true` | 把 `art://` 句柄附在压缩文本尾部 |
| `birthProducer` | `cot-birth` | CAS 归档的 producer 标签 |
| `birthArchiveTimeoutMs` | `3000` | CAS 写盘超时护栏 |

⚠ `normalizeConfig:171` 有模式白名单，`birth` 已加入；漏加会被**静默重置**回 `distill`。

## 7. 验证证据

- `selftest-birth.mjs`：**27/27 通过**。结构合法性由**真实的** `dsh-llm` 不变式函数（经
  `apply → invariants.register`）充当裁判，不是自写检查。含 **T12 阴性对照**：故意发一个没有
  开块的 `reasoning-delta`，证明不变式确实会拒收 —— 所以那些「不变式通过」不是空转。
- `selftest.mjs`：**174/174 通过**，无回归。
- `normalizeConfig({mode: birth})` → `birth`；未知模式 → 回落 `distill`。

## 8. 回滚

把 `mode` 改回 `off` 并重启即可。本机制**无残留状态**：不写会话、不入队、不改任何宿主状态机。
启用前必须先重启并确认 BOOT 里 `emitting` 字段已是新值（模块改动不随 patch 热加载）。

## 9. 真机验证记录（含一次真实的失败）

### 9.1 首跑：机制生效，但压缩没落到消息上

启用后 trace 立刻报成功：

    [birth-archive-ok]  handle:"art://byMg3ZjkGnj54qoRfxPq4e"  rawChars:1622
    [birth-condensed]   rawChars:1622 → outChars:919  savedPct:43.34

**但会话日志里 assistant 消息的推理长度仍是原文。** 把两侧序列并排才看清：

    birth rawChars:  1622, 4904, 12273, 405, 6205, 8133, 3998, 6326, 10105, 10742
    消息推理长度:              405, 6205, 8133, 3998, 6326, 10105, 10742

完全对齐 —— 即 `birthSettle` 看到的确实是那条推理，压完却被原文覆盖（`405` 那条低于门槛，`below-floor` 放行，符合预期）。

### 9.2 根因：违反硬约束⑤

原实现把源流的 `block-end` 原样转发，而它自身携带 `block:{type:"reasoning",text:<原文>}`。
`BlockAssembler` 以该字段为权威 ⇒ 压缩被无声覆盖。

### 9.3 为什么单测没抓到 —— 测试与 bug 共享了错误心智模型

原假宿主只做「累加 delta」，**从不读 `block-end.block`**，因此它与真机行为不一致却仍全绿。
现已补上**忠实假装配器** `assemble()`（逐行复刻 `:909-951`）与回归用例 **T13**，并做双向验证：

- 新代码：`PASS=33 FAIL=0`
- **把修复临时还原：T13 立刻变红**（`3039 vs 3039`）⇒ 证明该用例不是空转
- 既有回归：`174 / 174`

### 9.4 教训

> **单测全绿只证明「实现符合我所写的模型」，不证明「模型符合真机」。**
> 当假宿主比真宿主简单时，两者共享的盲区正好是最危险的 bug 藏身处。

### 9.5 下一阶段

### 9.6 修复后真机复验：通过

重启加载新模块（BOOT 13:52:33）后，同一条推理的处理结果：

    [birth-archive-ok]  handle:"art://cq3G49xaZTkgaIvm1XKCoG"  rawChars:3330
    [birth-condensed]   rawChars:3330 → outChars:722  savedPct:78.3

会话日志中对应 assistant 消息的推理 = **722 字，尾部带 `[thought-cas art://cq3G49xaZTkgaIvm1XKCoG]`**
—— **与 `outChars` 精确吻合**。同一会话内的对照最能说明问题：

| seq | 推理长 | 句柄 | 说明 |
|---|---|---|---|
| 2744 | 923 | ❌ | **重启前**（旧模块）→ 压缩被 `block.text` 原文覆盖 |
| **2754** | **722** | **✅** | **重启后**（新模块）→ 3330→722，省 78.3% |
| 2761 | 346 | — | 低于 `birthMinChars` → `below-floor` 放行（预期） |

**归档契约复验**（铁律③「先归档才允许删索引」）：

    inspect_artifact("art://cq3G49xaZTkgaIvm1XKCoG") → ok=true, 67 行
      1 | The user restarted. Now I need to verify the fix took effect.
      2 |
      3 | The key verification: the session log should now contain ...

CMB catalog 登记：`{bytes:3350, lines:67, producer:"cot-birth", sha256:"97e6b887…"}`
⇒ 会话里只剩 722 字提纯版，**3350 字节原文完整可按句柄回查**，且带 producer 与 sha 可审计。

### 9.7 下一阶段

- **第二阶段**：把 LLM 伴生提纯作为「慢道」挂到同一条管线上（当前仅纯规则）。
- **未测**：长上下文下的核对开销；`d_eff`（推理占窗口比例）仍未测量。
