# 求助简报：DSH 思维链压缩插件（cot-form-b）如何回收"迟到"的蒸馏结果

> 这份简报是自包含的。请**先读完「一、硬约束」再提方案**——本项目历史上被否决的
> 方案，绝大多数不是想法不好，而是**违反了下面某条不可协商的物理或协议约束**。

---

## 〇、背景

宿主是 **DSH（DeepSeek Harness）**，一个自研 Agent 框架。会话事件是**只追加（append-only）**
的日志，落到 JSONL。其中一个插件 `dsh-cot-form-b` 负责**压缩模型的思维链（reasoning / CoT）**，
目的是让长任务里体积巨大的推理文本不把上下文撑爆。

### 它怎么工作（mode: 'birth'，当前线上配置）

1. 模型流式输出 reasoning。插件在 `llm/stream` 里**扣住**这些 delta（不立即透传）。
2. 在 block-end 处做两件事**并行**起飞：
   - **归档**：把推理原文逐字写进 CAS（内容寻址存储）——**保证原始 CoT 永不丢失**。
   - **蒸馏**：调一次宿主模型，让它把这段推理压成 200–400 字的语义摘要（A 态）。
3. 在同一个流的 `finish` 事件处**收网**：
   - 还没出站的块才能改写。若蒸馏成功且净省达标 ⇒ 用摘要替换；
   - 超时 / 失败 / 不划算 ⇒ **原样放行原文**（B 态）。
4. 改写发生在 chunk 被宿主 push 之前，所以是**普通 append**，不需要任何 replace 机制。

### 用户的核心诉求

用户认为：**"越大块确实越重要"**，要求**把大块的蒸馏超时率降下来**。

---

## 一、硬约束（**违反任意一条即不可行，请不要提出绕过它们的方案**）

### H1. append-only，且没有"就地修改"
会话日志只追加。要看起来"改掉"了已有内容，只能用 `surfaceOp: replace` 让新事件**遮蔽**
（shadow）旧事件。没有别的机制。

### H2. `assistant/message` **永远不能充当"替换者"**
源码 `dsh-session/lib/types/surface.js:207-208`：

```js
if (event.type === 'assistant/message' && raw !== undefined) {
    throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
}
```

一次 `replace` 必须在新事件上携带 `sourceEventSeqs`（列出全部被遮蔽节点），否则
`:234-236` 会因 `missing` 非空而抛错。

**⇒ 推论：无法用"另一条 assistant 消息"去替换一条 assistant 消息。**
想改写 assistant 内容，替换者只能是别的角色（实际只有 `user/message` 可用）。

### H3. `user/message` **可以**遮蔽 `assistant/message`
这不是理论，是**生产代码正在做的事**：看板（ledger）就是用
`session.append('user/message', …, { surfaceOp: {op:'replace',…}, sourceEventSeqs })`
去吞并旧的推理块（`emitter.js:216-221`）。
看板正文开头固定有一段声明：`[自动生成的工作记忆看板 · 非用户发言]`。

### H4. ⛔ **绝对禁止：会话末尾出现"连续 user 而没有 assistant"**（用户亲身踩过的坑）
用户原话：

> 之前有出现过问题，就是末尾的连续 user 没有 assistant，导致模型认为他没有回答最开始的
> user 问题，就是哪怕在 user 里面说自己是 assistant 也可能不起效果。

**⇒ 这是本项目最硬的一条。** 一旦遮蔽掉末尾那条 assistant，把 `user/message` 留在末尾，
模型会认为"自己还没回答用户第一个问题"，行为直接崩坏；**在看板正文里写"我是 assistant"
也救不回来**（已实测无效）。

**⇒ 推论：任何替换之后，表面（surface）的最后一条必须仍是 `assistant/message`。**

### H5. 遮蔽区间必须"平衡"（balanced span）
`balanced-span.js` 要求：遮蔽区间的右端必须**严格**落在"活跃尾部"之前；若会咬进活跃尾部，
**整个操作放弃**（原文保持不动）。切点还必须保证移除该区间后事件序列仍然良构
（不能出现连续 user、不能从 assistant 开始等）。

### H6. `keepTail`（缺省 1）= 最近 1 条 `assistant/message` **永不进入遮蔽区间**
这条**正是为了满足 H4 而存在的护栏**（`balanced-span.js:103-104, 118, 147, 167`），
并且被钉成回归闸：`emitter.selftest.mjs:204`
```
eq('★★ 活跃尾部（最后一条 assistant）绝不被遮蔽', surfaceOp.endSeq < lastA.seq, true)
```

