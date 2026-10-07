# 金标水平 = 一个可复算的判据（GOLD-STANDARD v1）

`GOLD_STANDARD_VERSION = cfb.gold-standard/1` · 权威定义在代码里：`tools/helpers/gold-standard.mjs`
本文只解释口径与实证；**判据以代码为准**，二者不一致时以代码为真、本文算 bug。

一句话：**「达到标准」与「金标水平」是同一个命题的两面——12 个轴全部实测通过即金标，金标必须 12 个轴全部实测通过。**
每一条轴都满足三个条件，否则不许进标准：

1. **可复算**：任何人跑一行命令能得到同一个数字（命令写在下面每张表的最后一列）；
2. **不另立口径**：阈值判断复用生产实现（`goldCeiling` / `handDraftGate` / `auditMode1Gold` / `episodeOutcome`），尺子只做测量，不做第二套裁判；
3. **fail-closed**：缺数据 ⇒ 记 `未测`，`未测` 不是通过（这条是本轮被反复咬之后定死的）。

---

## 1. 判定式

```
gold            ⟺  M1 ∧ M2 ∧ M3 ∧ M4 ∧ M5 ∧ M6 ∧ M7 ∧ M8 ∧ E1 ∧ E2 ∧ R1 ∧ R2 全部实测通过 ∧ drift = ∅
provisional-gold⟺  没有任何已测轴失败，但至少有一轴未测或 drift ≠ ∅
not-gold        ⟺  任一已测轴为假（包括 R2 样本数 n<2）
```

- `gap = Σ gapᵢ`（每条未过轴的距离之和，0 = 刚好达阈）⇒ 用来**排序/选稿**：先补 gap 小的。
- `margin = 已测轴余量的均值 ∈ [0,1]` ⇒ 用来给模式 2 **分难度**：margin 高 = 副模型照着做也稳；margin 低 = 贴着阈值，别当教材。
- `status` 由 `tools/gold-score.mjs` 输出，人话读数与 `why` 同源；不要用「我觉得这条挺好」替代它。
- **未测 ≠ 通过，也未测 ≠ 不合格**：已测轴全过、但至少一条需要凭据的轴还没测到 ⇒ `provisional-gold`（稿侧达标、凭据待补）；任一已测轴为假 ⇒ `not-gold`。`R2 n<2` 是已知样本数未达到 ≥2 的阈值，因此是 `not-gold`，不是 provisional。
- 结论要落进条目才算下游可见：`node tools/gold-attest.mjs` 把 `{version,status,gap,margin,drift,home,stampDigest}` 写进 `goldStandard` 键（**只加元数据，绝不碰 `draft`** ⇒ `digest` 不变）。见 §3.5。

```bash
node tools/gold-score.mjs                        # 两条池批量：逐项轴 + 轴通过率汇总
node tools/gold-score.mjs --id <id> --draft f.md # 花真机钱之前先预判（E1/E2 会是「未测」）
node tools/gold-score.mjs --pending <f.json> --draft f.md   # 拿当轮 pending 直接量
node tools/gold-score.mjs --json > /tmp/gold.json          # 机器可读
```

---

## 2. 12 个轴（阈值 · 语义 · 复算）

