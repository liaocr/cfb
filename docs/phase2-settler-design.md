# 阶段二架构设计（v2 修订版）—— 官方 user/message 检查点 + 早截取并发提纯

> v1 的三处判断已被源码复核**推翻**，本版是修订稿。状态：**仍待批复，未动一行代码。**
> 日期：2026-09-17

---

## 0. v1 → v2 改了什么

| v1 的说法 | 复核结果 | v2 修正 |
|---|---|---|
| 「`assistant/message` + replace 结构上不可能 ⇒ 只能流内改写」 | **前半句对，后半句错** | `user/message` 是官方正道，replace 完全可行 |
| 「事后替换被 H2 否决」 | **混淆了两个时机** | pre-step（首次出站**之前**）替换是合法的，H2 只管「已出站之后」 |
| 「时延靠缓冲重叠硬扛」 | 不必要 | 早截取 + 后台提纯 ⇒ 主流式**零卡顿** |

---

## 1. 复核证据（不是推测，是逐行源码）

### 1.1 官方 `dsh-compaction-basic` 就是这么干的

文件：`@deepseek-ai/dsh-compaction-basic/lib/index.js`

```
:211  const SUMMARY_OPEN_TAG  = "<compacted-summary>";
:212  const SUMMARY_CLOSE_TAG = "</compacted-summary>";
:257  const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span..."
:567  const checkpointMessage = createUserMessage({
:569      source: compactCheckpointSource(compactionId, sourceCommandId)
      })
:605  const summaryEvent = session.append("compaction/summary", { ... })
:621  session.append("user/message", checkpointMessage, {
:622      surfaceOp: { op: "replace", startSeq: start, endSeq: end },
:627      sourceEventSeqs: [ startEvent.seq, summaryEvent.seq, ...shadowedSeqs ]
      })
```

⇒ **`user/message` + `surfaceOp: replace` + `sourceEventSeqs` 是官方正统。**
⇒ 官方协议是**三步**：`compaction/start`（生命周期）→ `compaction/summary`（记录）→ `user/message`（替换体）。

### 1.2 为什么 `assistant/message` 不行（复核 `surface.js`）

```
:207  if (event.type === 'assistant/message' && raw !== undefined)
:208      throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
:234  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
:235  if (missing.length > 0) throw new Error('surface replace: sourceEventSeqs must include every shadowed node')
```

replace 必须用 `sourceEventSeqs` 点名被遮蔽节点，而 `assistant/message` 一带它就抛错 ⇒ 二者不可兼得。
**⇒ 我方现存 `flushPendingEmit()` 之所以每次抛错，根因就在这里。改用 `user/message` 即可根治。**

### 1.3 checkpoint 的 `source` 标记（**关键，别漏**）

`dsh-compaction/lib/types/checkpoint.js:14,21`:

```
const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'compact' })
export function compactCheckpointSource(compactionId, sourceCommandId) {
  return Object.freeze({ ...COMPACT_CHECKPOINT_MARKER, compactionId, ... })
}
```

⇒ 检查点的 `source.kind` 是 **`'plugin'`**，不是 `'user'`。
⇒ **这一点救了我们自己的防线④**：`findLastUserMessage()` 只认 `source.kind === 'user'`，
   所以它**不会**把记忆看板误当成「用户原话」注入 ⇒ 角色混淆在**机械层面**就被隔离。

### 1.4 token-meter 不特殊约束 `user/message`

在 `dsh-token-meter` 全包检索 `user/message`：**0 命中**。
而 `assistant/message` 有「必须落在匹配的已开启 step 内」的硬约束。
⇒ 改用 `user/message` 确实绕开了那套 step 状态机。

### 1.5 官方还强制工具配对平衡（**这是 v1 漏掉的致命项，见 §3**）

```
compaction-basic:540  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error('compactRegion: start seq ...')
compaction-basic:541  if (!toolPairingBalancedAfter(session, nodes[endIdx]))   throw new Error('compactRegion: end seq ...')
```

---

## 2. 项目前提实测（**决定性，之前一直没测过**）

