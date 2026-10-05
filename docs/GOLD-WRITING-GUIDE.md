# 金标撰写指引（标准流程与要求）

> 谁该读：任何要给 `transfer/gold/` 添条目、或要把一条轨迹的推理压成"金标稿"的人/模型。
> 这份文档不是形式规范——形式规范在 `tools/silver-shape.mjs` 和闸链里。这里写的是**为什么**、
> **按什么顺序做**、以及**已经踩过的坑长什么样**。每条坑都带真机编号与原话，可核对。
> 现成范例：`transfer/gold/*/**.json`（8 条在册）；本轮正反例对照见
> `transfer/gold-repair/drafts-proposed/`（`…-r7.retry-2026-10-05c.md` 是唯一赢过真机的那份写法）。

---

## 0A. 上限线：金标不得低于产品自己（v14.22.0，硬闸）

这条线是**测出来的**，不是审美。起因：侧模型自评比金标好。同 raw 上把产线自己的本地稿（`src/offline-birth.js` 的 `birthOffline`，读数 = `splicedChars` / `g2Ok`）和金标稿对撞（`node tools/gold-vs-line.mjs`，$0，约 10 ms/条，落 `.cfb-offline/ruler/gold-vs-line.json`）：

| 项 | raw | 产线稿 | 标尺侧 8 条 |
|---|---|---|---|
| 过 G2 | 0/8 | **8/8** | 2/8 |
| 过 G1 | 0/8 | **7/8** | 2/8 |
| 压缩比 | 1.000 | **0.612** | 0.670（最差 0.97） |

⇒ 尺子比产品松，所以「模型追上金标」是假指标。`ceiling-6.json` 早就写着「champion 不能是 hand 臂」——我们把探针当上限用了。

**六条硬判据**（`goldCeiling` in `tools/helpers/three-mode.mjs`；`gold add` / `gold audit` 都跑；不达标 ⇒ 降 `use:'train'`，**不删数据**）：

| 条 | 口径 | 为什么 |
|---|---|---|
| C1 压缩力度 | `stored/raw ≤ 0.60`（或净省 ≥40%） | 短 raw 的绝对字数地板只有 50 字（`src/birth.js:553`），曾放过硬标 `stored 51 / ratio 0.97` |
| C2 闭合判读三元组 | 稿里要有「读数 ⇒ 结论」或「如果…就…」（口径唯一化在 `hand-draft.mjs` 的 `hasClosedRead`） | 产线 `compileV4Direct` 硬要求它；标尺侧 8/8 缺 |
| C3 可执行验收 | 验收段要写「跑哪条命令、看到什么读数即算完」 | 本项目自己的结论：改完不验证 = 伪修好（ledger 臂 16.7% 假完） |
| C4 提前量 | `roundsToFix ≤ 6` 且 `≤ rawRoundsToFix` | 贴着 9 轮上限的赢法测不出「停止取证」这一维 |
| C5 结果 | `vsRaw=win`，或 `tie ∧ roundsToFix ≤ raw` | 没比 raw 快的稿不当尺子 |
| C6 不劣于产线 | `stored ≤` 同 raw 产线稿 `splicedChars`；产线过 G2 时金标必须也过 | 尺子不得比产品松。**缺 `gold-vs-line.json` 读数 = 不合格（fail-closed）** |
| 附加 装置话术 | 原 `auditMode1Draft` 照跑（`inventedSpans` 等） | 防编造锚点 |

**三条后果（已经生效）：** ① `export-train` 把 `use:'ruler'` 剔出 SFT（此前 3 条标尺原文被直抄成答案）；② `train-v5-micro` 自检只读标尺侧，标尺为空 ⇒ `no-ruler-for-eval` 拒绝对"自己训过的数据"打满分；③ `plan-bench` 标尺为空 ⇒ `no-gold:dev` 拒跑。

**`--legacy-floor`** 只给"只验管路、不追内容上限"的历史夹具（`test/closed-loop-v4` 的 A26/A41b 就是这么标的）；新写的金标不许用它蒙混。

**重挣（要 API，一次一个假设）：** 读 transcript 全文 → 按 §1–§8 修稿 → `ceiling --traj <dir>` → `gold add --plan N`（自动跑本节）→ `train-v5-micro --eval-only` 确认尺子变硬 → 侧模型重测。

## 0. 三条不可动摇的口径