### H7. 原始 CoT 绝不允许因压缩而丢失
归档（写 CAS）**先于**压缩。归档失败 ⇒ 原样透传。这是铁律，不可协商。

### H8. 句柄（CAS 指针）**绝不能**出现在模型可见的正文里
用户 2026-09-18 的终审。事故复盘：曾把兜底改成"裸句柄指针"，导致模型失去自己的思维链、
对着一根指针无法思考。**做法已永久废除。** 句柄只用于磁盘上的归档登记。

### H9. "零 rules 兜底"铁律
只有"宿主模型蒸馏成功 **且** 净省字符数 ≥ 阈值"才允许替换。绝不用规则/启发式去代替蒸馏产出。

### H10. KV cache 前缀不变性（这条是**有争议的**，见第四节）
云端推理按前缀缓存计费。若在某个位置改变了已发送前缀的**任何**字节，该位置之后的**整个后缀**
都要按全价重算（`suffix cascade invalidation`）。缓存命中价约是全价的 `d_eff ≈ 0.02`。

### H11. 延迟预算
收网等待处于**用户关键路径**上：用户发完消息后要等这段时间。所以"多等一会儿"
不是免费的——见第二节实测：**平均已经等 4.45 秒，p90 等满 6.01 秒**。

---

## 二、实测数据（全部来自本机 trace，样本 293 次蒸馏）

### 2.1 当前配置
```yaml
mode: birth
finishWaitMs: 6000   # 收网最多等多久
timeoutMs: 8000      # 蒸馏自身的硬超时
graceMs: 1000
```

### 2.2 时间结构
- **提前量 `gapMs = finish-enter − fired`：p50 = 4ms**。
  ⇒ 蒸馏在 block-end 立即起飞，收网在 4ms 后进入。
  ⇒ **`finishWaitMs` 就是蒸馏的全部预算，不存在"白捡的额外时间"。**（这是关键事实）

### 2.3 蒸馏真实工期
```
n=293   min=1749ms   p50=4438ms   p90=8006ms   max=8020ms
>=7900ms: 41 (14.0%)      >=6000ms: 71 (24.2%)
ok=true: 248/293
```
**`max=8020ms` 精确卡在 `timeoutMs=8000` 上** ⇒ 超过 8 秒的蒸馏**根本不存在**，
它们被硬杀成 `ok=false`。
⇒ **所以"单纯把收网等待调大"是无效的**：等更久也等不到一个已经被杀死的调用。

### 2.4 超时率按块大小分桶（用户最关心）
```
桶            样本  凝练成功  超时率
0-1500        109       60    11.0%
1500-3000      77       50    11.7%
3000-5000      60       30    40.0%
5000-8000      32       17    43.8%
8000-∞         20        8    55.0%

大块(>=5000)  n=52   成功 25  超时 25  → 48%
小块(<5000)   n=246  成功 140 超时 45  → 18%
```
大块超时率是小块的 **2.7 倍**。用户直觉正确。

### 2.5 用户实际等待（这是真正的痛点）
```
每次收网用户等待   n=297   p50=4.448s   p90=6.009s   max=6.017s

按下场分组：
  condensed                     n=165  p50=3.999s
  passthrough:distill-timeout   n= 69  p50=6.007s   ← 等满 6 秒，一无所得
  passthrough:archive-failed    n= 52  p50=4.260s
  passthrough:no-gain           n=  7  p50=3.851s
  passthrough:distill-failed    n=  4  p50=3.265s

总等待 1349.5s，其中【等了却一无所获】678.3s = 50.3%
```
**超时组的 p50 = 6.007s，精确等于 `finishWaitMs`** ⇒ 它们全部等满全程。

### 2.6 "迟到"的蒸馏结果（本简报的核心议题）
把每次 `birth-fired` 与它随后的下场配对：
```
birth-fired 总数: 297
passthrough = distill-timeout: 66
★ 其中【后来其实成功了 ok=true】: 24        ← 结果被丢弃
  这些块原文平均 5,380 字符
  已产出却被丢弃的凝练文本合计 13,703 字符
```
**即：收网已经放行原文之后，蒸馏还在继续跑，并且有 24 次真的跑完了 —— 结果无人认领。**

### 2.7 价值密度（为什么大块值得救）
```
大块每次凝练节省 ~6,873 字符
小块每次凝练节省 ~  376 字符        → 大块单位价值是小块的 18 倍
```

### 2.8 预热（prewarm，非问题，列出以免误判）
插件会发一次 `HEAD /` 只为**捂热 socket**，不产生任何 completion。实测 273 次中 272 次返回
**404 —— 这是设计使然**（服务端不认该路径，但 TCP/TLS 连接已建成）。ttfb p50=352ms，
实测收益约省 411ms。
⚠️ **不要**把这个 404 当成 bug 或性能浪费。

