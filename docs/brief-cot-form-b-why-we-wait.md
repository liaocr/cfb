# 简报：cot-form-b 为什么"以前无缝、现在硬等"——全部现状与待优化项

> 面向外部模型。所有数字都来自本机生产日志，标了出处。凡是我没验证的，我明写"未验证"。
> 生成时间 2026-09-21。上一份简报见 `docs/brief-cot-form-b-late-claim.md`（迟到结果认领的裁决）。

---

## 〇、一句话问题

**同一个插件，同一个提纯模型，为什么 `mode:'checkpoint'` 时代用户感觉不到等待，`mode:'birth'` 时代却要硬等最多 6 秒？**

答案在下面 1.2 节，是**时序**差异，不是性能差异。

---

## 一、两个模式的真实形状（源码级）

### 1.1 `mode:'checkpoint'`（旧，用户说"完美无缝"）

| 阶段 | 位置 | 行为 |
|---|---|---|
| 起火 | `index.js:1282` | 某个 block **结束时** `early-fired`，后台起一次提纯，**不阻塞任何人** |
| 选靶 | `emitter.js` + `balanced-span.js:118-124` | `targetSeq` 缺省 = 跳过 `keepTail`(=1) 条后的那条 assistant ⇒ **倒数第二条**，即"上一轮的回答" |
| 收网 | `index.js:1289-1294, 1450-1461` | `awaitDistilled(raw, graceMs)`；就绪⇒用提纯稿；未就绪⇒**最多再等 `graceMs`**（cfg 缺省 300，实配 1000），然后 `distill-not-ready` ⇒ **原样不动、no-op** |
| 发射 | `emitter.js:216-221` | `user/message` 看板 + `surfaceOp:{op:'replace',startSeq,endSeq}`，遮蔽整步 |
| 时机 | `index.js:1528` `agent/pre-step` | 在 `step/start`（`dsh-agent-loop:951`）**之前** |

**关键点：从"起火"到"收网"之间隔着整整一个回合。** 提纯有几百毫秒到几十秒的自然工期，而收网发生在**下一轮**——那时提纯早就好了，`awaitDistilled` 走的是"已就绪 ⇒ 0 等待"分支。等待时间**根本不存在**。

### 1.2 `mode:'birth'`（现役，硬等）

| 阶段 | 位置 | 行为 |
|---|---|---|
| 起火 | `index.js:913/923` | 块结束 `birthStart`：`diskP`（写 CAS）+ `distillP`（提纯）**同时**起飞 |
| 收网 | `index.js:1094-1110` | 流 `finish` 处 `Promise.all(pending.map(birthFinish))` |
| 等待 | `index.js:979-993` | `budgetMs = cfg.birthFinishWaitMs`（实配 6000）；`await birthDeadline(Promise.all([diskP, distillP]), 6000)` |
| 放行 | `index.js:1006-1016` | 提纯成功且净省够 `birthMinSavedChars`(50) ⇒ 摘要；否则原文逐字 |

**关键点：起火与收网在同一次 LLM 流的"块结束"与"流结束"之间。**

实测（n=293）：

```
gapMs（block-end → finish）  p50 = 4ms
```

**4 毫秒。** 提纯是 3.3~4.0s 的活（探针 `birth-distill-settled`），我们只给了它 4ms 的自然工期，剩下的全靠 `birthFinishWaitMs` 硬等。**所以"等待"不是被谁拖慢了，是我们自己把窗口从"一个回合"压缩到了"4 毫秒"。**

### 1.3 为什么 birth 非存在不可

`index.js:809-829` 记录了原因：`surface.js:207-208` 硬抛——`assistant/message` **不能携带 `sourceEventSeqs`**，因此**永远不能当替换者**。而 checkpoint 路径只在 `agent/pre-step` 发射（`index.js:1528`），那一刻 `step/start` 还没开（`dsh-agent-loop:951`），`assistant/message` 会撞 token-meter 的 step 匹配（`index.js:1300-1308` 记录了 09-16 的压缩死锁）。

⇒ **"刚出站的那一块"在事后物理上改不了。** 唯一出路是在它出站**之前**就改好 —— 这就是 birth。代价就是 1.2 的 4ms 窗口。

---

## 二、全部现状（陈列）

### 2.1 现役配置

```
mode: 'birth'            dryRun: false
finishWaitMs: 6000       timeoutMs: 8000      graceMs: 1000
CMB: threshold 3072, requireRetrieveChannel true, l1StrictBudget true, tinyL0 false, trace true
```

### 2.2 等待开销（n=293 次收网）

| 指标 | 值 |
|---|---|
| 提纯工期 min / p50 / p90 / **max** | 1749 / 4438 / 8006 / **8020 ms** |
| `gapMs` p50 | **4 ms** |
| `>=7900ms`（几乎撞满） | 41 次（14.0%） |
| `>=6000ms` | 71 次（24.2%） |
| **总等待** | **1349.5 s** |
| **其中零收益** | **678.3 s（50.3%）** |
| 用户可见等待 p50 / p90 | 4.448 s / 6.009 s |
| 超时组用户等待 p50 | 6.007 s（= `finishWaitMs`，即撞满） |

### 2.3 放行原因分布

| `birth-passthrough` 原因 | 次数 |
|---|---|
| `distill-timeout` | 69 |
| `archive-failed` | 52 |
| `no-gain` | 7 |
| `distill-failed` | 4 |
| `birth-condensed`（成功） | 165 |

### 2.4 超时率与块大小强相关

| 块大小 | 超时率 |
|---|---|
| 0–1500 | 11.0% |
| 1500–3000 | 11.7% |
| 3000–5000 | **40.0%** |
| 5000–8000 | **43.8%** |
| 8000+ | **55.0%** |

大块（≥5000）48% vs 小块（<5000）18%。而单块价值：大块省 ~6,873 字符 vs 小块 ~376 字符 ⇒ **18×**。
⇒ **我们最需要压缩的块，恰恰是最容易超时的块。**

### 2.5 迟到结果被丢弃

66 次超时里，**24 次后来 `ok=true`**（平均块 5,380 字符，合计 **13,703 字符**摘要产出后扔掉）。
这不是 bug，是设计：`mode:'birth'` 下事后替换路径**全关**（`index.js:1539` 直接 return）。

### 2.6 生产痕迹证明"事后替换路径从未跑过"

`storages/cot-form-b/trace.log`（2.83 MB，6 个 BOOT）：

