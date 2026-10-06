# `liaocr/cfb` 全面扫描报告

扫描时间：2026-10-06 · 仓库 HEAD：`0b52072` · 255 commits（2026-09-22 → 10-06，14 天）· 604 个受版本控制文件 · 49 MB

---

## 一、这个项目在干嘛（一句话 + 展开）

**一句话**：它是一个装在 agent 宿主里的 **思维链（reasoning 块）压缩插件** —— 在主模型每段 CoT **刚生成、还没进会话历史之前**，把原文归档进 CAS，然后用一个"编译器"把长思考替换成短稿；替换前有确定性闸门，任何不达标就**原样放行原文**（无损回退）。仓库的另外 70% 是围绕它建的**训练 + 评测闭环**（金标库、双轨裁判、基准记分卡、所谓"微模型"训练流水线）。

### 三层结构（实测确认）

| 层 | 位置 | 规模 | 实质 |
|---|---|---|---|
| 生产插件 | `src/` 23 个模块 | 7,520 行 | 流式拦截 + 归档 + 压缩 + 闸门 |
| 训练/评测 CLI | `tools/` 40 个脚本 + 15 helpers | 17,468 行 | 三模式闭环、金标锻造、裁判、基准 |
| 自测 | `test/` 39 套 `.selftest.mjs` | 9,834 行 | 零依赖纯函数 + mock ctx |

核心链路（`src/plugin.js` → `src/birth.js`）：
1. `llm/stream` 钩子拦截 `reasoning` 块，按动态门槛 `effectiveBirthMinChars`（缺省 3100 字，自适应地板会按轮次在 1200–4200 之间调）决定是否起火。
2. 并行：原文 `store.putText()` 写 CAS 拿 `art://` 句柄 ‖ 压缩器出短稿。
3. `birthAccept()` 收网核真 → 通过才替换。

**闸门实测只有 4 条在 `birthAccept`**（`src/birth.js:556-576`）：`empty-candidate` / `invented-identifier` / `no-token-gain` / `no-gain`。README 宣传的"6 道确定性程序门"里，**结构闭合**与**死路不复活**实际在上游 `compile-v4.js`（`I1–I8` 不变量，`src/compile-v4.js:214-263`），不在收网闸 —— 口径是跨两阶段合并计数的，不是单一闸门。

### 关键事实：开箱即用时它什么都不改

实测 `DEFAULTS`：`mode: 'birth'`、**`dryRun: true`**、**`compressLocalModel: false`**。`plugin.js` 里 `if (cfg.dryRun) { trace('birth-dry-run-stream'); return inner }` —— 默认只写观测 trace，**不重写任何东西**。要生效必须显式 `dryRun:false`。

---

## 二、跑得好的部分（我实测通过的）

| 检查 | 结果 |
|---|---|
| `node manifest.mjs --check` | 文件 568 个；**漂移/新增 0；缺失 0** |
| `npm run verify:offline`（项目自己的验收口径） | **39/39 套件通过，1195 通过 / 0 失败 / 1 跳过**，34.6s |
| 第三方依赖 | `package.json` 零 `dependencies`，只有 peerDep —— **宣称成立** |
| 密钥泄漏扫描 | 无真实密钥（只有 `test/training-ready.selftest.mjs:48` 一个假 canary）；个人路径是合成的 `/home/u/` |

工程纪律有真实含量，不是摆设：
- **断网证明是 fail-closed 的**：`assertOfflineNamespace()` 只认 `/proc/net/route`，非 Linux 或拿不到证据就抛错，**绝不把"拿不到证据"当"验证通过"**。
- **BOOT 自证**：`SELF_ID`/`DEP_ID` 记录模块首次求值时磁盘上的 `size@mtime`，用来证明"网关里跑的是哪一版文件"（源于两次真实生产崩溃的复盘）。
- **宿主隔离纪律**：观测异常一律吞、主流异常必须原样抛；`llm/stream` 注册带 `{ prepend: true }`。
- `eval-ready` 那 43 项测的是预算账本/加密 checkpoint/密钥不回显/超大响应按字节拦等 —— 是货真价实的对抗性测试。

---

## 三、问题清单（每条都带复现证据）

### P0-1 · "本地微模型"的成分与文件内自评严重不符

`transfer/models/v5-micro-weights.json` 自称：

```
architecture.name        = "CFB-Micro-65M"
architecture.totalParameters = 60,854,837
architecture.backbone    = "8-layer Alternating Local/Global RoPE Bidirectional Transformer
                            + 19-dim Symbolic GELU Fusion + GLiNER Span Pointer"
architecture.onnxPath    = transfer/models/cfb-micro-neural.onnx  (onnxSizeKB: 7.6)
```