问题：历史推理到底有没有被重发给模型？如果适配器组装请求时已剥掉，压缩它一分钱都省不下来。

证据来源：我方插件在 `llm/stream` 每轮记录的 `reasoningChars`（真机 trace，501 条）。

```
[2026-09-17T04:49:12.744Z] [llm-stream]
  messageCount   = 131
  reasoningChars > 0 的消息 = 62 条
  历史推理总字符 = 276,935 / 每次请求
```

⇒ **历史推理确实被重发，且是上下文的绝对大头。**
⇒ 项目前提成立；`d_eff`（推理占窗口比例）这一项从「未测量」变成**已测量**。
⇒ 压缩推理有真实、巨大、可计量的收益。

---

## 3. ⛔ 一个致命缺陷（v1 与红队片段里都没有）

红队给的发射片段是：

```js
session.append("user/message", checkpointMessage, {
  surfaceOp: { op: "replace", startSeq: assistantSeq, endSeq: assistantSeq },
  sourceEventSeqs: [assistantSeq]
})
```

### 3.1 为什么这会让表面 corrupt

`dsh-compaction/lib/types/tool-pairing.js`:

```
:11  case 'assistant/message': return content.filter(b => b.type === 'tool-call').length
:13  case 'tool/result':       return -1
:33  if (inProgressToolCalls < 0)
:34      throw new Error('tool-pairing balance: tool/result at surface seq N has no matching tool-call (corrupt surface)')
```

若被替换的 assistant 消息**含 tool-call**，而替换区间**不包含**它的 tool/result：
- 切点后 `inProgressToolCalls > 0` ⇒ `toolPairingBalancedAfter` 为 false ⇒ 官方引擎第 541 行直接抛错；
- 即便绕过检查，那些 tool/result 也会变成孤儿 ⇒ 下一次折叠时报 `corrupt surface`。

**⇒ 替换区间必须是「工具配对平衡」的区间。单点替换一个带 tool-call 的 assistant 消息是错的。**

### 3.2 修正：区间 = 整个平衡步（assistant 消息 + 它的全部 tool/result）

这样配对恒等式 `+N（tool-call） − N（tool/result） = 0` 成立，切点两侧都平衡。

代价与对策：整步被遮蔽 ⇒ **工具结果也会从表面消失**。两条对策（建议同时用）：
1. **工具结果原文进 CAS**（复用 `cmbStore.putText`，producer 例如 `cot-toolresult`），ledger 里只留句柄；
2. 短工具结果（< 上限）**原文照抄进 ledger**，不牺牲可读性。

⇒ 这样压缩的收益全部来自推理（276,935 字符那个大头），而工具结果**一条不丢**（要么原文、要么句柄）。

---

## 4. 修正后的架构（三段式，主流式零卡顿）

```
【第一段：主流式（人类体验主线程，0ms 卡顿）】
  reasoning-delta …… 全部【原样透传】，用户看到打字机狂飙
  命中 reasoning block-end ⇒ 立刻拿到完整原始 CoT
      ├─ 同步：CAS 归档原文 ⇒ art:// 句柄              [防线① 先存后压]
      └─ 异步：并发拉起 LLM 提纯（后台，不阻塞任何透传）    [防线③]
  text / tool-call / tool-result …… 照常透传，绝不等待
      同时：把本步【所有】表面节点的 seq 记进 pending 槽

【第二段：工具执行（1~4s，天然空窗）】
  LLM 提纯在后台跑完 ⇒ 四态 ledger（200~400 字符）
  后验事实锁校验 ⇒ 不过则熔断（丢弃提纯稿，保留原样）    [防线②]

【第三段：下一个 Step 的 pre-step（首次出站【之前】）】
  在 payload 组装【之前】发射：
      session.append("compaction/summary", { summary, handle, shadowedSeqs, ... })
      session.append("user/message", ledgerMessage, {
          surfaceOp: { op: "replace", startSeq: stepStart, endSeq: stepEnd },   // ← 平衡区间！
          sourceEventSeqs: [summaryEvent.seq, ...shadowedSeqs]
      })
  ⇒ 本步 payload 里出现的就是 200 字看板，**原始 CoT 从未出站过** ⇒ 前缀哈希从未断裂。
```