| tag | 次数 |
|---|---|
| `skip-mode-birth` | **742** |
| `emit-queued` | **0** |
| `replaced` | **0** |
| `replace-threw` | **0** |
| `checkpoint-emitted` / `checkpoint-skip` | 0 / 0 |
| `birth-condensed` / `birth-passthrough` | 165 / 158 |

⚠️ **日志只覆盖 birth 时代**（首个 BOOT 2026-09-19T02:58，`emitting` 已含 `birth@llm/stream`）。checkpoint 时代的实测数据**不在本机**，1.1 节是源码推断，不是实测。

### 2.7 数据本身的两个缺陷

1. **右删失**：`max = 8020ms` **恰好**卡在 `timeoutMs = 8000` 上 ⇒ 分不清 8000ms 是提纯的自然工期，还是被我们掐死的那一刻。
2. **无阶段分解**：不知道 8 秒花在 网络 / 排队 / 生成 的哪一段。
3. **口径不一致**：历史统计里 293 / 298 / 297 / 69 / 66 混用。**引用绝对值时以本文件 2.2/2.3 为准。**

---

## 三、已被否决/已证伪的方案（别重复提）

| 方案 | 否决理由 |
|---|---|
| 让 `assistant/message` 当替换者 | `surface.js:207-208` 硬抛，**永久不可能** |
| 先遮蔽、再补发 assistant（先遮后补） | 遮蔽后末尾是 user ⇒ H4 复发（尾部连续 user ⇒ 模型认为它没回答） |
| 先补 assistant、再遮蔽（先补后遮） | 形状对，**窗口不存在**：能改末尾时 step 没开；step 开着时末尾已不是那条 assistant（`dsh-agent-loop:894/951/1028/1143`）。详见 `brief-cot-form-b-late-claim.md` 第七节 |
| 事后认领迟到蒸馏结果 | 同上一行，架构性不可落地 |
| 单纯"等更久" | 必须先放开 `timeoutMs:8000`，否则 2.7 的右删失让方向可能是反的 |
| 在 `agent/request` 补发 assistant 再遮蔽 | 会得到 `[U_ledger, U_ctx, A_new]` ⇒ 两条连续 user；消掉它就得吞掉宿主本轮注入的 runtime context |

---

## 四、待优化清单（我要的就是这些的建议）

### 4.1 已定位、可立即做的

1. **回收 `archive-failed` 的纯亏等待（52 次）**
   `birthFinish:993` 等的是 `Promise.all([diskP, distillP])`。写盘已失败时，提纯**必然拿不到句柄**（`:1003` 铁律③：`if (!handle) return pass(...)`），却仍陪跑到 budget。
   ⇒ 改成 diskP 一失败即刻短路。**这是纯粹的免费午餐。**

2. **给大块预留产能，而不是统一 6000ms**
   见 2.4：大块超时 48%、价值 18×。可能的形状：按 `rawChars` 分档给预算；或让大块**提前起火**（现在 `birthStart` 在块结束才点火，4ms 后才收网——有没有办法在块还在流式生成时就先提纯前缀？）。

3. **优化蒸馏提示词本身**
   瓶颈在**生成侧**（4.4s 生成一份摘要），不在输入保真度。缩短输出长度 / 换更小更快的模型 / 结构化输出，可能比任何调度改动都有效。

4. **指标拆分**
   现在 `birth-passthrough` 一个桶混了 4 种原因。应拆成 `finish-miss` / `hard-timeout` / `late-recovered` / `final-uncompressed`，否则无法判断优化是否有效。

### 4.2 需要外部视角判断的

5. **`gapMs = 4ms` 能不能变大？**
   这是整个问题的根。现在"块结束 → 流结束"只有 4ms，因为块一结束模型就结束了。若能让块结束得更早（例如按 token 数中途切块），提纯就多出几百毫秒的自然工期。
   ⇒ **在 `llm/stream` 层面，"块"的边界是固定的吗？有没有办法把长 reasoning 块提前封口？**

6. **有没有第三条路，既不用等、又能改刚出站的块？**
   已知：`assistant/message` 不能当替换者（H2）；`user/message` 可以，但会留 user 在尾（H4）；补发 assistant 的窗口不存在（§三）。
   ⇒ 是否可以利用 `system/message`？`surface.js:13-18` 的 `SURFACE_EVENT_TYPES` 里有它，`assertSystemHeadRewrite`（`:331-340`）只保护 node 0。**非头部的 system/message 能不能当替换者？** 我们没测过。

7. **能不能接受"这轮不等，下轮再换"？**
   即：birth 模式点火，但**不在 finish 处收网**，而是等到下一次 `agent/pre-step`（那时提纯早就好了，0 等待），再用 checkpoint 那套 `user/message` 看板去遮蔽——**前提是那时那块已经滑出 `keepTail`**。
   ⇒ 这与"迟到认领"的区别在哪？如果目标块已滑出活跃尾部，H4 就不成立。**请判断这条路是不是 §三 里被我误杀的。**

### 4.3 未处理的其他发现

8. **哑弹**：`index.js:1365-1371` 发 `assistant/message` **带** `sourceEventSeqs` ⇒ 100% 命中 `surface.js:207` 抛错，被 `:1373 catch` 吞成 `replace-threw`。今天无害只因 `appendReplace` 没被调用。**谁打开开关谁撞墙。**

9. **部署漂移（已修，但要知道）**：pnpm 的 `file:` 依赖是**拷贝**，`pnpm-lock.yaml` 只记 `type: directory` **无内容哈希** ⇒ `pnpm install` 永不刷新已有副本。5 个包曾整体陈旧 3 天，期间所有"修复已上线"的判断都是**假阳性**。修法：删目录 + `pnpm install --ignore-scripts`；已加 `deploy/onboard.mjs [2b]` 漂移检测（exit 4）。

10. **看板列头有 3 种变体并存**，未统一。

---

## 五、我需要的

- 对 4.1 / 4.2 各条给**可行性裁决**（能 / 不能 / 有条件能），不能的请指出**被封死在哪一行**。
- 特别是 **4.2.6（非头部 system/message 当替换者）** 和 **4.2.7（birth 点火 + 下轮 checkpoint 收网）** —— 这两条我最不确定。
- 如果全都不可行，请给"**把 4.4s 的提纯做到 1s 以内**"的具体手段（这是唯一剩下的路）。

---

## 六、关键源码位置

