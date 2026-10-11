# 提议稿（drafts-proposed）

这里是**还没挣到金标**的手写稿：每份都必须先过 `node tools/hand-preflight.mjs <plan>` 的六项离线闸链
（G2 决策不变 ∧ draft 越界 lint ∧ `compileV4Direct` ∧ `birthAccept` ∧ stored lint ∧ 与自身逐字比对 dd）。
**离线全绿 ≠ 金标** —— `outcome`（主模型读这份稿能否真修好）只能由模式 1 真机轨迹决定。

## 定位（先看清这是什么）

- 这里每一份都是**提议稿**：离线闸链全绿只说明它**够格进银标训练池**（喂副模型学写法），不说明它是金标。
- 形状自查（$0）：`node tools/silver-shape.mjs <draft.md> --id <id> --plan <plan>`，看 L1 因果链 / L2 排除带理由 / L3 落点与原文一致 / L4 对未到手材料的处置 / L5 未解（L6 定罪词、L7 长度只作提示）。
- **金标的唯一评判标准是真机模式 1**：`node tools/cfb-cycle.mjs traj-run` 让主模型读这份稿，看它能否走到修好（`outcome`）；不到就改稿重跑，几版里择优才 `saveGold`。老金标是这么磨出来的，不是照工具写出来的。
- **老金标也会错**（下面 2026-10-05 那格就是实例）。看它只学一件事：那处**为什么**那样改；照它的句子写，产出的是银标。

命名：`<id>.md` = 该单元该轮的稿；带 `.retry-<date>.md` 后缀的是同一 id 的**重写版**（不覆盖旧记录，旧稿留在 git 历史里）。

## 2026-10-05 三份（全部预检全绿）

| 稿 | raw→稿→stored | 状态 | 处置判断 |
|---|---|---|---|
| `flaky-timeout-s0-r4.retry-2026-10-05.md` | 5096→1431→2306 | 六项全绿，自比 dd 0.989→修锚点后绿 | **值得真机续跑**：flaky-timeout 家族当前 0 条金标，此稿是新增条目，不与现役冲突 |
| `perf-regression-s0-r5.retry-2026-10-05.md` | 1328→810→1269 | 六项全绿 | **值得真机续跑**：perf-regression 家族当前 0 条金标，同上 |
| `sse-truncated_decoy-s0-r4.retry-2026-10-05.md` | 1518→913→1467 | 六项全绿 | **不重跑、不 replace**。两版各有对错，且**不是按形状判的**：现役稿多一行「改法只落一个」的落点句，但它把「legacy 要不要一起改」记成**已排除**——原文停在 `Should I also fix legacy? ... Let me check if legacy is imported anywhere. grep.`，那是**未决**、不是排除；这版按原文记成「还没定 + grep 没发」。这格在 b13 上让 5 个策略全得 0.000、是最有区分度的一格，换它必须拿真机 outcome 来换，离线绿不算。（先前拿 replay 的 dd 0.65 论证此事**无效**：那是已废除的相似度口径，v14.21.1 已删） |

## 写作红线（每份稿都按这套来，缺一项就被闸挡回）

1. **只压缩上一轮已经发生的事**：raw 里没有落定句、也没有改法意图时，稿里出现"改法只落…/改成…"即判 `invented-decision`（`flaky-timeout-s0-r4` 上一稿就死在这里，它把没做的 `{ hedgeAfterMs: 1600 } → 5000` 写成了决定）。
2. **三元组的 old_text 必须逐字在 raw∪ctx 里**，否则 `invented-triple`；new_text 的每个锚点也要在证据里。
3. **锚点按逐字形态算**：raw 里是 `rejects`/`settled`，写 `reject`/`settle` 就算发明（实测被 `anchorPrecision 0.959` 抓住）。
4. **引用回显只能用 `「…」` / `“…”` / 反引号框**，且内容原样出现在证据里 ⇒ 免检；转述成一般性保证即判 `environment-permission-assertion`。ASCII 双引号**不在**免检通道。
5. **不写实验元语**：轮数上限、预算、停止条件、"沙箱必然如何" 都是定罪项；`prompt` 这类元称也不在证据锚点里。
6. **排除项必须带理由**（金标的价值就在这儿）：光写"已排除：X" 是空洞模板，A41d 判 0。
7. **长度是硬约束**：`netSaved = raw − stored ≥ 50`，而 stored = 稿 + 程序台账（实测 459–554 字，随格不同）⇒ 短 raw 的单元要把稿压到 `raw − 台账 − 50` 以下；`flaky` 那条宽松，`perf`/`sse_decoy` 各被 `no-gain` 挡回三次才收敛。
8. **已走过的路不许复活**：台账里的调用不能写成下一步（`deadEndResurrected`）。