---

## 三、已经排除的方案（请不要重复提出）

| 方案 | 内容 | 否决原因 |
|---|---|---|
| **方案 1** | 对蒸馏输入做采样/截断，缩短 prefill | 使摘要不再忠实于全文，违反 H9 的"零 rules"精神与保真要求 |
| **方案 2** | 单纯调大 `finishWaitMs` | 直接加在用户关键路径上（已经 p50 等 4.45s / p90 等 6.01s，且 50.3% 是白等） |
| **仅调大 `timeoutMs`** | 只把 8000 提到更大 | **无效**：收网在 6000ms 就放行了，等不到；必须与 `finishWaitMs` 同时调 |
| **prewarm 修复** | 把 404 当 bug 修 | 非 bug，见 2.8 |
| **全局 `keepTail: 0`** | 放开活跃尾部保护 | 直接触发 **H4**（连续 user），用户已亲历事故 |

---

## 四、核心矛盾（**当前真正卡住的地方**）

### 4.1 用户对 H10 的订正 —— 我认同，且这是本简报最重要的输入

代码里有一句注释记录了一次**终审否决**（2026-09-15，用户本人下的）：

> ⛔⛔ 用户终审否决「延迟一轮替换（deferred replace）」。物理理由 = H2 首次出站不变律：
> 一个块一旦以**原样**出站过一次，它就已经进了云端的 KV cache。事后再把它换成摘要
> ⇒ 前缀哈希在该位置断裂 ⇒ 从断裂点往后的**整个后缀**全部按全价重算。
> 罚金 ≈ 后缀 × (1 − d_eff)；延迟替换多赚的 ≈ (R−1) · Δ · d_eff
> 以 d_eff = 0.02 计：罚 2,940 个全价 token 等价物，只赚 114 ⇒ **净亏约 25 倍**。
> ⇒ 铁律：**一个块只有在「还没出站」的时候才允许被替换。**

**但用户现在指出这个算式的前提错了。** 重新算一遍（设第 N 轮的请求前缀为 `[P]`，
模型产出 `[B(原文)] [A(其余输出)]`；第 N+1 轮请求前缀 = `[P][B][A]`）：

```
不替换：第 N+1 轮要 prefill  |B| + |A|     ← [B][A] 从未发给过 API，本来就是全价
替换：  第 N+1 轮要 prefill  |B'| + |A|
```

`[A]`（该轮其余输出）**两种情况下都是全价 prefill**，因为它从来没被发送过、不在缓存里。
所以它**不是罚金**。差额只有 `|B| − |B'|` ⇒ **替换当场就净赚**。

⇒ 那个"25 倍净亏"只在一种情形成立：**B 埋在历史深处，它后面的后缀已经被发送并缓存过了**
（那是 distill 模式改写任意历史块的情形）。**对于"刚出站的那个块"，罚金为零。**

**用户的结论：认领迟到结果是划算的，应该做。**

### 4.2 但是，做这件事会撞上 H4 / H2，形成死结

要在第 N+1 轮的 pre-step 认领迟到结果，需要遮蔽**刚刚出站的原文块 B**。而：

- **B 是"最近的一条 assistant"** ⇒ 撞 H6（`keepTail=1` 永不遮蔽它），
  且 `balanced-span.js:167` 规定"想咬到尾巴就整个放弃"。
- **不能放开 `keepTail`** ⇒ 会撞 **H4**：遮蔽掉末尾 assistant 后，末尾变成
  `user/message`（看板），与下一条 user 构成**连续 user、中间没有 assistant** ⇒
  **模型会认为它没回答最开始那个问题**。用户明确表示：**在看板里写"我是 assistant"
  也不管用。**
- **不能用 assistant 消息去替换它** ⇒ 撞 **H2**（`surface.js:207`：assistant/message
  禁止携带 `sourceEventSeqs`）。

**⇒ 死结：想省钱就必须改写末尾那条 assistant；改写末尾那条 assistant 就会
留下连续 user（模型崩坏），或者根本不被协议允许。**

### 4.3 还需要注意的时序细节

- 收网发生在同一个流的 `finish` 事件处（`index.js:1094-1110`），此后 chunk 被 push、
  装配成 assistant 消息 —— 此刻它已"出站"，只能靠 replace 改写。
- 看板（ledger）是 `agent/pre-step` 发出的 `user/message`，它**今天已经在遮蔽旧的推理块**，
  但它刻意把"最近 1 条 assistant"排除在外（H6）。所以"遮蔽 assistant"这条路本身是通的，
  **只是恰好不能用在我们需要的那个块上**。