| 位置 | 内容 |
|---|---|
| `dsh-cot-form-b/index.js:913/923` | `birthStart`：diskP + distillP 并行起火 |
| `dsh-cot-form-b/index.js:956-1017` | `birthFinish`：收网、判定、放行（`:979-993` 等待，`:1003` 铁律③，`:1006-1016` 判定） |
| `dsh-cot-form-b/index.js:1094-1110` | `finish` 处多块并行收网 |
| `dsh-cot-form-b/index.js:1289-1294, 1450-1461` | `awaitDistilled`（checkpoint 的宽限收网） |
| `dsh-cot-form-b/index.js:1528-1615` | `agent/pre-step`：checkpoint 发射 + birth 直接 return |
| `dsh-cot-form-b/index.js:1617-1627` | `agent/request`：唯一被允许的发射时机 |
| `dsh-cot-form-b/emitter.js:216-221` | 看板 `user/message` + replace |
| `dsh-cot-form-b/balanced-span.js:118-124, 167-169` | `keepTail` 现算 + "咬尾巴即放弃" |
| `dsh-session/lib/types/surface.js:13-18` | `SURFACE_EVENT_TYPES`（含 `system/message`） |
| `dsh-session/lib/types/surface.js:207-208` | assistant/message 禁带 sourceEventSeqs |
| `dsh-session/lib/types/surface.js:331-340` | `assertSystemHeadRewrite`（只保护 node 0） |
| `dsh-agent-loop/lib/index.js:894/951/1028/1143` | pre-step → step/start → user/message → agent/request |

---

## 九、本地探针实测（2026-09-21 07:30）：预热是**负优化**，已修

### 9.1 三个探针脚本（都在 `deploy/probe/`，可复跑）

| 脚本 | 回答什么 |
|---|---|
| `_probe-conn-reuse.mjs` | 连续 POST / HEAD 预热 / `stream:true` 的复用与阶段耗时 |
| `_probe-idle-reuse.mjs` | 空闲 5s/15s/30s 后连接还在不在池里 |
| `_probe-404-head.mjs` | 复刻生产序列，定位 `reused:false` 的真因 |
| `_probe-prewarm-fix.mjs` | 修复前后对照 |

### 9.2 结论

**① Agent 连接池本身完全正常。**
```
POST#1 reused=false connectMs=545 ttfbMs=2249
POST#2 reused=true  connectMs=1   ttfbMs=1396
POST#3 reused=true  connectMs=0   ttfbMs=1625
```
空闲 5s / 15s / 30s 后全部 `reused=true` ⇒ **"池子没接上"与"空闲被关"两个假设都被证伪。**

**② 真因：预热打的 URL 返回 404。**

> ⚠ 精确表述（勿写成通用规律）：**在当前客户端/服务端组合中，向 `/v1/` 发 HEAD 后未观察到连接复用；改向 origin 后，紧随其后的 POST 可复用连接。**
> 不写成"404 的 HEAD 不归还 socket" —— HTTP 404 本身不要求关闭连接，底层原因（服务端连接策略 / 客户端响应处理）**尚未定位**。路径选择影响复用这一点已足够支持修复。

| 预热目标 | 状态 | 紧随其后的蒸馏 POST |
|---|---|---|
| `https://host/`（origin） | 200 | `reused=true`，connectMs **1** ✅ |
| `https://host/v1/`（原实现） | **404** | `reused=false`，connectMs **503** ❌ |

原实现是 `String(base).replace(/\/+$/,'') + '/'`，而 `base` 形如 `https://host/v1` ⇒ 实际请求 `/v1/` ⇒ 404。
**⇒ 预热不但没捂热，反而在消耗连接**，让每次蒸馏都新建连接（生产实测 `connectMs:227, reused:false`）。
**"预热省 411ms"这条旧结论就此推翻。**

⚠ 但"亏了多少"**尚未量化** —— 必须保留三组对照，且**记录"预热启动 → 蒸馏完成"的总时间**，而不是只看 POST 的 `connectMs`（否则可能只是把等待搬到了前面）：
```text
不预热 / 旧路径预热 / 新路径预热
```

**③ 已修**：改打 origin（`prewarmTargetUrl()`，已导出、可单测），并加**自愈闸** —— 一旦实测到非 2xx，记 `prewarm-bad-status` 并**永久停用预热**（宁可退化成"什么都不做"，也不许它是负优化）。
回归测试 T19（5 项），**反证已做**：还原旧写法 ⇒ 当场挂 2 项。

### 9.3 顺带量到的两件大事

**① 一个只输出 16 token 的请求，`ttfb` 仍是 1396–2398ms。**

> ⚠ **撤回** §9.3 原写的"5.1–5.8s ≈ 1.5–2s 排队/prefill + 3.5–4s 生成"。那是**假设**，不是结论：16-token 请求自身也有生成与其他开销，输入与负载都不同，不能当固定截距直接相减。

**② `stream:true` 上游真的支持**（`chunks=3`，标准 SSE `data: {...}`）。
但**非流式**下 `firstByteMs − ttfbMs = 1ms` 且 `chunks = 1` ⇒ 服务端**攒完整个 JSON 才发响应头**。
⇒ **"排队 vs 生成"用现有探针分不开**；唯一出路是让蒸馏改走 `stream:true`（见 §十）。

### 9.4 生产新数据（重启后第一批，3 条）

| rawChars | promptChars | connectMs | ttfbMs | totalMs | 结果 |
|---|---|---|---|---|---|
| 865 | — | — | — | 6021 | **cancelled**（6000ms 取消实测生效） |
| 2995 | 3621 | 227 | 5768 | 5769 | ok, **683 字** |
| 1104 | 1730 | 190 | 5102 | 5103 | ok, 231 字 |

⚠️ **`finishWaitMs=6000` 与上游 5100–5768ms 只差 200–900ms 余量** ⇒ 成功率对抖动极度敏感。第一条就是这么死的。
⚠️ **683 字**超出目标 200–400 字约 1.7×（`chars` = `s.text.length` = 摘要正文，非 JSON）。

### 9.6 观测型流式迁移实测（2026-09-21 08:10）

**已实现** `requestStream()`（SSE 解析）+ `distillOnceStream()`，开关 `cfg.distillStream`，**默认 false**；profile 已设 true。
只改传输方式，提示词/模型/maxOutputTokens/finishWaitMs/timeoutMs **一律未动**。

**阶段分解（3529 字符输入，真实端点）**