1. **金标只认真机。** 判据是 `traj-run` 跑出的 `outcome`：`hand.fixed && (!raw.fixed || hand.rounds < raw.rounds)`。
   离线六道闸全绿**不是**金标证据，红也**不是**否决（它只看形状）。按工具描述写出来的东西一律叫**银标**（`use:'train'`，喂训练）。
2. **金标是尺子，不是数量。** 入库后它会被 `bench` 当标准答案打分，写歪一条会污染一批评测结论。
   所以：宁可这一格 0 条，也不要 3 条歪的。**禁止为了"覆盖数好看"去挑容易的格子。**
3. **不许从"我干不成"推出"这格干不成"。** 原话教训：我曾把 `perf-regression` 判成"压缩稿撬不动的格子"
   （t91/t93/t94 连败三次之后），真机只花 $0.05（t95）就把这句话证伪了。判格子不可为之前，
   必须能说出**它缺的那一步是什么**，说不出就是没说清，不是做不到。

---

### 0A.1 两条从真机学到的结构规矩（v14.22.1）

1. **两臂同败的格子不挣金标**。若 raw 臂在本通道 8 轮内修不好、手稿臂也修不好 ⇒ `vsRaw` 无从产生，条目再干净也只是「稿写着好看」。判据：先跑 `plan-traj --arms raw,hand --dry` 前，查该家族最近的 raw 修好率；两臂同败 ⇒ 记 `测不出信号` 并换格子（t97 的 `flaky-timeout-s0-r3` 就是这样，见 CHANGELOG v14.22.1）。
2. **要落在 r2–r4 的早轮分歧**。C6 比的是拼接后的 `stored` = 生产「已走过的路」延续段 + 你的稿；r6/r7 光台账就 1.6k 字 ⇒ 晚轮结构性过不了线（`perf-regression-s0-r7`：前缀 ≈1628 + 产线线 1692 ⇒ 稿只剩 64 字预算）。早轮既省延续段，又与 C4 `roundsToFix ≤ 6` 一致。
3. **落点要写死到文件**：只给 `old_text` 片段防不住它改错文件——t97 里主模型读了稿却去改 `src/distill.js` 与 `test/helpers.mjs`。要显式写出目标文件的那一行、并说明「同名的其他文件不是目标」（陈述事实，不是禁令）。

## 1. 标准流程（顺序即纪律，跳步就是拿钱换猜测）

### 第 1 步 · 读真机 transcript —— **不动一个字之前先读它**

```bash
node -e '
const fs=require("fs");
const rows=fs.readFileSync(".cfb-runtime/traj/<计划>/results.jsonl","utf8").trim().split("\n").map(JSON.parse);
for(const r of rows){ console.log("== ",r.variant,"fixed",!!r.fixed,"@",r.fixedAtRound,"edits",(r.edits||[]).length);
  for(const s of r.transcript||[]) console.log(` r${s.round} raw ${String(s.reasoning||"").length}字`,
    (s.calls||[]).map(c=>c.name).join(","));}
const h=rows.find(x=>x.variant==="hand");
console.log(String(h.transcript.find(x=>x.round===<目标轮>).reasoning));'   // 全文读，别读摘要
```

读的时候只找四样东西，**逐字抄下原句**（后面写稿要用）：

| 要找的 | 为什么 | 反例（真实） |
|---|---|---|
| ① 结论定没定 | 定了的话，稿子就不该再补归因，补了是重复 | t96 r8：`So the fix: revert compressTargetMax to 450` 反复出现 ⇒ 结论早就完了 |
| ② 卡住它的**那一句** | 这就是病根本体，稿子只治它 | t96 r8 自己写 `the tool reads historical trace data, not config`，下一句却是 `Let me test by changing config and re-running… that's a good experiment` ⇒ 它在**等一个不存在的确认** |
| ③ 它起了哪些头（`Let me… / I should… / might work?`） | 压缩会删掉这些念头；删掉≠消失，下一轮它会重新起一遍 | 我的 r8 稿一个 `git` 没写，而 raw 里有 `Let me check if there are git history` ⇒ r9 重新起念、r10 真发 `git show v11.9:src/config.js`，edit 一直没发 |
| ④ 台账里哪些路已定案 | 写进稿子当"已排除"，防止复活；也防止把已走过的路写成下一步 | `cat /usr/local/bin/analyze-trace` 已回显「No such file or directory」⇒ 稿里可引用，但不能再让它跑一遍 |

**不读这个就开始改稿，就是瞎改。** 我前几轮犯的正是这个：每轮凭猜测改一句、跑一次真机，$0.301 才换来一句"分不出"。