### 4.1 为什么这不违反 H2（v1 我搞错了）

H2 管的是：**一个块已经以原样出站过一次之后**再改它（⇒ 云端 KV cache 前缀断裂 ⇒ 后缀全价重算）。
本方案里，第 N 步的原始 CoT **第一次出站**发生在第 N+1 步的 payload —— 而替换就发生在那个 payload
**组装之前**。⇒ **原文从未出站**，前缀从未含过它 ⇒ 零断裂。

H2 的正确表述应该是：**替换只允许发生在「该块尚未进入任何 payload」时**。这与现存的 `locked` 硬闸完全一致。

---

## 5. 发射协议（逐字段，可直接实现）

| 字段 | 值 | 理由 |
|---|---|---|
| event type | `user/message` | 官方正道；可携带 `sourceEventSeqs` |
| `message.content` | `[{type:'text', text: PREAMBLE + OPEN_TAG + ledger + CLOSE_TAG}]` | 复刻官方 framing |
| `message.source` | `{ kind:'plugin', plugin:'cot-form-b', ... }` | **绝不设成 `'user'`** ⇒ 与防线④隔离（§1.3） |
| `surfaceOp` | `{ op:'replace', startSeq, endSeq }` | 平衡区间（§3.2） |
| `sourceEventSeqs` | `[summaryEvent.seq, ...shadowedSeqs]` | 必须密集包含全部被遮蔽节点（`:234`） |
| 时机 | 下一个 step 的 `agent/request`，payload 组装之前 | H2 首次出站律（§4.1） |

⚠ `startSeq`/`endSeq` 必须 `>= ` 当前 seq 的**更早**事件（`surface.js:249`：`startSeq >= event.seq` 即抛错）。

---

## 6. 降级矩阵（终点永远是「原文」，不是「删点什么」）

| # | 失败 | 检测点 | 动作 |
|---|---|---|---|
| 1 | CAS 归档失败/超时 | 句柄为空 | **不替换**，保持原文 |
| 2 | 提纯超时 | budget（建议 2500ms） | 不替换，保持原文（**不是**降级到规则档——规则档的 2.45% 不值得再冒一次表面变更） |
| 3 | 提纯空稿/结构非法 | 结构校验 | 不替换 |
| 4 | HARD token 丢失 ≥1 | `verifyFacts` | **熔断**，不替换 |
| 5 | SOFT 召回 < 95% | `verifyFacts` | **熔断**，不替换 |
| 6 | 并集校验失败 | `meter.measure` 对照被遮蔽区间 | 不替换（复刻官方 `:596`） |
| 7 | 切点不平衡 | `toolPairingBalancedBefore/After` | **不替换**（复刻官方 `:540/:541`） |
| 8 | 任何未捕获异常 | try/catch | 不替换 |

**注意：本架构里「降级」= 不做任何事。** 表面保持原文，零风险。
这比 v1 的「降级到规则档」**更安全**——因为规则档也要改表面。

---

## 7. 验收门禁

| 指标 | 门槛 | 说明 |
|---|---|---|
| HARD token 召回 | **100%** | 句柄/路径/命令/引号原话/sha |
| SOFT token 召回 | **≥95%** | 裸数字、小数、百分比 |
| 表面完整性 | **零抛错** | 配对平衡 + 并集校验 + surface 断言全绿 |
| 主流式卡顿 | **0ms** | 第一段不 await 任何网络 |
| `savingPct` | **仅参考** | 不作准入（阶段一的血训） |

**测量方案（零外网零花费）**：`deploy/mock-llm` 起本地假网关 + 参数化坏回复 + 离线重放验表面。

---

## 8. 一个值得抄的官方优化（省钱）

`compaction-basic:259-261`：官方提纯调用**复用暖前缀缓存** ——
「replay the conversation prefix, then append the compaction instruction as the final user message
so the provider's warm prefix cache is reused」。