| 阶段 | 实测 |
|---|---|
| 到首个摘要内容 | **2307ms** |
| 内容生成跨度 | **476ms** |
| 到完成 | 2841ms |

⇒ **生成只占 ~0.4s**，其余全在"第一个内容到达之前" —— 对应外部模型决策表的**情况 B**。

**⚠ 但 firstContent ≈ ttfb（1833 vs 1832、1687 vs 1687）** ⇒ 服务端是**有了内容才发响应头**，
故**流式并不能把"排队"与"prefill"拆开**。这一点已实测确认，不再当假设。

**A/B（固定输入，交错发）**：非流式 total p50 2947 / 流式 2312；且出现一次 **30208ms** 停摆 ⇒ 延迟分布长尾极重。

**解析边界回归（T20，离线本地 SSE 服务器）**：跨 chunk 多字节 UTF-8、心跳/注释、role-only/空 content、
`[DONE]`、连接断开不冒充完成、`finish=length` 拒绝 —— 全部钉住。
**反证已做**：把"按字节切行"换成"逐 chunk 解码" ⇒ 当场出现 `\uFFFD`，测试挂。

### 9.7 预热三组对照：**默认关闭**（推翻 §9.2 的修复结论）

判据是**【预热启动 → 蒸馏完成】的总时间**，不是 `connectMs`：

| 模式 | 总时间 p50 | 复用率 |
|---|---|---|
| **不预热** | **1827ms** | 0/3 |
| 旧路径（`/v1/`，404） | 2408ms | 0/3 |
| 新路径（origin，200） | 2082ms | **3/3** |

⇒ 新路径**确实修好了复用**，也**确实比旧路径好**，**但仍比"什么都不做"慢**：
HEAD 自身要 344–1002ms，省下的建连没被省回来（部分是"把等待搬到前面"）。
⇒ `DEFAULTS.prewarm` 改为 **false**；连接复用改由正常业务流量自然维持。
（`selftest.mjs` 里"默认 prewarm = true"的旧断言已按证据翻转。）

### 9.8 消息溯源（P0-3）已上线

`provenanceOf()` + `llm-stream` trace 新增 `runs`（连续同 role 游程，只报 n>1）、`tail`（末尾 8 条逐条
role/字符数/是否看板/人类 user 开头 48 字符）、`ledgerCount/userCount/assistantCount`。
**只观测，绝不删/改/合并任何消息**（T22 钉住）。重启后即可回答"那 4 条连续 user 到底是什么"。

### 9.9 溯源链已建成（P0-3）

**依据（读源码确认，非推测）**

`dsh-agent-loop/lib/index.js:1204` → `session.deriveMessages()`
→ `dsh-session/lib/index.js:1269` 遍历 **`surface.nodes`（元素就是 seq）**
→ 对每个 seq 调 `deriveEventMessage(log[seq])`，**投影为 null 的节点被丢弃**
（`dsh-session:209-215`：`user/message` **无条件**返回 `event.data`；
`assistant/message`/`system/message` 在 `content.length === 0` 时返回 null）。

⇒ 映射规则**确定性**：按 `surface.nodes` 顺序走，跳过投影为 null 的节点，
剩下的与出站 messages **一一对应**。**不需要用正文反查**（空串会匹配一大堆节点）。
⇒ 顺带解释一个结构性事实：**空 user 能进请求，空 assistant 进不去。**

**已实现**

| 导出 | 作用 |
|---|---|
| `mapMessagesToSeqs(session, count)` | 出站消息 → 源事件 seq；`{map, note}`，note 为 `aligned`/`count-mismatch`/`no-surface`/`error:` |
| `provenanceOf()` 扩展 | 新增 `contentType`/`blockCount`/`blockTypes`/`nonTextBlocks`/`hasToolCalls`/`toolCallId` |
| `makeTraceWriter()` | trace writer 抽成可导出工厂 ⇒ 端到端测试成为可能 |
| `settledTraceData()` | `birth-distill-settled` 记录体抽成纯函数 —— **这个对象就是白名单本身** |

`llm-stream` trace 现带 `tail` + `head8` + `seqMapNote`，每条含 `seq`/`role`/`chars`/
`contentType`/`blockTypes`/`nonTextBlocks`/`isLedger`/人类 user 的 `head` 48 字符。
**只观测，绝不删/改/合并。**

**已修正的过强表述**

> ~~尾部是"连续 user"~~
> ✅ 准确表述：尾部是**"没有被当前文本提取器提取出文本的 user"与 assistant 交替**；
> 真正的连续 user 游程在**开头（3–6）与中部（222–223、353–354）**。
> 且 `chars:0` **≠ 整条消息为空** —— 非文本块会被旧字段漏掉，故已补 `blockTypes`/`nonTextBlocks`。

**裁决留待真机数据**（按 A/B/C/D 四类，**先不删任何消息**）：
A 实含非文本内容 ⇒ 修观测字段；B 设计内的运行时节点 ⇒ 核查用途；
C 意外空壳 ⇒ **在制造空节点的那一层修**，不在末端过滤；D surface 有内容、出站变空 ⇒ 最高优先级。

### 9.10 性能线：只固定变量，不再加变量

固定 `prewarm:false` + `distillStream:true`，预算/模型/提示词**一律不动**。
⚠ 上一批 3/3 成功**不能**说明大块超时已解决 —— 三个样本 rawChars 688/593/1907，
**全部 < 5000 字符**，而历史超时集中在大块。

⚠ 术语更正：此前写的 `totalMs − ttfbMs` = 651–1201ms 应称
**"响应头到结束的时间"**，**不是**精确的模型生成耗时。修好的
`toFirstContentMs / contentSpanMs` 落盘后才有更准的分类；且即便那时，测到的也是
**客户端可见输出跨度**，不完全等同服务端计算时间。

### 9.11 新增回归（`selftest-birth.mjs` 104/0）

- **T20** 流式 SSE 边界：跨 chunk 多字节 UTF-8、心跳/注释、role-only/空 content、`[DONE]`、
  断连不冒充完成、`finish=length` 拒绝。**反证已做**（换逐 chunk 解码 ⇒ 出现 `\uFFFD`）。
- **T23 端到端 trace**：**真实 writer 写盘 → 从磁盘读回 → 解析断言**。只测 `meta` 有字段
  **挡不住**"字段没进白名单"——本文件刚栽过一次。另含 `trace:false ⇒ 不写任何文件`。