实测：

| 事实 | 读数 |
|---|---|
| 该文件里**真实可学习参数** | **1,045 个数字**（19 维 valueWeights + 6 槽位×19 + 12 prefWeights + 32×19 GELU MLP head） |
| 60,854,837 参数需要的体积 | **232 MB (fp32) / 58 MB (int8)** |
| `cfb-micro-neural.onnx` 实际字节 | **7,760 B** —— 装不下，物理上不可能 |
| `src/` 生产代码对 ONNX 的引用 | **0 处**（`grep -rn "onnx" src/*.js` 无结果）⇒ 生产从不加载那个网络 |
| 权重文件 `schema` | `cfb.v5-micro-weights/**2-neural-65m**` |
| 当前训练器 `tools/kaggle-train-micro.py:1211` 写出的 | `cfb.v5-micro-weights/**3-distilled-pretrained**`，名字 `CFB-Micro-**97M**-Multilingual` |

⇒ 生产运行时是一个 **19 手工特征 + 单隐层(32) 的线性/浅层打分器 + 次模贪心选取**，不是 Transformer。`architecture` 块是**未被任何代码校验的装饰性元数据**，且与训练器输出 schema 脱钩（说明这个入库文件是手改/过期的，不是当前流水线产物）。`docs/README.md` 里"`<0.1B` 预训练双向编码器"的叙述对已入库产物不成立。

### P0-2 · 所谓"编译"对 5 种情况是**硬编码模板**，且触发词就是本仓库自己的标识符 ⇒ 金标分数不能当泛化证据

`src/compile-v5-local.js:540-550` 的原型判定：

```js
isTimingHedge  = has('hedgeAfterMs') && (has('primaryDelayMs') || has('hedgedDistill'))
isConfigDiff   = has('compressTargetMax') && has('maxOutputTokens') && has('config.js')
isSseTruncated = has('assembleSseFrames') && has('transport.js') && (has('DONE') || ...)
isEnvEacces    = has('EACCES') && has('DSH_HOME') && has('CFB_REAL_DSH_HOME')
isParamForward = has('host-follow.js') && has('observe') && (has('lastModel') || ...)
```

命中后 `:928-932` 分派到 5 个 `compile*()` 模板，模板正文写死了**本仓库历史排障的具体数字**（`got 1712`、`outputChars 390`、`contentSpanMs 280`、`compressTargetMax: 450`，`grep -cE "transport\.js|distill\.js|selftest|hedgeAfterMs|compressTargetMax"` → **41 处**）。

**而这些触发词正是金标题目的内容**：

```
assembleSseFrames    -> 出现在 5 个 transfer/gold/sse-truncated/* 文件
host-follow.js       -> 4 个 wrong-model 文件
CFB_REAL_DSH_HOME    -> 3 个 eacces-config 文件
compressTargetMax    -> perf-regression 文件
```

金标 4 个家族（`sse-truncated` / `eacces-config` / `wrong-model` / `perf-regression`）**每一个都有一个专为它写的模板，且模板触发关键词就在题面里**。⇒ README §5 的"11/11 满分、泛化差 0.000"在方法学上读作模板查表命中，不能读作"微模型追上金标"。项目自己在 `docs/GOLD-EXPANSION-PROGRAM.md:27` 写过这条原则（"同一批数据既当选项又当答案，就是泄漏"），但没有把"模板键 = 题目家族"这一条纳进去。

对照实验（同一台机器，`compileV5Local`）：

| 输入 | 命中原型 | 结果 |
|---|---|---|
| 我写的 SSE 排障 CoT（474 字） | `stream-frame-settlement` | **压缩比 1.22（膨胀 22%）**，正文是模板硬编码，且标识符被 scrub 打碎：`return { , : \|\| ( ? '' : null) }`、`~/./` —— **输入里根本没有这些内容** |
| 我写的账单导出 CoT（658 字，VAT/S3/财务对账） | `general-discourse-graph` | 压缩比 0.71，可读，但**机制是把原句逐字搬进【看清】/【改法】槽位**（抽取式选句），不是蒸馏 |

### P1-3 · 项目自己的工具已量出这个短板，但 README 没写

`node tools/gold-vs-line.mjs` 我跑通了，产物落 `.cfb-offline/ruler/gold-vs-line.json`：

```
sse-truncated_decoy-s0-r4       产线 1978 字 / raw 1518 ⇒ 线长比 1.303 · G1✗(no-gain)
wrong-model_decoy-s0-r4         产线 1344 字 / raw 1436 ⇒ 线长比 0.9359 · G1✓
（其余正常题）                    线长比 0.29 – 0.52 · G1✓
```