我方现行 `generateDistillation` 是**冷调用**（只发 CoT 当 prompt）。
改成「重放会话前缀 + 末尾追加指令」可让绝大部分输入命中缓存 ⇒ 提纯成本大幅下降。
**建议采用**（列作决策点 D9）。

---

## 9. 待批复的决策点（v2）

| # | 决策 | 我的建议 |
|---|---|---|
| **D1′** | 替换区间：单点 assistant vs **平衡整步** | **平衡整步**（单点会让表面 corrupt，§3） |
| **D2′** | 工具结果处置：原文进 ledger vs 进 CAS 留句柄 vs 混合 | **混合**（短的原文、长的进 CAS 留句柄） |
| **D3′** | 提纯失败时 | **什么都不做**（保持原文），不降级到规则档 |
| **D4′** | budget | 2500ms；工具执行是天然空窗，通常用不上 |
| **D5** | 提纯模型 | 跟随宿主（维持现状） |
| **D6** | 事实清单封顶 | 200 token，HARD 全带 / SOFT 按频次截断 |
| **D7** | `flushPendingEmit` 死代码 | **不删，改写**：它只差把事件类型换成 `user/message` |
| **D8** | 熔断阈值 | 分层 HARD 100% / SOFT 95% |
| **D9** | 是否抄官方的暖前缀缓存提纯 | **抄**（显著省钱） |
| **D10** | 是否无条件每步都压缩 | **先只压「推理占比 > 阈值」的步**，观察后再放开（建议） |

---

## 10. 不做（YAGNI）

- ❌ 自造 surfaceOp / 改会话协议。
- ❌ 第二套模型 / 多模型投票。
- ❌ 让 LLM 生成用户原话（机械注入正确，不动）。
- ❌ 删掉纯规则档 —— 它是「归档后才允许压缩」失败时的原样透传兜底，仍是安全网。

---

## 11. 还需要在实现前验证的两件事（零成本，本地可验）

1. **`agent/request` 是否真的在 payload 组装之前触发**（这是 §4.1 的全部依据）。
   验证法：本地起真机 step，在 `agent/request` 里 append 后立刻 dump 本次 payload 的 roles，
   确认看板已取代原文。
2. **`compaction/start` / `compaction/summary` 事件类型是否需要注册**才能 append。
   验证法：本地最小复现，直接 append 看是否抛 `unknown event type`。

这两件事**不改变设计形状**，但会在实现时卡人，所以先列出来。

---

## 12. v3 终审（2026-09-17）

### 12.1 归属澄清（记录纪律）

下面这些说法**不是本会话的助手提出的**，实际建议恰好相反，必须记对，否则明天没人知道决定的真实理由：

| 被归给我的说法 | 我上轮的实际建议 |
|---|---|
| 「废除事实锁」 | D8 = 分层熔断（HARD 100% / SOFT 95%） |
| 「2500ms 太短」 | D4′ = 2500ms 固定预算 |
| 「800 是后期了」 | 我从未提过任何数值门槛阶梯 |
| 「按步数算会翻车」 | 我从未提过步数阶梯；D10 原文是「只压推理占比超阈值的步」 |

### 12.2 §11 的两项未知 —— 已结案

```
dsh-agent-loop/lib/index.js
:894   await this.dispatch.waterfall("agent/pre-step", {...})   ← 官方压力检查点
:1143  await this.dispatch.waterfall("agent/request",   {...})   ← 之后才派发
```

⇒ `agent/pre-step` **先于** `agent/request`，两者都在 payload 组装之前。
⇒ `dsh-compaction-basic/README.zh.md:112`：官方 compaction 的 auto 检查就挂在 `agent/pre-step`。
⇒ **我方插件 `index.js:1143` 已经挂在 `agent/pre-step` 上** —— 钩子早就有了，不用新加。

D10 的读数来源也已确认存在：

```
dsh-token-meter/lib/index.js:627   session.requestContext()?.contextWindow
dsh-agent-presets/presets/standard/agent.cordis.yml:132
    # `tokenMeter` is deliberately NOT in this realm: the meter stays on the HOST
```