- **T24 seq 映射**：空内容 assistant 被跳过、空 user 被保留、顺序与 `surface.nodes` 一致、
  无 surface 时明确报 `no-surface` 而**不瞎猜**。
- **T25 内容块结构**：`chars:0` 但有 image 块必须被如实记录；null content 与空数组区分。

## 十、任务状态记忆（2026-09-21 架构升级）

**方向转变**：不再以「把思维链缩短」为目标，而是
**把已经发生的推理和执行，编译成下一轮能够准确接续的任务状态**。

保留的关系：**任务要什么 → 当前实际有什么 → 为什么这样判断 → 还缺什么 → 哪些条件改变后要重判**。

### 10.1 四层（新文件 `state-memory.js`，纯函数 + 纯数据，无 I/O）

| 层 | 导出 | 职责 |
|---|---|---|
| ① 来源与证据 | `buildEvidenceEnvelope` | 原 reasoning + 用户原话 + 工具结果 + 宿主状态；**固定编译时间截面** |
| ② 编译器 | `buildStateCompilePrompt` / `parseStateCompile` | 一次模型调用，产出六类语义对象 |
| ③ 记忆 | `createMemoryProjection` | 追加式修正 / 冲突保留 / 范围降级 |
| ④ 渲染 | `renderBirth` / `renderCheckpoint` | birth 局部接续记忆 ｜ checkpoint 整体看板 |

### 10.2 六栏（顺序固定）

`【目标与验收条件】【当前有效状态】【关键判断与依据】【约束与禁止】【已试路径】【未决差距】`

**中心是「未决差距」** —— 只写缺口，不替模型规定具体命令。

**birth 只渲染 状态/判断/缺口 三栏**，不在每个块里重复整份目标与硬约束。
**checkpoint 渲染全部六栏**，顺序：目标与约束 → 状态 → 判断依据 → 尝试 → 缺口。

### 10.3 时间截面（本架构最重要的一条硬规则）

当前 assistant 发出的工具调用，**不能**因为「即将执行」就被压成「已执行成功」：

> 合法：测试调用已提出，执行结果尚未返回。
> 非法：测试已完成。

实现上：`status: (t && t.result != null) ? 'result' : 'pending'` —— 没有显式 result 一律 pending。
这条系统性挡住「计划—执行—成功」混淆。

### 10.4 允许两种新增（与「纯摘要」的关键区别）

- **甲 表示性新增**：分类、归类、标注来源、合并重复、显式表达修正关系 —— 不新增事实判断。
- **乙 受限差距判断**：由【已有目标】+【已有状态】直接推出"验收条件尚未满足"。必须同时满足 6 条：
  ①用已有目标 ②用已有状态 ③不引入新环境假设 ④不新增具体行动 ⑤不伪装成已发生的历史
  ⑥与观察事实使用**不同标签**（写成"差距判断"，不写"已确认"）。

### 10.5 禁止的新增（原样写入提示词）

自行确定根本原因；自行宣称「永久不可行」「唯一解」；自行枚举「只剩下的解」；
生成材料中从未出现过的命令/路径/参数；编造多步计划再标注「当前第 N 步」；
把「没有完成记录」写成「确定没有完成」。

失败写成**条件化记录**，不永久封死；「用户禁止」与「技术上暂未成功」**不得混成一个状态**。

### 10.6 记忆有效性

- **追加式修正**：旧条目**仍在**，只标 `superseded` 并指向新条目（`correct()`）。
- **证据不足 ⇒ 保留冲突**（`conflict()`），不为了一张整洁状态表强行选一个。
- **依赖变化 ⇒ 降级而非判假**（`invalidateScope()`）：
  「旧观察仍成立，但对新配置的适用性未确认。」
- 三者**都必须在模型可见文本里露出来**（（存在冲突，未裁决）／（历史观察，适用性未确认）／（已被后续记录修正）），
  否则模型会把过时知识当当前事实。

### 10.7 不变的部分

- **仍是**一次宿主模型蒸馏调用**，不新增串行调用链；
- 提交仍走现有 birth/checkpoint 通路，**不改尾部替换协议**；
- 铁律不变：模型完整成功 AND CAS 成功 AND 输出可接受 AND 净省达标，否则原文放行；
- 文体不变：中文、第三人称、非祈使、路径/命令/数字逐字保留；
- 取消固定字数上限（原 200~400），改为「必要信息优先」。

### 10.8 开关与回滚

`DEFAULTS.stateMemory = false`（必须先显式打开）；profile 已设 `stateMemory: true`。
旧路径完全不变：`generateDistillation(cot, cfg, signal, promptOverride)` 的第四参数为空时
仍走 `buildDistillPrompt`。

### 10.9 新增回归

- `state-memory.selftest.mjs`：**43/0**（E 时间截面 / P 提示词 / R 解析容错 / M 记忆 / V 渲染）
- `selftest-birth.mjs` 新增 **T26**（证据→六栏→记忆→渲染端到端接入）、**T27**（失败安全），共 **126/0**

**反证已做**（关键机制逐一破坏，确认测试真会挂）：
① 把 pending 全改成 result ⇒ E1/E2/P2 立即挂；
② 把「追加式修正」改成 splice 删除 ⇒ M3 立即挂。

**并因此抓到一个空测试**：`P2` 原断言 `p.includes('调用已提出')` —— 提示词条款正文本身就含这几个字，
破坏后**仍然通过**。已改为断言工具行本身 `[run_tests] 调用已提出·**结果未返回**`，并补 P2b 反向断言。

### 10.10 封版（2026-09-21）：状态记忆 V1

**三条已真正统一的性质**（本轮最重要，不是测试数量）：

1. **索引与回退只改变获取速度，不再改变证据含义。**
   唯一出口 `normalizeEvidenceEvent()`；`T31` 断言两条路径产出逐字段相同的证据。
2. **来源权限由可信创建路径确定，不由文字自称确定。**
   `classifyUserEventSource()`：创建路径 > 结构化标头 > 未确认。
   创建路径已确认的人类输入**不会**因正文含 ledger 标头被误降级。
3. **历史变化区分「世界变了」与「原判断错了」。**
   `state-changed` / `correction` / `conflict` / `coexist` 四种关系分别处理。

#### 两条封版语义边界（维护时不得误解）

**边界一：ID 是关联提议，不是真实性证明。**
`problemId` / `objectId` 由编译器给出，**仍可能关联错误**。
ID 只帮助找到候选条目，**不能**单独授予合并、删除、覆盖或权限提升的资格；
范围、证据、关系三项检查**不因 ID 相同而被跳过**。
`ATTRIBUTION.explicit` 读作「**显式关联**」，不是「已被独立证实」。