⇒ **遇到 decoy（真实根因换了个方向的陷阱题），本地路径会把文本撑大 30%，被产线闸门判 `no-gain` 拒掉。** 好消息：闸门按设计兜住了，退化成原文放行、没有污染；坏消息：宣传的压缩在这些格子里**静默地什么都没做**。

### P1-4 · "五大国际官方基准"是**在自有 6–8 条轨迹上重算官方口径的指标**，不是跑官方基准；且宣称的领先不显著

`npm run bench` 实测输出（我原样复现）：

```
| 评测臂  | 样本 n | SWE严苛解决 | pass@1 | 平均轮数     | Arena Elo (95% CI)  |
| raw     |   8    |   87.5%     | 0.889  | 5.63 (0%)    | 1000 [1000,1000]    |
| auto    |   7    |   85.7%     | 0.889  | 4.86 (-13.7%)| 1110 [ 926, 1345]   |
| ledger  |   6    |   83.3%     | 0.833  | 5.33 (-5.3%) |  951 [ 675, 1160]   |
```

- 数据来源：`transfer/traj1`(3 文件) `traj2`(2) `traj3`(2) —— 自采轨迹，**n = 6~8**。没有跑 SWE-bench / TAU-bench / LiveBench 的任何数据集。
- `arenaElo`（`tools/helpers/ruler.mjs:255`）= 自己配对局结果做 **Bradley-Terry MLE**，锚 `raw=1000`。这是**内部 Elo**，与 LMArena 榜单不可比。
- **`auto` 的 CI [926, 1345] 包含 1000 ⇒ 相对 raw  baseline 无显著优势**；README 却写成"LMArena Elo 1114（较 raw 净胜 +114 分）"当既成结论。`ledger` 同理。
- 三臂 **n 各不相同（8/7/6）**，不是同一集合上的配对比较。

### P1-5 · README 的数字与仓库现状不一致

| README 宣称 | 实测 |
|---|---|
| 当前版本 **v14.20.0**（2026-10-04） | `CHANGELOG.md` 顶部 **v14.25.0（2026-10-06）**；`package.json` version 恒为 **`0.1.0`**（从没升过 ⇒ 装了也不知道是哪版） |
| 自测 **31/31 套件**、**916 pass** | **39 套件 / 1195 pass** |
| 金标 **11/11 满分 1.000** | `npm run bench`：冠军 `p-1490eefcdf` 现在 **12/13，dd = 0.724**；且 8 行里 **4 行标 `[预估]`**（$0 静态预筛，不是真机稿），只有榜首 1 行 `[实测]` |
| `transfer/gold/` 活跃 **8 项 / 4 家族** | 实为 **13 条 JSON**（sse 5 · eacces 3 · wrong-model 4 · perf 1），与 `gold-vs-line` 输出"本轮算 13 条"一致 |
| 单次编译 **9.38 ms** | 本机实测随长度线性放大：88 字 0.62ms · 880 字 3.6ms · 2,464 字 **12.4ms** · 5,280 字 **41.5ms** · 6,524 字 51ms。生产门槛 `birthMinChars: 3100` ⇒ **真实工作区间约 15–45 ms，是宣称值的 2–4 倍** |

### P1-6 · `npm test`（README 列为"快速自检"）在普通 Linux 上会 FAIL，而验收口径 `verify:offline` 全绿

- 直接 `node verify.mjs`：`FAIL test/eval-ready.selftest.mjs`，报 `Error: offline-namespace-required`（`tools/verify-offline.mjs:21`）。
- 根因是**跳过判据太粗**：`test/eval-ready.selftest.mjs:269` 用 `offlineNamespaceVerifiable()` 决定是否跑，而它只判"是 Linux 且存在 `/proc/net/route`" —— 任何联网 Linux 机都返回 true，于是它去跑那条需要"命名空间内只有 lo、零外部路由"的断言，当场抛错。
- 修法：把 `assertOfflineNamespace` 的判据（`interfaces.every(name === 'lo') && routes.length === 0`）也用于跳过决策，或给测试加"不在隔离内 ⇒ 显式跳过并打点"。
- 我在本沙箱实测：`npm test` = 38/39；`npm run verify:offline` = **39/39**（沙箱允许 `unshare -Urn`）。所以 CI（`ubuntu-22.04` + `npm run verify:offline`）是绿的，但 README 让人先跑的 `npm test` 会吓到人。

### P2-7 · 公开不可复现：宿主契约不在公共 npm 上