| 轴 | 量 | 通过条件 | 为什么是这个数 | 复算 |
|---|---|---|---|---|
| **M1** 压缩力度 | `draft / min(注册raw, 台账raw)` | ≤ **0.60** | §0A C1。分母取**较短**那份：副本被 padding 撑长时不许冒充「压得狠」；两份长度不符另记漂移 | `gold-score --id <id>` |
| **M2** 不比同格产线长 | `draft / 同 raw 产线稿 splicedChars` | ≤ **1.00**；缺线读数 ⇒ 未测（`pass=null`，注册闸那边仍按不过处理） | C6；手改稿不该比机器稿啰嗦 | `.cfb-offline/ruler/gold-vs-line.json` |
| **M3** 闭合判读 | `hasClosedRead(draft)` | 真 | 没有「改完看什么算好」的稿，副模型只能猜 | `node -e` 见 `AXES[].how` |
| **M4** 可执行验收 | 窗内含逐字命令 **且** ≥2 个读数分支 | 真 | C3 的两分支：变绿 ⇒ 是这处；仍不绿 ⇒ 还有别处 | `ACCEPT_CMD_RE` |
| **M5** 接地精度 | `1 − (无据标识符 + 伪引)/需核项` | = **1.000**（无需核项也算过） | 与生产 `invented-identifier` 同口径：token 级核，不要求整段逐字。**证据基 = 起草人当时看得见的那份**：`raw ∪ ctx ∪ 台账 raw ∪ pending.prompt ∪ 该格 transcript ∪ 当轮 calls ∪ 程序段`；「…」引用可截断（`…` 分段核、保序） | `anchorsOf(d) − anchorsOf(ev)` |
| **M6** 装置话术 | `auditMode1Gold(draft).status` | `clean` | 稿里写「沙箱拦住了/本轮预算用完」＝把工具的失败当结论教给副模型 | `gold-ceiling-audit` |
| **M7** 决策不变 | `handDraftGate(raw, draft, ctx).ok` | 真 | 压的是废话，不是判断；G2 直接复用生产闸 | `hand-draft.mjs:143` |
| **M8** 落点唯一 | 改法句数（`「…」`内引用免检） | **恰 1 条**，且无「或/任选」菜单、无裸引思考流 | 金标是尺子，尺子不能给两条路 | `FIX_INTENT_RE` |
| **E1** 真机效率（复算） | `results.jsonl` 同格 hand 行的 `fixedAtRound`（经 `episodeOutcome`） | ≤ **6** 且该行判「修好」 | 同格 raw 一般 7–8 轮；≤6 = 确实省了轮数。**自报数字不作数** | `episodeOutcome(row)` |
| **E2** 不输 raw | `vsRaw` | `win`，或 `tie ∧ rtf ≤ rawRtf` | C5 | `outcome.vsRaw` |
| **R1** 溯源闭合 | 五件齐 ∧ drift=∅ | 全真 | 见下节——这一轴是本轮新增的，因为它才是「可测量」的地基 | `locateCell(id)` |
| **R2** 可复现样本 | 同 task+sample 的**独立趟**数（该趟须真消费过稿：`hand-samples.jsonl` 有行；`-resume` 续跑算同一趟） | ≥ **2** | 实测两课：① 同格同稿 t98 修好@6、t99 0 edit/8 轮 ⇒ 单趟必然骗人；② t103 三格被 `upstream-no-reasoning` 停机保护掐掉，`results.jsonl` 里照样留了 hand 行——**空跑不是第二次证据**（当时一条 not-gold 差点自己翻成 gold） | `countSamples()` |

**M6 只管 `draft`**；当天 `stored` 里的话术计入审计但**不可由改稿消除**（它已经是真机记录，不许篡改）。本轮 5 条被它挡住的格子就永久停在隔离区，这是记录不是缺陷。

---

## 3. R1：五件 + 三条漂移判据（「可测量」的真正含义）

注册条目是人写的，真机凭据不是。所以 R1 要求**逐字回放**：

| 件 | 判据 | 数据来源 |
|---|---|---|
| 台账行 | `hand-samples.jsonl`（`cfb.hand-sample/2`）里有 `id` 精确匹配的一行 | `.cfb-runtime/traj/*/hand-samples.jsonl` |
| 逐字对齐 | 行内 `raw` 与注册表 `raw` 互相包含；行内 `draft` 与注册表 `draft` **trim 后全等** | 同上 |
| 草稿落盘 | `draftFile`（或任一趟 `drafts/`、`drafts.preplaced/` 下的 `<id>.md`）存在 ⇒ 可 diff | 轨迹树 |
| 结局行 | 同 home + 同 `task` + 同 `sample`、`variant=hand`、`fixedAtRound ≥ 采样轮` 的最早一行存在 | `results.jsonl` |
| 闸留痕 | 台账 `gate.ok` 非假 且该趟 `receipt.json` 在（`plan.json` 一并看） | 轨迹树 |

