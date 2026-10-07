# AI 模型与开发者一页交接卡（`transfer/HANDOFF.md`，v14.25.4）

> 本文件替代了原先分散的 `MIGRATION.md`、`LIVE-MEMORY.md`、`MEMORY.md`、`NEXT-MODEL-PROMPT.md` 与 `SUMMARY-2026-10-02.md`。
> 接手本项目的 AI 模型或人类开发者只需读完本页即可 **30 秒内零盲区开工**。请始终使用**中文**回复。

---

## 1. 三步环境恢复与全量自检（换机器 / 新会话第一件事）

```bash
# 1. 从入库快照重建 gitignored 的可再生闭环状态 (.cfb-offline)
npm run restore             # = node tools/cfb-cycle.mjs restore

# 2. 校验 SHA-256 清单并在断网命名空间跑满全部自检（Node >= 20 即可；本仓库在 v20.20.2 上验证通过）
npm run manifest:check      # = node manifest.mjs --check（0 缺失 / 0 失配）
npm run verify:offline      # = node tools/verify-offline.mjs（读数见下面的水位块，勿手抄）
npm run watermark:check     # = node tools/doc-watermark.mjs --check（文档水位与磁盘一致？）

# 3. 一屏查看当前闭环状态、本地代理评测记分卡与智能下一步建议
npm run cycle               # = node tools/cfb-cycle.mjs status
npm run bench               # = node tools/cfb-cycle.mjs benchmark
npm run next                # = node tools/cfb-cycle.mjs next
```

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
- **当前版本：v14.25.4** · **零第三方依赖**（纯 Node.js ≥ 20/22 内置模块）
- **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**
- 验收口径 `npm run verify:offline`（真断网 Linux 命名空间）：42/42 套件通过 · `1242 通过 / 0 失败 / 1 跳过`
- 快速自检 `npm test`（联网机上跑，需要隔离的那条断言按设计跳过）：42/42 套件通过 · `1241 通过 / 0 失败 / 2 跳过`
- 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。
- **规模**：`src/` 24 个零依赖模块 · `tools/` 61 个脚本 + 29 个 helpers · `test/` 42 套自测 · `transfer/gold/` 13 条（4 个家族）
<!-- watermark:end -->

> **沙盒环境提示**：`package.json` **没有** `engines` 字段 ⇒ 版本要求只写在文档里、不作硬闸；实测 Node 20.20.2 全绿。若容器 Node < 20，可一行升级至 `/usr/local`：
> `curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1`
> 真实 API 密钥（如需要跑线上评测）存放在工作区外 `~/.secrets/keys.env`（`chmod 600`，**永不入库、永不打印**）。

---

## 2. 当前仓库状态与最优策略基线

- **分支与版本**：`main`，版本与自测读数全部见上面的水位块（由 `--record` 记账 ⇒ 本文件不再抄一遍旧数）。
- **核心架构**：100% 纯净的思维链出生即压缩（`birth` + `compile-v4`），已彻底剥离 DSH 外部宿主混入层与冗余旁路。
- **`npm run bench` 第二表榜首**：**`p-1490eefcdf`**（四维满配：`continuationPath: 'bounded'` + `statePartsMode: 'compact'` + `modularPromptPrune: true` + `birthAdaptiveFloor: true`，提示词净减 `-1037` 字）。当前 L1 预筛为金标过闸 **12/13（净省 431 tok）**、`dd=0.724`、池题 **4/4 题 / 9/9 轮**、均省 **1111 tok**、Oracle `dd=0.831`、真值分 `0.696`、AA 密度效率 `0.6473`。
  **榜首 ≠ 已采纳**：`npm run cycle` 当前 champion 仍为 `base`；候选在当前 L2 汇总里 `policy:p-1490eefcdf` 是 **1/24（4.2%）**严苛修好。先不采纳，也不把 L1 排名当端到端收益。
- **L2 轨迹汇总（`npm run bench`，2026-10-07 本地日期）**：`raw n=80 / auto n=7 / ledger n=6`；`auto` 严苛解决率 **85.7%**、伪修好 `0%`、`pass@1=0.889`、`pass^2=0.778`、平均 `4.86` 轮（相对 raw `−24.9%`）、思维链字符 `−27.4%`；Elo **1104，95% CI [945, 1279]**（区间覆盖 raw=1000）。这是多个在盘轨迹的描述性汇总，不是同一随机化盲测；旧数 `raw n=8 / Elo 1110 / −13.7%` 不再当现状。
- **闭环状态（`npm run cycle` 当前输出）**：champion=`base`；飞轮 **93/93** 对过 dev/内容闸；CPU 排序器 `ready`、LOO-CV **0.763**；效度尺子 **`suspect (n=304)`**，不是 `valid`。`npm run train:export` 是导出工具，不改变候选的验证状态。