**边界二：同一对象 ≠ 同一命题。**
`部署已经成功` 与 `此前部署失败与 ABI 不匹配有关` 可能**同时成立**
（一次是当前状态，一次是历史失败原因）。
`objectId` 作槽位入口合理，但它**只缩小比较范围**；槽位内仍区分
当前状态 / 历史事件 / 原因判断 / 用户约束（`PROPOSITION_KIND`）。
**同一槽位里可以有多个同时成立的条目，不必最后只剩一个「赢家」。**

#### 可以宣布 / 暂时不宣布

- ✅ 可以宣布：**状态记忆 V1 的架构、实现和现有回归检查已完成，部署文件一致，等待重启启用。**
- ⛔ 暂时不要宣布：已证明全面提高任务成功率，或已消除循环与过度自信。
  前者是已完成的工程事实；后者要由运行结果回答。

**后续修改应由具体成品缺陷驱动，而不是继续由架构想象驱动。**

#### 重启后看什么（只检查正常任务里产出的记忆）

1. 目标是否清楚：没有替用户扩大任务。
2. 状态是否准确：执行、成功、验收没有混成一件事。
3. 依据是否够用：不是只剩一个强硬结论。
4. 缺口是否具体：没有把「证据未收集到」写成「事情没发生」。
5. 旧判断是否正确退出：该修正的修正，该留历史的留历史，条件不同的并存。

优先看包含**工具失败、后续修复、用户修订要求**的自然任务。
不为此再造验证平台。

### 9.5 漂移检查器误报已修

`deploy/onboard.mjs` 的 `[2b]` 现在忽略开发件（`_*`、`*.bak*`）—— 否则每加一个探针脚本就对插件误报"仅源码 N"，把真漂移淹掉。


---

## 八、本地追加实测（2026-09-21 06:45）：按 BOOT 分段，抓到一次**上游劣化**

> 方法：把 `trace.log` 按 `[BOOT]` 切成 6 段（每次重启一段），逐段统计。
> 这修正了本文档第二节的一个错误——**那里的 293 条是把 6 个不同构建、不同上游状态的时代混在一起算的。**

### 8.1 分段结果

| BOOT（UTC） | index.js | fired | condensed | passthrough | distillFailed | **archiveErr** | raw p50 | **distill p50** | ≥7900ms |
|---|---|---|---|---|---|---|---|---|---|
| 09-19 02:58 | 94069 | 42 | 29 (69%) | 12 | 11 | 0 | 1216 | 4127 | 19% |
| 09-19 12:58 | 94069 | 109 | 52 (48%) | 57 | 2 | **52** | 1773 | 4147 | 1.8% |
| 09-20 06:26 | 94069 | 58 | 31 (53%) | 25 | 16 | 0 | 3533 | 4753 | 27.6% |
| 09-20 09:16 | 94069 | 28 | 18 (64%) | 10 | 7 | 0 | 4675 | 5487 | 21.4% |
| 09-20 14:00 | 94069 | 49 | 31 (63%) | 18 | 6 | 0 | 2032 | 4499 | 12.2% |
| **09-21 05:03** | **96530** | 70 | **16 (23%)** | 53 | **52** | 0 | 2722 | **8008** | **72.6%** |

**⇒ 那 52 次 `archive-failed` 全部来自 09-19 12:58 那一段，不是现在。** 本文档 2.3/4.1.1 里"本日志 52 次"的说法是**错的**（跨时代混算），在此更正。

### 8.2 判别：不是我们的构建，是上游

| 候选 | 证据 | 裁决 |
|---|---|---|
| 换了模型 | 6 段 `host-model` 全是 `deepseek-v4.1-flash` / `a6api` | ❌ |
| 换了端点 | 6 段 `distill-endpoint-target` 全是 `a6api → a6api`；`settings.yaml:8` `baseURL: https://a6.a6api.com/v1` 与新构建解析结果**同一主机**；`no endpoint` 错误 0 次 | ❌ |
| 换了配置 | 6 段 BOOT 的 config 字段**逐字节相同**（`timeoutMs:8000`、`disableThinking:true`、`maxOutputTokens:1200`、`finishWaitMs:6000`…），deps 指纹也全同（`emitter.js=16812@1789636983370` 等） | ❌ |
| 换了 prompt | `emitting` 串 6 段全同（含 `promptV2`） | ❌ |
| 输入变大 | seg6 raw p50=2722，比 seg3/seg4 都**小** | ❌ |
| **上游 a6api 变慢** | **`prewarm-ok` 的 `ttfbMs`（对同一主机的一次纯 HEAD，与 distill 代码路径完全无关）p50：533 / 329 / 359 / 347 / 407 → **783**；p90 867/766/745/1363/1037 → **1262**。约 2×，与 distill 4127→8008 同量级 | ✅ |

**唯一差异只有 `index.js` 94069 → 96530**（09-19 的公测加固：删掉硬编码的 `baseUrl:'https://a6.a6api.com'` / `credentialRef:'A6API_API_KEY'`，改为运行期从宿主 provider 表解析）。而解析结果与旧硬编码**同一主机**，所以这不是原因。

**⇒ 结论：提纯没有变慢，是 a6api 这家上游在 09-21 之后慢了一倍。**

### 8.3 更重要的：等待预算**已经在拐点上了**

seg6 的 distill 完成时间 CDF（n=80）：

| 阈值 | 完成数 | 占比 |
|---|---|---|
| ≤2000ms | 0 | 0% |
| ≤3000ms | 4 | 5.0% |
| ≤4000ms | 14 | 17.5% |
| ≤5000ms | 20 | 25.0% |
| **≤6000ms（= finishWaitMs）** | **23** | **28.8%** |
| ≤7000ms | 23 | 28.8% |
| ≤8000ms（= timeoutMs） | 25 | 31.2% |

- `finishWaitMs` 从 6000 提到 8000，只多命中 **2 块（+2.4pp）**，代价是让 71% 的块每次多等 2 秒。**这是明显亏的。**
- 71.2% 的块是**结构性无收益**：它们不是"差一点就完成"，而是被 `timeoutMs=8000` 掐死。

### 8.4 由此暴露一个**结构性错配**（本次最有价值的发现）