`drift`（非空 ⇒ 最多 `provisional-gold`）：

- `draft≠台账所发` —— **改过稿就失去了原来的分数**（见 §5 定律一）；
- `raw 是两份文本` —— 注册表和台账存的不是同一份原文 ⇒ 比什么都不可信；
- `outcome 自报 X 轮 / 真机 Y 轮` —— 以真机为准，自报作废；
- `无真机结局行可回放 ⇒ rtf 只是自报`；
- `按全文重算 ratio > 0.60` —— 拿截断 raw 凑出来的压缩率不算。

---

## 3.5 盖章（`gold-attest`）：结论要能被下游读到，且只能降级

尺子读数只在命令行的话，工具链就只能继续读 `use` 字段和注册当时的 `ceiling.ok` —— 那两个都会随改稿过期。所以：

| 谓词（`tools/helpers/three-mode.mjs`） | 含义 | 谁在用 |
|---|---|---|
| `goldRulerOk` | 能当**判分标尺**（须盖章 `gold`） | `traj-corpus.rulerIdSet` · `cfb-judge` · `coverage-plan` · `bench-run` 的 `gold-use-mismatch` |
| `goldBenchOk` | 能当**模式 2 比对靶**（`gold`/`provisional-gold`） | `buildBenchPlan` · `train-v5-micro` 的 `--eval-only` 自检 |
| `goldTrainOk` | 能进拟合（`use=train/both` **或**被判 `not-gold`） | `build-micro-dataset` · `build-change-dataset` · `train-v5-micro` 的 devGold |

三条性质，都由 `test/gold-attest.selftest.mjs` 钉住：
1. **只降级不升级**：`use:'ruler'` 抬不回一张 `not-gold` 的章（防"改个字段就当标尺"）；
2. **章会过期**：`stampDigest` 钉的是盖章当时那份稿；稿一改 digest 变 ⇒ `--check` 立刻红 ⇒ 必须真机重测再重盖章，分数不许跟着稿子飘；标准升版同样判过期；
3. **未盖章沿用旧口径**：新工具不许一夜之间把标尺池清空。
`test/gold-attest.selftest.mjs` 第 7 节是活体检查：真注册表里若有"改过稿没重盖章"的条目，全量验证就会红。

---

## 4. 每条轴的 `why` 都带数字，不写形容词

```
$ node tools/gold-score.mjs --id perf-regression-s0-r7
M4 可执行验收：value=1 ✗  gap=1  ⇒ 窗内只有 1 个分支，缺「仍不绿 ⇒ 还有别处」
M5 接地精度：value=0.9474 ✗ ⇒ 未接地 2 处：`compressTargetMax: 450`、`edit_file`  ← 编的
E1 真机效率：value=9 ✗ ⇒ 真机行 9 轮（注册表自报 9 已弃用）· 阈 6
R2 可复现样本：value=1 ⇒ n=1 ⇒ 已测不达阈值，not-gold，不得当尺子用
```

---

## 5. 从 24 条实测里量出来的共性（每条都带判别力）

数据与算法：`node tools/gold-study.mjs` → `.cfb-offline/ruler/gold-standard-study.md`（分组过率）、`.json`（逐条原始读数）。
下表每行 = 按该特征分组后「12 轴全过率」，n 是条数，不是我的感觉。