⚠ 待运行时确认（零成本本地可验）：我方插件注册在整个 profile 的 host 补丁里，理论上在 HOST realm、
`ctx.get('tokenMeter', false)` 应可达；但必在真机上打一次日志证实，**不许假设**。
若不可达，退化路径 = 只用 `session.requestContext()?.contextWindow` + 自行估算占用。

### 12.3 D10 已落地并测绿

| 文件 | 内容 | 结果 |
|---|---|---|
| `packages/dsh-cot-form-b/headroom.js` | `headroomOf` / `minRawCharsFor` / `bandNameFor` / `DEFAULT_BANDS` | 纯函数，零依赖 |
| `packages/dsh-cot-form-b/headroom.selftest.mjs` | 33 项断言 | **33 通过 / 0 失败** |

实现要点（比口头规格更严）：
- **边界语义显式化**：`inclusive` 标志，不吃浮点运气（恰好 70% ⇒ 500，恰好 30% ⇒ 500）。
- **读数缺失一律走保守档 800**：窗口 undefined / 0 / 负数 / NaN / 字符串 / 占用>窗口，六种异常全部断言锁死。
  ⇒ 宁可少赚，绝不因缺读数而过度压缩倒贴。
- **保留 `staticMinRawChars` 逃生门**：可一键退回静态门槛，用于事故回滚。

### 12.4 终审决策表

| # | 决策项 | 定调 | 我的态度 |
|---|---|---|---|
| D1′ | 替换区间 | 平衡整步 | ✅ 我提的（单点必 corrupt） |
| D2′ | 工具结果 | 短的内联 / 长的进 CAS 留句柄 | ✅ 同意 |
| D3′ | 失败降级 | 保持原文，不折腾 | ✅ 同意（且比 v1 更安全） |
| D4′ | 时延预算 | 工具跑完后 + 1.0s 相对宽限 | ✅ 同意，**优于我原来的固定 2500ms** |
| D5 | 提纯模型 | 跟随宿主，读动态配置 | ✅ 同意 |
| D6 | 事实清单上限 | **废除** | ⚠️ 同意（见 12.5） |
| D7 | 死代码 | 改写为 user 检查点 | ✅ 同意 |
| D8 | 事实锁门禁 | **废除** | ⚠️ 同意废除**门禁**，保留**度量**（见 12.5） |
| D9 | 缓存提纯 | 启用暖前缀 | ✅ 同意，且与 D10 耦合（见 12.6） |
| D10 | 触发门槛 | 上下文剩余百分比三档 350/500/800 | ✅ 同意，已落地测绿 |

### 12.5 我的一处保留：废除门禁 ≠ 废除度量

D8 废除**阻断式门禁**我同意，理由成立且本会话有实证：
我自己的 v1 保真度门禁**误报率 100%**（`RE_NUMBER` 从 `cq3G49xaZ` 里抠出 `49` 再找不到独立 `49`）。
裁判误伤 > 模型出错，这个判断我认。

**但有一条底线**：本项目自己的法律是「验收判据是 `tokenRecall` 而非 `savingPct`」，
且上一场事故的**根本成因正是「有一个 50.5% 的削减率，却没有任何保真度数据」**。
若把度量也一并删掉，等于回到事故的原始条件。

⇒ **保留召回率作为「只记不拦」的 trace 指标**（约 15 行，零成本、零阻断、可一键删）。
它不参与任何决策，只让我们下次能用**数据**而不是意见来讨论要不要恢复门禁。
⚠ 若要连度量一起砍，说一声即删，但我建议留下。

### 12.6 D9 × D10 耦合（一个连带收益）

`breakevenRaw()` 算的是「省下的 token 要盖过提纯本身的开销」。
D9 启用暖前缀缓存后，提纯输入的主体走 1 折缓存价 ⇒ **保本点整体下移**
⇒ D10 那三档偏激进的阈值（350/500）在 D9 之后**才算真正站得住**。
⇒ 若最后砍掉 D9，D10 的 350 档需要重新推导，不能直接沿用。