## 真机裁决（2026-10-05 当天，t91/t92/t93/t94，共 $0.301，gateFails 0）

跑的是模式 1 真机单元（`plan-traj --arms raw,hand` → `traj-run`，通道预检 carry-verified Δ594）。结果必须照原样记：

| 单元 | 轮数 | raw 臂 | hand 臂（我的稿） |
|---|---|---|---|
| t91 flaky-timeout + perf-regression | 7 | 未修好 · edit 0 | 稿均收下（2306 / 1269 字，过闸）· 未修好 · edit 0 |
| t92 perf（稿改到 r7、加可抄 old→new） | 8 | 未修好 · edit 0 | 稿 2995 字收下 · 未修好 · edit 0 |
| t93 perf 延长 | 12 | **r11 发 edit_file 改好 → r12 又改回 1800**（fixedAtRound=11、最终 false） | 12 轮全 bash（13 个调用）· edit 0 · 重复 1 |
| t94 perf（写死收工条件 + 禁止退回取证） | 9 | 未修好（8–9 轮在 `env`/`type analyze-trace` 上打转） | r8「稿 ✗」(那轮 7567 字过地板但没预置稿)、r9 绕开 edit_file 改用 `sed -i` ⇒ 未修好 |

累计 `ceiling`：11 对，raw 修好率 0.364 / hand 0.273，e=2.333（阈 10）⇒ **「分不出」**。`gold add` 要「过闸且修好」⇒ **这四份稿一份都不是金标，不进注册表**。

三条只有真机才能给的结论（写下来，别靠聪明猜）：

1. ~~**`perf-regression` 这格不是压缩稿能撬动的**~~ **（此条已被 t95 推翻，见下一节；保留原文，因为它记录的是一次错误归因的过程）**：raw 臂要 11 轮才动手、还守不住（改完又改回）。⇒ 该格 0/8 的覆盖缺口不是"我没写好"，而是**任务结构决定了"停止取证"这一维在 ≤9 轮的预算里测不出来**；要测就得改 fixture（那是动数据，另议）。数据与轨迹全留，不删。
2. **离线判据管不了落地行为**。我把 old→new、同轮 edit_file、验收读数、收工条件全写进稿、六道闸全绿，模型仍连着 5 轮只做 bash ⇒ 形状检查器只配当银标质检，**它的"齐"不代表有用**。
3. **r8 那类"稿 ✗"要预先堵**：同一条轨迹里凡过地板的轮都会要稿，只预置一轮的稿 ⇒ 下一轮直接不压（`压稿成功 50%`）。续跑前先数一下还剩几轮会过地板。

⇒ 处置：`flaky-timeout-s0-r4`、`perf-regression-s0-r5/s0-r7` 三份按**银标**处理（形状齐、闸全绿，进 `train:export` 的语料，`use:'train'`），不当金标、不 replace 现役；`sse-truncated_decoy-s0-r4` 仍按上一轮判断不重跑（现役稿那一格真机 `fixed@5`、2 次 edit_file，是有战绩的）。

写稿门槛（用户 2026-10-05 两次纠正，都记在这儿）：