| 写法 | 判别力 | 该怎么写 |
|---|---|---|
| **不许改完稿不改跑** | 原稿组 **36%**(11) vs 改过稿组 **0%**(13) | 定律一：**改稿即失分**。稿子一改，E1/E2/R1 立刻不成立 ⇒ 改进只能当「候选稿」，要转正必须重跑那一格（≈$0.07） |
| **能钉回真机台账** | 可回放 **50%**(8) vs 回放不起 **0%**(16) | 定律二：**没有台账的稿不是金标**，只是散文 |
| **逐字引用要有，但要「1 处」** | 反引号 ≤1 处 **57%**(7) vs ≥4 处 **0%**(16)；有「…」引用 **44%**(9) vs 无 **0%**(15) | 钉 1 处最要命的原文（代码行/命令输出），其余转述。引用是锚，不是摘抄 |
| **只给一条改法** | 恰好 1 条 **50%**(8) vs 0 条 **0%**(5) vs ≥2 条 **0%**(11) | 「这条线只有一处：落点是 `X`，改成 `Y`」；不许写「或者也可以」 |
| **声明「只有一处」≠ 真的只有一处** | 写了声明 **0%**(10) vs 没写 **29%**(14) | 反直觉读数：老式报告体爱说「我判断只有一处」但仍列多条 ⇒ **标准只数行，不数话**。想靠加声明句过轴是走不通的 |
| **验收必须两分支** | 窗内 ≥2 个 `⇒` 分支 **25%**(16) vs 0 分支 **0%**(8) | 「若变绿 ⇒ 就是这处；若仍不绿 ⇒ 还有别处，先别说修好」 |
| **别把装置话术写进稿** | 无沙箱/权限词 **25%**(16) vs 有 **0%**(8)；无「禁止再调用」类 **19%**(21) vs 有 **0%**(3) | 环境限制不是结论。删掉那一行，稿子还更短 |
| **短** | ≤500 字 **43%**(7) · 501–1000 **13%**(8) · >1000 **0%**(9) | 长度不是目标，是结果的影子：上面几条都做到，稿子自然掉到 400–900 字 |
| **raw 存全文** | 全文 **19%**(21) vs 截断 **0%**(3) | 注册时截断 raw 会让接地判定冤枉好稿、让压缩率虚高；尺子已改成按全文取严 |

**为什么「≥2 分支」只有 25%**：剩下挡住的是 E1/R1——那是真机与凭据的事，不在稿子手上。这也正是本轮改稿改到 12/13 之后仍然卡住的 5 条的原因：**再改稿子不会让分数长回来**。

---

## 6. 当前水位（`node tools/gold-score.mjs --dedup` + `node tools/gold-study.mjs` 实测，19 个唯一 id）

```
gold 4 · provisional-gold 0 · not-gold 15
轴通过率：M1 19/19 · M2 19/19 · M3 13/19 · M4 11/19 · M5 16/19 · M6 13/19 · M7 19/19
          M8 7/19 · E1 7/19 · E2 18/19 · R1 8/19 · R2 14/19
缺项分布（gold-study 实测）：M8×12 · E1×12 · R1×11 · M4×8 · M3×6 · M6×6 · R2×5 · M5×3 · E2×1
计数口径：gold-score --dedup 按唯一 id ⇒ 19 条（gold 4 · not-gold 15）；gold-attest 按文件 ⇒ 23 条（在册 13 + 隔离区 10，gold 4 · not-gold 19）
可当标尺：sse-truncated-s0-r4(dev) · sse-truncated-s1-r3(dev) · wrong-model-s0-r6(holdout) · wrong-model-s1-r5(holdout)
```

盖章后的下游后果（全部实测，不是推算）：

| 面 | 变化 | 说明 |
|---|---|---|
| 标尺侧 `goldRulerOk` | 在册 **17 → 4** | 13 条里只有 4 条能当判分标尺；其余 9 条降级为训练料，**一条没删** |
| 训练侧 `goldTrainOk` | **6 → 19** | 降级的条目全部落到训练侧（降级 ≠ 作废） |
| `plan-bench --dry` | dev **2** 条 / `--split all` **4** 条 ≈ $0.03 | 模式 2 基准没被抽空（`goldBenchOk` 允许 provisional），但靶子现在只剩达标的稿 |
| `train-v5-micro --eval-only` | 自检 **7 → 4** 项，`g2PassCount 4/4`，四项 `dec=null` | 微模型仍一条闭合判读都没复现 ⇒ 训练余量结论不变，且现在比的是真标尺而非"注册过的稿" |