### 第 2 步 · 把病根写成一句话

格式：**「raw 第 N 轮原话『…』 ⇒ 它缺的是 X，而 X 可以用一个可完成的动作 Y 补上」**。
写不出"动作 Y"就说明还没读懂，回第 1 步。

> 范例（本轮）：raw r8 已推出"读数不随 config 变"，却还想"改完跑 analyze-trace 验证" ⇒ 它缺的不是分析，
> 是**把验收换成可完成的那个**：同轮 `cat src/config.js` 看到 `compressTargetMax: 450,` 即收工。

### 第 3 步 · 写稿（六段形状）

| 段 | 要求 |
|---|---|
| 定性句 | 说清本轮状态：结论已定 / 只欠哪个动作 |
| 因果链 | 观测 → 结论，每个数字都能在**本轮** raw∪ctx 里指认 |
| 已排除 | ≥1 条，**必须带理由**（"光写已排除：X" 是空洞模板） |
| 落点句 | 用规范句型写改法：`把 \`X: 1800,\` 改为 \`X: 450,\``（三元组形式）；**"改成/换成"这类同义写法判据不认**，会被 L3 挡 |
| 下一步 | 一个动作、就在本轮内、可完成；**不许给它派新活** |
| 未解 | 必须带**完成判据**（"…即收工 / 确认…落地 / 未解原样写进结论"）；**禁令不算收敛**（"不阻断本轮、不要再回到取证"蒙过旧判据、真机照样不动手） |

另有硬约束（违反就是废稿）：锚点不许跨轮引用（invented-anchors）；不许写实验元语（轮数上限、预算、沙断言、
"主模型/prompt"这类元称）；不许写 fixture 的判定谓词或模型不可能知道的环境事实；台账里走过的路不许写成下一步；
`netSaved = raw − stored ≥ 50`；**不要抄老金标的句子，只抄它的方法**——写之前先回答"老金标这句为什么这么写，我这么改是真好还是假好"。

### 第 4 步 · $0 复验（必须全绿才允许花钱）

```bash
node tools/silver-shape.mjs <稿> --id <task>-s<样本>-r<轮> --plan <计划>   # L1–L8 形状
node tools/hand-preflight.mjs <计划>                                       # 六道闸 + 自比 dd
node test/silver-shape.selftest.mjs                                        # 改判据必跑
```

- 判据抓不住一切：**L8 只是提示项**（分不清"新意图"与"已定案"，硬判会挡死所有稿或漏判），
  它列出的每一个"没处置的起念"你要**逐条自己判定**：要么写进已排除，要么就是下一步动作。
- 离线"齐"≠有用。形状检查器只配当银标质检。
- 早期批次（t15）就是这么干的：对着**闸违规**和真机失败动作迭代到干净，只掏钱跑一次。

### 第 5 步 · 把这条轨迹**所有会过地板的轮次**的稿都预置好

`armFloor` 默认 3100 字，凡某轮原始思考 ≥3100 就会要稿。只预置一轮 ⇒ 下一轮直接不压
（t94：`r8 思考 7567 字 · 稿 ✗`）。预置太多轮也有代价（t96：多收的那份 r8 稿就是唯一变量）。
所以：**先数一下还剩几轮过地板，再决定每轮要不要稿、写什么**；多轮稿要彼此一致，别在第二轮引入新悬念。

### 第 6 步 · 真机单元（一次只验一个假设）

```bash
node tools/cfb-cycle.mjs plan-traj --n 9X --arms raw,hand --scenarios <格子> \
  --reuse-raw .cfb-runtime/traj/t15/results.jsonl --samples 1 --max-rounds 9 --stop --cap-usd 0.30
cp <稿> .cfb-runtime/traj/t9X/drafts/<task>-s0-r<轮>.md
node tools/cfb-cycle.mjs traj-run --plan .cfb-runtime/traj/t9X/plan.json   # 计划里已含通道预检
```

- `--max-rounds` 要比"预计动手轮"多留 **≥2 轮**：t95 的赢发生在第 9 轮＝当次上限，改完没机会验收（`修好后验收 0%`）。
- 换 key/换通道先跑 `node tools/probe-carry.mjs`（$0）；剥掉入站 `reasoning_content` 的通道上，两臂输入逐字节相同，跑完零信息。
- 手写稿不花压缩钱，raw 臂可复用历史轨迹 ⇒ 单组一般 $0.05–0.13。**别用它代替第 4 步。**