```
timeoutMs    = 8000   ← 提纯被杀的時刻
finishWaitMs = 6000   ← 我们放弃等待的時刻
```

**`timeoutMs > finishWaitMs` ⇒ 短路信号永远不可能在预算内触发。** 我们在 6000ms 放弃，提纯在 8000ms 才报错——**那 2000ms 的差值里没有任何信息**。后果：
1. 每块白白多等满 6000ms（seg6: 53/70 块）；
2. 上游那条请求还要多占 2000ms 的并发槽（纯粹的僵尸占用）；
3. 本次实现的短路（§九）在当前配置下**一次也不会触发**（诚实说明：E2/E3 只救 seg2 那类"归档终局失败"，对 seg6 收益为 0）。

**建议**：把 `timeoutMs` 压到 ≤ `finishWaitMs`（例如 `timeoutMs: 5500`）。收益：失败在预算内变成**终局**，短路立刻生效，每块最多省 ~500ms，且上游请求提前 2500ms 释放。这是一行配置。

### 8.5 对外部模型三条路线的实测回应

| 路线 | 实测回应 |
|---|---|
| **呈现与提交分离**（改宿主） | 本地已确认它确实对症：4.45s 卡的是 **commit + 下一步**，不是答案文本（`live.push` 实时喂 GUI）。但需要宿主新增 presentation/commit 双通道，插件侧做不到 |
| **大块预留产能 / 分档预算** | seg6 显示预算已在拐点（8.3），**分档给更长预算收益≈0**；真正的问题是 71% 的调用根本回不来。若上游就是慢，分档无用 |
| **历史 checkpoint 回收迟到结果** | seg6 的 80 次里只有 **2 次** 落在 6000–8000ms 之间（23→25）⇒ 可回收的迟到结果**约 2/80 = 2.5%**。在 seg6 的工况下这条路**收益极小**；它在 seg1-5（p50 4.1-5.5s）才有意义 |
| **快速路线 / 双速竞赛** | 未测。但 8.3 的 CDF 说明：**≤4000ms 完成的有 17.5%**，说明"快"是可能的；竞赛能否把这些变成常态，取决于上游排队还是生成——**仍需阶段分解**（首 token 时间我们目前只在 prewarm 的 HEAD 上量到，不是 completion 的 TTFB） |

### 8.6 数据缺陷（再次强调，已部分修复）

- ✅ 已修：跨时代混算。本文档第二/三节的 293 条应视为 6 段之和，**不得再当作单一总体引用**。
- ✅ 已补：`birth-passthrough` 现在带 `waitedMs` 与 `short` 字段（本次改动）。
- ❌ 仍缺：`distill` 请求自身的**首 token 时间**。现在只知道总时长，分不清"上游排队"与"生成本身慢"。**这是下一步最该补的探针。**

## 十一、重启后实测（2026-09-21 10:39 之后）：V1 的链路断在**编译**这一步

### 11.1 生效核对（不看比例，只看身份与配置）

| 项 | 实测 | 判定 |
|---|---|---|
| 运行构建 | `BOOT.selfId = 143622@1789983783423`，与 `index.js` 字节数 143622 精确相符 | ✅ 加载的就是源树构建 |
| 部署一致性 | 源树 ↔ `profiles/web/node_modules/@dsh-external/dsh-cot-form-b` 逐文件 sha256 相同 | ✅ |
| 开关 | `stateMemory:true`、`distillStream:true`、`mode:'birth'`、`schemaVersion:2`、`compilerVersion:'state-v1'`、`rendererVersion:'render-v1'` | ✅ 全部生效 |
| 回归 | `selftest` 225/0、`selftest-birth` 145/0、`state-memory` 173/0，其余 5 套全绿 | ✅ |

### 11.2 核心问题的答案：**没有**

> 问题：「正确版本的 V1，究竟有没有持续、完整地到达模型下一轮的输入？」

**答案：没有。到目前为止一次也没有。** 逐环证据：

```
① 证据信封 state-envelope       ✅ 每个请求都在建（userAsks/tools/runtimeFacts 都非零）
② 状态编译（distill）           ❌ 从未在预算内完成
③ 记忆归并 state-memory-merged  ❌ 全日志只触发过 2 次（都在 09-21 09:52 那一段）
④ 渲染 / 出站应用                ❌ 无产物可应用
```

断点定位在源码级是确定的：`index.js` 的归并事件只在
`s.task.distillState.ok && s.task.distillState.entries` 成立时才发射。
**所以「merge 只有 2 次」不是状态记忆没跑，而是编译失败的必然后果。**

硬数字：`birth-distill-settled` 共 492 条，`ok=true` 的 310 条**全部早于** `2026-09-21T10:05:39`；
此后 0 成功。`birth-condensed` 按 BOOT 段的变化：30 → 15 → 10 → 4 → 2 → 1 → **0 → 0**。

### 11.3 修正 §8.2：不是「慢一倍」，是**高度可变**

§8.2 的结论「a6api 慢了约 2×」需要修正。同一个探针、同一份输入、同一份配置，
在 ~30 分钟内量到：

| 时刻 | 同一探针 `_probe-stream-phases.mjs` | TTFB | 总时长 |
|---|---|---|---|
| 早先 | 3529 字符输入 | 2483ms | 2938ms |
| 中途 | 同上 | 10701ms | 22098ms |
| 稍后 | 同上 | 1695ms | 2134ms |
| 再稍后 | `_probe-thinking-ab` | 1701ms | 2273ms |

⇒ **上游时延在 2.1s ~ 22s 之间跳变**，不是稳定地慢了一倍。
`finishWaitMs: 6000` 只覆盖这条分布的快尾，所以命中率随上游抖动而整段塌掉。

同时**证伪**了「思考没关掉」这个候选：`disableThinking:true` 时 `reasoningChars=0`，
`false` 时 `reasoningChars=1525` —— 关思考的字段**确实生效**。

### 11.4 52 次归档冲突：确认是历史

按 BOOT 分段统计 `birth-archive-error`（`another live writer owns this store root`）：
**52 次全部落在 `09-19 12:58` 那一段，当前段 0 次。** 与 §8.1 的结论一致，不阻塞当前使用。

### 11.5 本轮唯一代码改动：统一响应入口（流式／非流式错配）

事故证据（历史，非当前）：非流式请求收到 SSE 体，trace 里 4 次
`bad json: data: {"id":"...","object":"chat.completion.chunk",...`。
旧写法在 `distillOnce` 里对整段响应直接 `JSON.parse` ⇒ 必然失败。