- 唯一一条 `M1` 不过：隔离区里的 `wrong-model_decoy-s0-r4` 旧副本（它的 `raw` 本身被截断到 594 字）——记录保留，不删数据。
- 4 条在册条目**台账里根本没有 id**（`eacces-config_decoy-s0-r3`、`perf-regression-s0-r6`、`sse-truncated-s0-r5`、`sse-truncated_decoy-s0-r3`）⇒ 不可当尺子用，只能作 `use:'train'` 素材，转正唯一办法是重跑。
- 与 §0A 的关系：`goldCeiling`（C1–C6）仍是**注册闸**；GOLD-STANDARD 是**评价尺**；`gold-score` 每次跑都做单向一致性对照（尺子乐观而闸不收 ⇒ exit 1），当前 **0 处不一致**。

---

### 6.1 转正的通道现状与「战役」一条命令

- 预检三次实测：① `preflight-failed:notClaude`；② `fp=null`、思考 47 字/正文 1 字；③ `fp=vllm-…（无放行依据）`、思考 103 字/正文 147 字、携带 `request-timeout`。
- 据 ③ 起过真机趟 `t103`（`--only eacces-config,wrong-model,sse-truncated --perturb decoy`）：三行 results 全是 `upstream-no-reasoning：可信指纹但思维链为空已连续 3 次 ⇒ 停`，rounds 0/4/3，**没产生 pending ⇒ 零新样本**。这一趟反而教会我收紧 R2（见上表）。
- 从此不再盲跑：`node tools/gold-campaign.mjs`（战役编排器）先做 N 次预检、合格率 ≥2/3 才起轨迹；然后自动投放「已知最好的那一版稿」（`tools/gold-place-drafts.mjs`：同 id 逐字，否则同家族同样本里章上 gap 最小；都没有就不放）→ 续跑 → 收尾 `gold-vs-line → gold-attest → gold-score --dedup`。
  `node tools/gold-campaign.mjs --dry` 零请求，只打印计划与花费估算（默认 3 家族 × decoy ≈ $0.21，按 t101 实测 $1.40/20 条折算）。

---

## 7. 使用约束（写给模式 2，也写给未来的我）

1. **金标是尺子，不是饲料。** 只有 `gold` 状态可当难度/成功判据（ruler）；`provisional-gold` 可按 `goldBenchOk` 作为模式 2 的比对靶，但不得当达标判据；是否进训练由 `use` 决定，不自动等于训练素材。
2. 任何「我把它改好了」的说法，必须附 `gold-score` 的轴表 + 真机趟名；没有趟名 = 没改。
3. 阈值只能改代码 + 改本文 + 加自测一起改（`test/gold-standard.selftest.mjs`：每轴一个通过 fixture、一个失败 fixture，含缺线 fail-closed 与 `n=1 ⇒ not-gold`）。改一处不改测试，视为未改。
4. 标准升版 ⇒ `GOLD_STANDARD_VERSION` 递增，历史条目按旧版判定的结论同时作废，重测后才算数（`gold-attest --check` 会把过期章抓出来）。
5. 真机重跑到线之后，顺序固定：`gold-campaign` → `gold-vs-line` → `gold-attest`（重盖章）→ `gold-score --dedup` 复核 ⇒ 少一步就会出现"分数是旧稿挣的"那种假账。
6. `R2` 只数**真消费过稿**的趟：`results.jsonl` 里有 hand 行但台账没有对应样本 = 空跑，一条都不算。