### 第 7 步 · 判定与登记（反证一起登记）

```bash
node tools/cfb-cycle.mjs ceiling --plan 9X          # 过闸且修好才够格
node tools/cfb-cycle.mjs gold add --plan 9X          # 写进 transfer/gold/
node tools/coverage-plan.mjs                         # 重生覆盖率矩阵
```

条目里必须同时写：`replay`（每个支持/反对它的单元、逐单元 `win/tie/loss`）与 `knownWeakness`
（例：修好发生在轮数上限、修完未验收、n=2 未过阈 `e=3.75 < 10`）。**赢一次不是已确证**——把它写在条目旁边，
下一个人才不会当结论用。

### 第 8 步 · 稳不稳由复现次数决定

同一份稿重复 **3–5 次**（每次 ≈$0.05–0.08）才谈得上"这把尺子稳"。n=1 的赢只能写进 `replay`，不能写进结论。

---

## 2. 归因做到位的三问（写完稿自检）

1. 它当时**到底缺什么**？（能引 raw 原句，不是我的推测）
2. 我补的那一下，能被那句原话**证明对症**吗？
3. 只改这一处，它的下一步行为会**怎么变**？——第 3 问答不上来 = 没归因，改的是措辞。

对照：我给 r7 写的稿答上了（"别再找不存在的验收 ⇒ 同轮 cat 即收工"，t95 立刻动了手）；
我给 r8 写的稿没答上第 3 问（我以为删掉犹豫就能收工，实际删掉的是它已起的 `git` 念头）⇒ t96 未复现。

---

## 3. 常见死法（每条都在本项目真机里死过一次）

| 死法 | 症状 | 修法 |
|---|---|---|
| 跨轮搬句子 | 把别的轮的原句当本轮证据引用 | 锚点只查**本轮** `raw ∪ ctx`；`hand-preflight` 会报 `这些锚点原文/上下文里没有` |
| 用禁令冒充收工 | "不再取证/不许回滚"，模型仍不动 | 未解句必须带**完成判据**（L5） |
| 给主模型派活 | "下一轮就查…/再核一遍/分两种" | 每条轨迹只压被挑中那一轮，派活＝劝它别改文件 |
| 删掉已起念的头 | 稿子短了，模型下一轮重新起同样的念 | L8 列出的每一条都要给处置（排除／并入动作／写进结论） |
| 落点句写成同义词 | `改成`／`换成` 判据不认 | 规范三元组：`把 \`X: 1800,\` 改为 \`X: 450,\`` |
| 空洞排除 | "已排除：X" 无理由 | 一句理由 + 一个可指认的数字 |
| 复活台账 | 把走过的路写成下一步 | 台账里 `ok` 的调用不许重跑（`deadEndResurrected`） |
| 只预置一轮稿 | 下一轮 `稿 ✗` 不压 | 见第 1 步 ⑤：先数过地板的轮次 |
| 拿形状齐当结论 | 报告里写"已解决" | 只有真机 outcome 能当结论；形状齐=够格当银标 |
| 失败后换格子 | 覆盖数涨了，坑还在 | 坑的定义是"没有稿子负责的那一段行为"，正面写进稿子（本轮的防回滚条款就是这么来的） |

---

## 4. 提交前的最小检查清单

```
[ ] 读过目标轮 transcript 全文（不是摘要），病根句已逐字引用
[ ] 六段形状齐；L1–L6 全绿；L8 列出的起念每条给了处置
[ ] hand-preflight 该计划全绿（含自比 dd），netSaved ≥ 50
[ ] 改过判据 ⇒ test/silver-shape.selftest.mjs 全绿（含"该挡的挡、该放的放"两头用例）
[ ] 过地板轮次的稿都已预置，且各轮稿件彼此一致
[ ] 真机单元：max-rounds 比动手轮多 ≥2；ceiling 出 win/tie/loss
[ ] 条目含 replay + knownWeakness；覆盖率矩阵已重生（node tools/coverage-plan.mjs）
[ ] npm run verify:offline 与 npm run manifest:check 双绿；凭据文件未入库
[ ] 数据不删：失败稿留作银标并在 README/CHANGELOG 记明它死于哪一条
```

**不做的事**：不改模板、不双作者、不做通道适配特化、不手改 `transfer/models/v5-micro-weights.json`、
不用 `--no-gate` 绕闸、不 `git add -A` 裹进 `.cfb-runtime` 之外不该进的东西、不为了让闸绿而改闸值。