改法（按外部审计建议，**不加重试**）：

```
HTTP 响应
   ↓  detectResponseProtocol()   结构证据优先（有 data: 行 ⇒ sse），Content-Type 只作旁证
   ├─ sse  → assembleSseFrames() → collectSseFrames()
   └─ json → extractFromJsonBody()
   ↓  统一的 { out, finish, reasoningChars }
```

- 新增 4 个导出：`detectResponseProtocol` / `assembleSseFrames` / `collectSseFrames` / `extractFromJsonBody`。
- 两个方向都覆盖：非流式收到 SSE、流式收到整段 JSON；两者都写 `meta.protocolMismatch`。
- **半成品绝不冒充成功** 的铁律不变：错配解析后若正文为空，照样抛 `empty distillate`。
- `requestStream` 只在 Content-Type 不是 `event-stream` 时才留原文副本（上限 4MB），
  且仅当**一个 SSE 事件都没解出来**才交出原文 —— 流式路径不做无谓复制。

**回归可证伪**（不是空跑）：把两处分支各自改回旧行为后，
`selftest.mjs` 的 `【18】` 立刻以历史原样的错误失败 ——
非流式那条复现出 `bad json: data: {...}`，流式那条复现出空摘要。恢复后 225/0。

### 11.6 仍未动的一处（按令：本轮不加预算）

§8.4 的结构性错配**依然成立且依然没改**：

```
timeoutMs    = 8000   ← 提纯被杀的時刻
finishWaitMs = 6000   ← 我们放弃等待的時刻
```

本轮按指示「不加预算」，故 `timeoutMs` / `finishWaitMs` 一个字节没动。
但要说清楚：**在当前上游抖动下，这两行就是 V1 无法跑通的直接原因** ——
不是记忆格式问题，不是模型问题，也不是解析问题。

### 11.7 数据缺陷（本轮新增）

- ❌ `promptChars` 只在**请求成功**时才落 trace（`birth-distill-settled` 的成功形状）。
  失败/取消的那条形状没有它 ⇒ **恰恰在最需要看输入体积的时候看不见**。建议后续补齐。
- ✅ `stats.seen` 经复核是**陈旧字段**：成功与失败的 `birth-fired`/`birth-condensed` 一律为 0，
  对「有没有推理块」零信息量。此前用它推「推理块缺失」的判断**作废**。
- ✅ 推理块确实存在且被完整捕获：宿主下一条请求的 `reasoningChars` 里能看到
  1107 / 5481 / 688 / 1726 —— 与 `birth-fired.rawChars` 逐一对应。

### 11.8 ★ 阻断的精确机理已量到：状态编译提示词把预算吃光了

§11.6 只说「上游抖动 + 6s 预算」，这一节把它钉成**可测的因果**。

**① 状态编译提示词是旧蒸馏提示词的 2.2～3.2 倍**（同输入对照，纯本地零网络）：

| cotChars | 旧 buildDistillPrompt | 新 buildStateCompilePrompt | 倍数 |
|---|---|---|---|
| 600 | 1226 | 3931 | **3.21x** |
| 937 | 1563 | 4690 | **3.00x** |
| 2000 | 2626 | 7019 | **2.67x** |
| 4327 | 4953 | 12089 | **2.44x** |
| 5481 | 6107 | 13243 | **2.17x** |

原因不是 cot 本身，而是**证据信封**：完整 reasoning + 全部工具证据（每条 args≤400 / result≤1200）+ 用户原话。
小块的倍数最高（信封有固定底噪），大块被 cot 摊薄。

**② TTFB 随提示词体量增长**（真实请求实测）：

| cotChars | 提示词 | ttfb | 总时长 | 6000ms 预算内 |
|---|---|---|---|---|
| 937 | 4690 | 3062 | 6060 | ❌ |
| 2000 | 7019 | 3099 | 5440 | ✅ |
| 4327 | 12089 | 4094 | 6612 | ❌ |

**③ 生产 trace 完全对得上**（10:05 唯一一次跑通的那条链）：

```
10:05:00.220 [state-envelope]        cotChars=937 tools=1
10:05:00.220 [birth-fired]           rawChars=937
10:05:05.006 [birth-distill-settled] ok=true chars=743 promptChars=5258 ttfb=2348 total=4777 finish=stop
10:05:05.007 [birth-condensed]       rawChars=937 outChars=743 netSaved=194 minSaved=50
10:05:05.008 [state-memory-merged]   blocks=[0]
```

**小块（937）→ 提示词 5258 → ttfb 2348 → 4777ms 完成 → 归并成功。**
对照同窗口失败那条：`cotChars=4327 → ttfb=5777ms` —— TTFB 一项就吃掉了 96% 的预算。

⇒ **结论：V1 不是没跑，是它自己的提示词升级把 6000ms 预算吃穿了。**
预算当初是按旧提示词「实测 3.3~5.0s」定的，新提示词把真工期推到 5.4~7.3s，于是只剩小块能过。
这解释了 birth-condensed 为何恰好从 stateMemory:true 那一段起塌到 0。

### 11.9 本轮第二个改动：失败路径的请求指纹（补 §11.7 的数据缺口）

promptChars 此前只在**成功**的 settled 里落盘 —— 恰恰在最需要看输入体积时看不见，
导致无法区分「TTFB 吃光预算」与「生成本身太慢」这两类完全不同的失败。

改法：requestStream 抛错时把请求指纹挂到 e.meta 再原样抛出，**不改任何行为**；
并把 stage / protocolMismatch 加进 settledTraceData 白名单。

回归【19】4 条，已证伪（关掉该分支后 4 条全失败）。合计 selftest.mjs **229/0**。

### 11.10 留给下一个决定（我没有动）

按令未加预算。但数据已经把选择收敛成三条，**不再是猜测**：

| 选项 | 依据 | 代价 |
|---|---|---|
| 提 finishWaitMs 6000 → ~7500 | 实测 p90 落在 7.3s | 每块最多多等 1.5s（用户既有偏好：「宁愿久一点」） |
| 瘦身证据信封（工具证据条数/长度） | 提示词 2.2~3.2x 的主因是工具证据 | 触及「记忆格式」，本轮明令不动 |
| 不动 | 小块仍能偶尔过（当前 ~0%） | V1 事实上不生效 |

倾向第一条：它是**唯一不改变记忆语义、且被实测直接支持**的选项。但按令留着拍板。