### 2′. 金标注册表现状与「改稿重挣」通道（v14.25.4 复核，接手必读）

- **注册表现状（2026-10-07 本地日期现算，条数同步在 `../README.md` 文首水位块）**：`transfer/gold/` 在册 **13 条 / 4 家族**（`sse-truncated` 5 · `wrong-model` 4 · `eacces-config` 3 · `perf-regression` 1；`dev 6 + holdout 7`）。
  尺子判词按 `cfb.gold-standard/1` 逐条现算：**4 条 `gold` / 9 条 `not-gold`**（`tools/gold-attest.mjs` 只降不升，条目 `goldStandard.stampDigest` 一变即过期）。
  `ceiling.ok`：**12/13 达标**，唯一不达标是 `perf-regression-s0-r7`（真机 `roundsToFix 9 > 6` ⇒ C4 提前量不成立 ⇒ 按 fail-closed 保持 `use:'train'`，不删）。
- **用途隔离现状（v14.21.0 起，v14.24.x 改了默认走向）**：13 条里 **`use:'ruler'` 7 条 / `use:'train'` 6 条** —— **不是**"全部只当标尺"。`train` 那 6 条是 `goldCeiling` 不达线被 fail-closed **降级**下来的（降级 ≠ 丢数据：不进标尺、不删条目），要复核就 `node tools/gold-ceiling-audit.mjs`（$0）。
- **模式 2 实测基线（只认 `b13`，别再引 `b10`/`b11`）**：⚠ `b13` 跑在旧的 7 项 dev 集上，注册表现已 13 条 ⇒ 重跑前别把它当现状。dev 3 项 × 5 策略、`dd/2` ⇒ `base 0.300`、`p-082d742f60 0.560`、`p-55a320e0f8 0.579`、`p-08bdbc7561 0.620`、`p-1490eefcdf 0.667`；配对全 `undetermined`（e 最高 2.333 < 10 —— dev 只有 3 项，本来就量不到 10）。`b10`/`b11` 那个 `base 0.519` 是**假数字**：15 行里 8 行是通道 `timeout 22000ms`，而 dd/1 又把「调用失败 ⇒ 原文回塞」当成稿来计分。跑法必须带 `--timeout-ms 150000`；真 `no-gain` 只有 6 行 ⇒ 侧模型的瓶颈先是**压不出**，再谈压得好。标尺口径（含「模板照旧受奖励」的判定）见 `docs/TRAINING-AND-BENCHMARK.md` §3.1；注册表摘要一变，旧计划按设计 `gold-changed` 拒跑，`plan-bench` 重建即可，未变条目靠 `--out` 同目录的兄弟缓存免付调用。
- **扩标方案（要补金标先读这份）**：`docs/GOLD-EXPANSION-PROGRAM.md` —— 40 项 / 5 家族的判据、标尺与训练料分家、双作者一致率（复用 `blind-unit-label-v3`）、覆盖矩阵与三档预算；里面 §6 记了 2026-10-05 换上游后的通道事实（`temperature 0` 不再逐字确定、400 tok 只要 2.0–2.2 s、小 `max_tokens` 会被思考吃满 ⇒ 压缩调用下限 600、`--timeout-ms 150000`）。
- **天花板资格先于越界**：`gold add` 有三道拒收 —— 未修好、`vsRaw loss`（比主模型自己读原文还慢）、`missing`；前两道是「不够格」，只有 lint 那道才叫「越界」并进隔离区。判据写在 `saveGold`，`A41b` 钉住。稿子被拒后**不删**：连同单元结果落 `transfer/gold-repair/measured/`。
- **改稿两条铁规矩（被真机教出来的）**：① 只能照当轮 `pending/<id>.json` 的 `raw + ctx` 写，别把旧轨迹的结论搬过来（`invented-decision`/`invented-triple`）；原文还没下决定时，稿子只许带机理＋排除，不许替主模型落定。② 花钱前先 `node tools/hand-preflight.mjs <plan> [--only id]`（$0 复跑同一条闸链）；短 raw 的轮次要算上程序部件（~600 字），稿得压到 ~700 字以内才可能有净省。
- **审计口径**：装置话术（越界）只定**作者自己写的主张**的罪；整句或「…」/`…` 定界引用若原样出现在 `raw ∪ ctx` ⇒ 报告观测，免检（`qualityAudit.exempted[]` 带 `basis`）。`auditMode1Gold` = `draft ∪ stored` 都过免检。
- **被隔离 ≠ 报废**：`node tools/cfb-gold-repair.mjs audit` 复算隔离区（active + `transfer/gold-rejected`）⇒ `RESTORABLE` 用 `restore --id … --apply` 字节级放回（digest 不变 ⇒ 冻结的 `b1`–`b9` 仍可用）；`NEEDS-REWRITE` 改稿后 `replay --id X --draft F`（$0 复跑 G2 → `compileV4Direct` → 程序部件 → `birthAccept` → lint，并打印逐槽差 = 归因账）⇒ 全绿 `stage`。
- **换稿入库**：真机复测过后 `node tools/cfb-cycle.mjs gold add --plan N --replace` —— 旧条目自动归档 `transfer/gold-history/<family>/`，新条目打 `revision` 戳。金标摘要一变，旧基准计划按设计 `gold-changed` 拒跑 ⇒ 必须 `plan-bench` 重建。