- 老金标不是随便写的 ⇒ 新稿不能只是「过闸」，归因要写到位：因果链、排除带理由、落点与原文一致、未到手材料有处置、未解留着。缺一样，说明这稿还没到值得花主调用去验的程度。
- 但**形状齐 ≠ 金标**：金标只认真机 outcome。判据（`silver-shape`）的用途是让下一批银标成批量时不掺水，不是给金标发凭据。
- 教训（同一天的我自己）：因为现役稿里有「若 A 就…／若 B 就…」，我就给 `perf`、`sse` 各缝了一句形状相同的。`perf` 那句把**改完后的验收读数**当成了那两条取证 bash 的读数（写的是「回落到 280 ⇒ 就照 450 落地」，可 280 是改动**前**的旧值、`--last 5` 读的是历史版本，不会「回落」）；`sse` 那句写「落地后仍打 `condensed` 就先看清 `assembleSseFrames` 的返回值」，而那正是被改的东西。两处都删了，换成从原文长出来的：`perf` 的分支挂在 raw 自己那句 `Let me check what the analyze-trace data source is`——脚本若显示 contentSpanMs 是从 outputChars 推算的，它就跟着长度一起涨、不能当独立证据；`sse` 那格没有待读读数，改成形态 b：欠的是把已定改法写出去（原文「Let me do edits and grep.」两样都没发）。
- 判据也跟着改了：原来硬要求每格都有分支句，那等于逼写稿人造句子。现在形态 a（预注册分叉）/ 形态 b（交代没有待读读数 + 点名欠的动作）任选，`test/silver-shape.selftest.mjs` 的 E-b、E-c 把两头钉住：形态 b 要放行，光写一句「这块没查」要挡住。

## t95 / t96（$0.125，gateFails 0）：上一节第 1 点作废——这一格撬开了，但只赢一次

**先说清病根**（读 t94 真机 transcript 得到的，不是猜）：raw 臂第 8 轮那 7567 字里，结论早就写完了 —— `So the fix: revert compressTargetMax to 450` 反复出现；卡住它的是**去找一个不存在的验收**：它自己既写了 `the tool reads historical trace data, not config`、`Changing config won't change the historical trace`，又接着说 `Let me test by changing config and re-running… that's a good experiment`，最后一句是 `Actually, I already spent many rounds. Let me just check for any hidden files/dirs` ⇒ 它没在犹豫改哪个值，它在等一个不会来的确认。

**所以稿子的活不是再补一遍归因，是把验收换成可完成的那个**：`edit_file` 同轮 `cat src/config.js` 看到 `compressTargetMax: 450,` 即收工；并把"那条验证不存在"挑明；再加防回滚条款（t93 的 raw 改完 r12 又改回 1800 ⇒ 明写"读数不回落不构成把 1800 改回去的证据"）。两份稿：`perf-regression-s0-r7.retry-2026-10-05c.md`（真机用的就是它）与 `perf-regression-s0-r8.retry-2026-10-05.md`（同轨迹第二份，预置好，堵掉 t94 那种「稿 ✗」）。

| 单元 | 轮数 | raw 臂 | hand 臂（05c 那份稿） |
|---|---|---|---|
| t95 | 9 | 未修好 · 19 调用 · **edit 0** | **修好@9** · `edit_file` ok · `finalFiles` = `compressTargetMax: 450` · 稿 1236→stored 2864（净省 1248）· 重复 0 · 压稿 1/9 |
| t96 | 10 | 未修好 · edit 0 · r10 还在 `git show v11.9:src/config.js` | **未复现** · edit 0 · `finalFiles` 空（r8 那份稿被收了 `稿 4159 ✓`，仍没动手） |

合并进 `ceiling`：raw 0.308 / hand 0.308，e=3.75（阈 10）⇒ 总体仍「分不出」；perf 家族 6 对 = **5 tie + 1 win**。金标按「过闸且修好」入了一条（`gold add --plan 95`），t96 的反证写进了条目的 `replay.knownWeakness`，不当它已确证。

三条新的硬教训：

1. **"我干不动"不是"格子干不动"**。上一节第 1 点是从 t91/t93/t94 三次失败倒推出来的，把工具没找到杠杆当成了杠杆不存在。真机的反驳只花了 $0.05。
2. **未解句不能给主模型派活**。每条轨迹只压被挑中的那一轮，稿里写「下一轮就查…」等于让它去查而不改（t93/t94：hand 臂 r8+ 提 `birthFinishWaitMs` 8 次 vs raw 3 次）。`tools/silver-shape.mjs` 的 L5 现只认**完成判据**（"…即收工 / 确认…落地 / 未解原样写进结论"），"不阻断本轮、不要再回到取证"这类**禁令不算收敛** —— 05b 版就是靠禁令蒙过了旧判据、真机仍不动手。
3. **n=1 的赢不能当结论**。t95 赢在最后一轮（`maxRounds=8` 就不成立）、改完没验收；t96 连 raw 都漂在取证上。要把它当尺子，得同一份稿重复 3–5 次（每次 ≈$0.05–0.08）。