- 多块并行：一次 `finish` 可能同时收网多个 reasoning 块（`Promise.all`）。

---

## 五、请你回答的问题

**目标：把大块（≥5000 字符）的蒸馏超时率降下来，且不违反 H1–H11 任意一条。**

请针对下面三点给出方案：

1. **可行性裁决**：在上述约束下，"事后认领迟到的蒸馏结果（用摘要替换已出站的原文块）"
   **到底可不可能**？如果可能，协议上合法的具体形状是什么（发什么事件、谁的 role、
   `sourceEventSeqs` 怎么给、如何保证末尾仍是 assistant）？如果不可能，请**明确说不可能**
   并指出是被哪条约束封死的。

2. **如果不可能**，请给出**别的**能把大块超时率降下来的手段。注意 2.3 的事实：
   `max=8020ms` 卡在 `timeoutMs=8000` 上，所以任何"等更久"的方案必须**同时**
   放开蒸馏自身的超时；并且必须面对 2.5 的事实：**已经有 50.3% 的等待是白等**。

3. **如果可能**，请顺便给出一个"既改写末尾 assistant、又保证末尾仍是 assistant"的
   构造。提示：是否可以先遮蔽、**再补发一条 assistant**？若可以，补发的
   `assistant/message` 会不会违反"embeds its source stream"那条（H2）？
   这需要你对协议语义做出判断——**这正是我们最不确定、最需要外部视角的地方。**

---

## 六、附：关键源码位置（便于你核对，若你需要我可以提供原文）

| 位置 | 内容 |
|---|---|
| `dsh-session/lib/types/surface.js:207-208` | assistant/message 禁止携带 sourceEventSeqs |
| `dsh-session/lib/types/surface.js:234-236` | 替换者必须列全所有被遮蔽节点 |
| `dsh-cot-form-b/emitter.js:216-221` | 看板用 user/message + replace 遮蔽旧推理块 |
| `dsh-cot-form-b/emitter.js:245` | 活跃尾部宽度来自配置（缺省 1） |
| `dsh-cot-form-b/balanced-span.js:103-104,118,147,167` | keepTail 语义与"咬尾巴即放弃" |
| `dsh-cot-form-b/emitter.selftest.mjs:204` | 活跃尾部保护被钉成回归闸 |
| `dsh-cot-form-b/index.js:159-168` | 2026-09-15 对 deferred replace 的终审否决（H10 出处） |
| `dsh-cot-form-b/index.js:809-829` | birth 模式为何存在（H2 导致的破局点）+ 四条硬约束 |
| `dsh-cot-form-b/index.js:956-1017` | `birthFinish`：收网、判定、放行 |
| `dsh-cot-form-b/index.js:1094-1110` | `finish` 事件处多块并行收网并 yield |

---

## 七、本地终审（2026-09-21）："先补后遮"能不能落地

> 外部模型提出"先补一条合法 assistant，再遮蔽旧区间"。**结论：形状对，窗口不存在。**

### 7.1 裁决

| 命题 | 裁决 | 依据 |
|---|---|---|
| 补发一条 `assistant/message`（不带 surfaceOp）协议合法 | ✅ 成立 | `dsh-session/lib/index.js:1170-1210` 无类型白名单 |
| 补发之后，旧的末尾 assistant 会滑出尾部保护 | ✅ 成立 | `balanced-span.js:118-124` `tailStartIdx` 每次调用现算 |
| `assistant/message` 可以当**替换者** | ❌ 永久不可能 | `surface.js:207-208` 硬抛 |
| 用 `user/message` 看板遮蔽旧区间合法 | ✅ 成立（H3） | `surface.js:346-355`，替换者只需列全被遮蔽节点 |
| **存在"step 已开 + 末尾正是想换的 assistant"的时刻** | ❌ **不存在** | `dsh-agent-loop/lib/index.js:894 / 951 / 1028 / 1143` |
| 因此"事后认领迟到蒸馏"在 `mode:'birth'` 下可落地 | ❌ **不可落地** | 同上 |

### 7.2 决定性证据：宿主循环的时序

`dsh-agent-loop/lib/index.js`，一个 step 的固定顺序：

| 行 | 事件 | 此刻的"末尾表面节点" | step 是否开着 |
|---|---|---|---|
| `:894` | `agent/pre-step` 派发 | **想换掉的那条 assistant** ✅ | ❌ 未开（`step/start` 在 `:951`） |
| `:951` | `append('step/start')` | — | 开 |
| `:1028` | `if (firstAttempt) append('user/message', …)`，`decision.messages = claimed + runtime context`（`:895-901`） | **user/message** ❌ | 开 |
| `:1143` | `agent/request` 派发（cot-form-b 唯一被允许的发射时机） | **user/message** ❌ | 开 |