---

## 3. 个人极简省钱评测三档菜单

| 档位 | 命令 | 成本 | 用途 |
|---|---|---:|---|
| **Tier 0（离线全表）** | `npm run bench` / `npm run prescreen` | **`$0.00`** | 本地轨迹汇总与预筛代理记分卡（借鉴外部指标口径，非官方 benchmark 成绩）+ 四维正交因子归因 |
| **Tier 1（极简基准）** | `npm run bench:lite` | **`≈ $0.004`** | 复用 `b1` 缓存的 `base` 臂，仅对新候选策略发 **1 次**副模型调用即完成配对对比 |
| **Tier 2（极简轨迹）** | `npm run traj:lite` | **`≈ $0.068`** | IRT 自动挑信息量最高 1 题 × 4 轮上限 × 影子分叉（分歧前零主调用）+ `$0.08` 硬熔断 |

---

## 4. 铁律与长期约束（不可违反）

1. **禁止删减双轨语义能力**：确定性规则（`draftDistance`）与 LLM 语义裁判（`tools/cfb-judge.mjs`）、LLM 提议器（`proposer.mjs`）、正交因子归因、Pareto 池与岭回归校准缺一不可。
2. **禁止重新混入 DSH 宿主工具面**：`cfb` 只做思维链出生即压缩与认知编译，不接管宿主工具定义。
3. **修改文件必更清单**：改动任何入库文件后，若修改了 `.cfb-offline` 状态需先跑 `npm run snapshot`，随后必须执行 `npm run manifest` 与 `npm run verify:offline` 确保 0 漂移、0 失败。

## v14.21.0（2026-10-05）：标尺 / 训练料已分家 —— 从此 `use` 字段裁决

`transfer/gold/` 里每条现在带 `use`（`ruler` / `train` / `both`，缺省 `ruler`）。**7 条现有金标全部 `use=ruler`：只当标尺，不再进任何拟合。** micro 的训练料改从 `tools/helpers/traj-corpus.mjs`（读 `.cfb-runtime/traj/*/hand-samples.jsonl`，只收 `trainingEligible && clean`）。要放行某条进训练：`node tools/cfb-cycle.mjs gold use --id X --set train` —— 但这等于亲手制造泄漏，除非你明确接受。
扩量对账：`node tools/coverage-plan.mjs`（$0）→ `transfer/gold-repair/gold-coverage/matrix.md`（输入指纹 `90abc37bef69db7f`）：格 = 5 家族 ×（3 轮位档 + 3 长度档）= **30 格**，逐格"差 N"合计 **36**（旧文档写的 33 是上一轮读数）。两根轴是同一批条目的两种投影（各加总 = 目标 40 条），不是交叉相乘。双作者一致率与通道适配按用户裁决**不做**，所以噪声底没有实测值。详见 `docs/GOLD-EXPANSION-PROGRAM.md` §1/§8 与 CHANGELOG v14.21.0。