- `@deepseek-ai/cordis@4.0.4` **在 npm 上存在**，但它是"Meta-Framework for Modern JavaScript Applications"（`src/` 只有 context / events / fiber / logger / reflect / registry / service / utils）。
- 我在它的源码里搜 `llm/stream`、`pre-step`、`cmbStore`、`putText`：**全部 0 命中** ⇒ 插件 `ctx.on('llm/stream')` 与 `ctx.get("cmbStore")` 依赖的是**下游宿主应用**（`cordis.patch.yml` 注释点名的 `dsh-app-boot`、`cordis-plugin-include`）。
- 而 `npm view dsh-app-boot` / `cordis-plugin-include` / `@dsh-external/dsh-cot-form-b` **全部 E404**。
- ⇒ 外部人**无法端到端跑起这个插件**；39 套自测通过的是纯函数 + mock ctx，不构成宿主集成验证。

### P2-8 · 迁移脆弱性（HANDOFF 自己承认，但值得进 README 顶部）

`docs/HANDOFF-2026-10-06.md` §6 明示：`.git/config` 被当敏感路径排除 ⇒ 沙箱重启丢 remote；**gold 的 13 条 pending 与锻造好的 16 条稿子在 `.cfb-offline/**` 被 ignore 的运行态里 ⇒ 换环境即丢**（好在 `gold-forge2` 是 $0 确定性可重跑）。

### P2-9 · 体量与可读性

`docs/theory/CFB-THEORY-COMPLETE.md` 单文件 **253 KB**、`CHANGELOG.md` **288 KB**、`index.d.ts` **42,784 B**、`MANIFEST.sha256` 60 KB。文档密度极高且与代码互指（引用逐条对源码校正过，这点很难得），但对新人不友好；`transfer/` 根目录散着 59 个 `direct-*.json` 与 23 个 `effect-*` 一次性回执目录。另：`src/` 实为 **23 个模块**（README 写 22 个）。

---

## 四、我对它的整体判断

**真实成就**：一个把"CoT 出生时压缩"做成**可无损回退的工程闸门**的插件，防御性设计水平明显高于一般 agent 项目（fail-closed 断网证明、模块 size@mtime 自证、逐字标识符召回闸、加密 checkpoint 与预算账本）。零依赖 + SHA256 清单 + 39 套自测 1195 项全绿，可审计性是硬实力。

**核心缺口**：**"学习"这一环基本是空的。** 生产的本地路径 = 1,045 参数的浅层打分器 + **5 个针对本仓库自身故障史写的硬编码模板**；它的高分来自"模板家族 == 金标家族"的循环。真正在长 CoT 上做出短稿的是 `compile-v4.js` 的**确定性规则编译**（I1–I8 不变量、逐字锚点核验）—— 那是规则系统，不是模型。README/文档目前把这套规则系统包装成"认知编译微模型 + 65M/97M 编码器"，并在 n=6~8、CI 跨基线的样本上写"净胜 +114 分"。

**优先级建议**
1. 把 `architecture.totalParameters/backbone` 这类**无代码校验的自评字段删掉或改成实测派生**（最省事的止血：让 `validateV5MicroWeights` 拒收 `totalParameters` 与真实 JSON 数值不符的权重文件）。
2. `dryRun`/默认配置下 README 应写"开箱只观测不改写"。
3. 评测集与模板**做家族隔离**：留一个 5 个原型关键词都不出现的真·外部家族，测 `general-discourse-graph` 抽取路径的客观收益 —— 这才是泛化读数。
4. 修 `eval-ready` 的跳过判据（P1-6，小改动，让 `npm test` 在联网机上也绿或干净跳过）。
5. README 数字改为脚本生成（`docs/TRAINING-AND-BENCHMARK.md` §6.2bis 已经是这个套路了，把它推广到 §5 与版本号即可）。
6. 基准表补一行显著性：CI 跨锚点就标"不可判"，别写净胜。

---

## 附：本次扫描实际执行过的命令

```bash
git clone --depth 50 https://github.com/liaocr/cfb.git && git fetch --unshallow
node manifest.mjs --check                     # 568 文件，漂移 0，缺失 0
node verify.mjs                               # 38/39 通过，1 失败（eval-ready）
npm run verify:offline                        # 39/39 通过，1195 pass / 0 fail / 1 skip，34.6s
npm run bench                                 # 复现记分卡（n=8/7/6，Elo CI 跨 1000）
node tools/gold-vs-line.mjs                   # 13 条，decoy 线长比 1.303 / 0.9359
node -e '…'                                   # 权重参数计数 → 1,045；ONNX 7,760 B
grep -rn "onnx" src/*.js                      # 0 命中
node /tmp/e2e3.mjs                            # 同域 vs 异域对照：1.22 膨胀 vs 0.71 抽取
npm view @deepseek-ai/cordis dsh-app-boot …   # cordis 4.0.4 存在；宿主应用 E404
```