两个条件**永不共存**：能改末尾的时候 step 没开（`assistant/message` 会撞 token-meter 的 step 匹配），step 开着的时候末尾已经不是那条 assistant 了。

（稳健性：若某一步 `decision.messages` 为空——例如工具续跑步——则 `:1028` 不追加 user，此时末尾是上一步的 `tool/result`，**依然不是**那条 assistant。所以无论哪条分支，"step 开着 ⇒ 末尾不是目标 assistant" 都成立。）

若硬在 `agent/request` 补发：表面变成 `[…, B, U_ctx, A_new]`；再用 user 看板遮蔽 B 得到 `[…, U_ledger, U_ctx, A_new]` —— **两条连续 user**，H4 当场复发。要消掉它就得把 `U_ctx`（宿主本轮刚注入的运行时上下文）一起吞进遮蔽区间，等于从出站载荷里删掉宿主自己的上下文注入，不可接受。

**`mode:'checkpoint'` 是这个矛盾下的唯一出路，而它的代价正是"永不触碰活跃尾部"**（`emitter.js:216-221` + `balanced-span.js:167-169`）—— 所以它天生对"刚出站的那一块"无解。

### 7.3 现存代码早已承认这堵墙

- `index.js:1300-1308`：注释标题就是"落盘：**唯一**允许替换的地方（H2）"，并写明"等到下一个 step 开着再发 …… 所以这里只入队，真正的 append 交给 `flushPendingEmit()`"。
- `index.js:1544`：checkpoint 路径"绕开 `surface.js:207` / `:234` 两道断言"。
- `index.js:1539`：`mode === 'birth'` 时**直接 return**，事后替换全关。

生产痕迹（`storages/cot-form-b/trace.log`，6 个 BOOT，2.83 MB）：

| tag | 次数 |
|---|---|
| `skip-mode-birth` | **742** |
| `emit-queued` | **0** |
| `replaced` | **0** |
| `replace-threw` | **0** |
| `checkpoint-emitted` / `checkpoint-skip` | 0 / 0 |
| `birth-condensed` / `birth-passthrough` | 165 / 158 |

⇒ 现行配置下**事后替换路径一次都没跑过**。66 次超时里后来 `ok=true` 的那 24 次（13,703 字符摘要）是**按设计丢弃**，不是漏做。

### 7.4 顺带挖出一颗哑弹

`index.js:1365-1371`：

```js
session.append('assistant/message', { turn, step, message }, {
  surfaceOp: { op: 'replace', startSeq: item.aev.seq, endSeq: item.aev.seq },
  sourceEventSeqs: [item.aev.seq],
})
```

`assistant/message` + `sourceEventSeqs` ⇒ **100% 命中 `surface.js:207` 抛错**，被 `:1373 catch` 吞成 `replace-threw` 静默失败。今天没造成伤害，只因为 `appendReplace`（`:1310-1314`）在 birth 模式压根没被调用（`emit-queued`=0）。**谁把这个开关打开，谁就撞墙。**

### 7.5 那么还能做什么（都不依赖新钩子）

1. **回收 `archive-failed` 的纯亏等待**。`birthFinish:993` 等的是 `Promise.all([diskP, distillP])`；写盘已经失败时提纯必然拿不到句柄（`:1003` 铁律③），却仍陪跑到 budget。改成 diskP 一失败即刻放行。本日志 52 次。
2. **给大块预留产能**，而不是统一 8000ms。`>=5000` 超时率 48% vs `<5000` 18%，而单块价值约 18×。
3. **优化蒸馏提示词本身**（外部模型这条与本地数据一致）：瓶颈在生成侧，不在输入保真度。
4. **要事后替换，只能走 checkpoint 路线**（`user/message` 看板 + 只动非尾部平衡整步），并接受它永远追不回迟到结果。

### 7.6 必须重申的数据缺陷

`max=8020ms` **恰好**卡在 `timeoutMs=8000` 上 ⇒ 数据是**右删失**的：我们分不清 8000ms 是"蒸馏的自然工期"还是"被我们掐死的那一刻"，也没有任何阶段分解（网络 / 排队 / 生成）。**任何"再等久一点"的结论都必须在放开蒸馏超时后重测，否则方向可能是反的。** 同理，2.x 节的统计口径不一致（293 / 298 / 297 / 69 / 66）—— 引用绝对值时以本节表格为准。

