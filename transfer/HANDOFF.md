# AI 模型与开发者一页交接卡（`transfer/HANDOFF.md`，v14.20.1）

> 本文件替代了原先分散的 `MIGRATION.md`、`LIVE-MEMORY.md`、`MEMORY.md`、`NEXT-MODEL-PROMPT.md` 与 `SUMMARY-2026-10-02.md`。
> 接手本项目的 AI 模型或人类开发者只需读完本页即可 **30 秒内零盲区开工**。请始终使用**中文**回复。

---

## 1. 三步环境恢复与全量自检（换机器 / 新会话第一件事）

```bash
# 1. 从入库快照重建 gitignored 的可再生闭环状态 (.cfb-offline)
npm run restore             # = node tools/cfb-cycle.mjs restore

# 2. 校验 SHA-256 清单并在断网命名空间跑满 29 套自检（要求 Node.js >= 22）
npm run manifest:check      # = node manifest.mjs --check（0 缺失 / 0 失配）
npm run verify:offline      # = node tools/verify-offline.mjs（33/33 套件全绿，967 pass / 0 fail / 1 skip）

# 3. 一屏查看当前闭环状态、五大官方基准成绩单与智能下一步建议
npm run cycle               # = node tools/cfb-cycle.mjs status
npm run bench               # = node tools/cfb-cycle.mjs benchmark
npm run next                # = node tools/cfb-cycle.mjs next
```

> **沙盒环境提示**：若当前容器 Node < 22，可一行升级至 `/usr/local`：
> `curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1`
> 真实 API 密钥（如需要跑线上评测）存放在工作区外 `~/.secrets/keys.env`（`chmod 600`，**永不入库、永不打印**）。

---

## 2. 当前仓库状态与最优策略基线

- **分支与版本**：`main`（`v14.20.1`），`33/33` 套件全绿（`967 pass / 0 fail / 1 skip`），`manifest.mjs --check` 0 漂移。
- **核心架构**：100% 纯净的思维链出生即压缩（`birth` + `compile-v4`），已彻底剥离 DSH 外部宿主混入层与冗余旁路。
- **当前 Pareto 冠军策略**：**`p-e62a037097`**（四维满配：`continuationPath: 'bounded'` + `statePartsMode: 'compact'` + `modularPromptPrune: true` + `birthAdaptiveFloor: true`，提示词净减 `-1037` 字）：
  - **L1 金标基准（8/8 全过闸）**：金标省 `454 tok`（较基线 `247 tok` **+83.8%**），全池均省 `437 tok`，真值均值 `0.762`，AA 密度效率 `0.6986`。
  - **L2 多轮轨迹基线（`transfer/traj1..3`）**：`auto` 臂 SWE 严苛解决率 **`85.7%`**（伪修好水分 **`0.0%`**，而只挂台账的 `ledger` 臂含 **`16.7%` 伪修好**），平均轮次 **`-13.7%`**，思维链字符 **`-27.4%`**，**LMArena Elo `1110`**（胜过 `raw` `1000` 与 `ledger` `951`）。
- **飞轮与排序器**：`train/pairs.jsonl` 已积累 56 对跨 5 家族偏好对，CPU 排序器 LOO-CV 达 **`92.9%`**，`npm run train:export` 随时可按 5 家族严格组隔离导出 SFT/DPO 数据与 In-Context DPO 范例。

### 2′. 金标注册表现状与「改稿重挣」通道（v14.20.1，接手必读）

- **注册表现状**：`transfer/gold/` 活跃 **7 项 / 3 家族**（`sse-truncated` 3、`eacces-config` 2、`wrong-model` 2；`dev 3 + holdout 4`），全部 `[clean]` + 修好 + **自比 dd=1.000**（`A41` 钉）。其中 `sse-truncated_decoy-s0-r4` 是 2026-10-05 真机挣回又换过稿的（t15 win → t17 换稿 tie、hand 比 raw 省 33.6% token），本地微模型对它仍 `no-gain`⇒ 模式 2 的靶子就照它排。其余待办登记在 `transfer/gold-repair/pending-retest.json`：1 条改好的稿量出 vsRaw loss ⇒ 进 `measured/`（素材，不当天花板）、4 条 `blocked-on-this-channel`（本通道两臂都修不好 ⇒ 没有归因信号，须回原通道复测）；`outcome` 来自旧稿真机单元者一律**改稿即作废**，必须重跑模式 1 单元才算金标（不许拿离线绿当金标）。
- **模式 2 实测基线（只认 `b13`，别再引 `b10`/`b11`）**：dev 3 项 × 5 策略、`dd/2` ⇒ `base 0.300`、`p-082d742f60 0.560`、`p-55a320e0f8 0.579`、`p-08bdbc7561 0.620`、`p-1490eefcdf 0.667`；配对全 `undetermined`（e 最高 2.333 < 10 —— dev 只有 3 项，本来就量不到 10）。`b10`/`b11` 那个 `base 0.519` 是**假数字**：15 行里 8 行是通道 `timeout 22000ms`，而 dd/1 又把「调用失败 ⇒ 原文回塞」当成稿来计分。跑法必须带 `--timeout-ms 150000`；真 `no-gain` 只有 6 行 ⇒ 侧模型的瓶颈先是**压不出**，再谈压得好。标尺口径（含「模板照旧受奖励」的判定）见 `docs/TRAINING-AND-BENCHMARK.md` §3.1；注册表摘要一变，旧计划按设计 `gold-changed` 拒跑，`plan-bench` 重建即可，未变条目靠 `--out` 同目录的兄弟缓存免付调用。
- **天花板资格先于越界**：`gold add` 有三道拒收 —— 未修好、`vsRaw loss`（比主模型自己读原文还慢）、`missing`；前两道是「不够格」，只有 lint 那道才叫「越界」并进隔离区。判据写在 `saveGold`，`A41b` 钉住。稿子被拒后**不删**：连同单元结果落 `transfer/gold-repair/measured/`。
- **改稿两条铁规矩（被真机教出来的）**：① 只能照当轮 `pending/<id>.json` 的 `raw + ctx` 写，别把旧轨迹的结论搬过来（`invented-decision`/`invented-triple`）；原文还没下决定时，稿子只许带机理＋排除，不许替主模型落定。② 花钱前先 `node tools/hand-preflight.mjs <plan> [--only id]`（$0 复跑同一条闸链）；短 raw 的轮次要算上程序部件（~600 字），稿得压到 ~700 字以内才可能有净省。
- **审计口径**：装置话术（越界）只定**作者自己写的主张**的罪；整句或「…」/`…` 定界引用若原样出现在 `raw ∪ ctx` ⇒ 报告观测，免检（`qualityAudit.exempted[]` 带 `basis`）。`auditMode1Gold` = `draft ∪ stored` 都过免检。
- **被隔离 ≠ 报废**：`node tools/cfb-gold-repair.mjs audit` 复算隔离区（active + `transfer/gold-rejected`）⇒ `RESTORABLE` 用 `restore --id … --apply` 字节级放回（digest 不变 ⇒ 冻结的 `b1`–`b9` 仍可用）；`NEEDS-REWRITE` 改稿后 `replay --id X --draft F`（$0 复跑 G2 → `compileV4Direct` → 程序部件 → `birthAccept` → lint，并打印逐槽差 = 归因账）⇒ 全绿 `stage`。
- **换稿入库**：真机复测过后 `node tools/cfb-cycle.mjs gold add --plan N --replace` —— 旧条目自动归档 `transfer/gold-history/<family>/`，新条目打 `revision` 戳。金标摘要一变，旧基准计划按设计 `gold-changed` 拒跑 ⇒ 必须 `plan-bench` 重建。

---

## 3. 个人极简省钱评测三档菜单

| 档位 | 命令 | 成本 | 用途 |
|---|---|---:|---|
| **Tier 0（离线全表）** | `npm run bench` / `npm run prescreen` | **`$0.00`** | 1 秒输出五大国际官方基准成绩单 + 零 API 预筛与四维正交因子归因 |
| **Tier 1（极简基准）** | `npm run bench:lite` | **`≈ $0.004`** | 复用 `b1` 缓存的 `base` 臂，仅对新候选策略发 **1 次**副模型调用即完成配对对比 |
| **Tier 2（极简轨迹）** | `npm run traj:lite` | **`≈ $0.068`** | IRT 自动挑信息量最高 1 题 × 4 轮上限 × 影子分叉（分歧前零主调用）+ `$0.08` 硬熔断 |

---

## 4. 铁律与长期约束（不可违反）

1. **禁止删减双轨语义能力**：确定性规则（`draftDistance`）与 LLM 语义裁判（`tools/cfb-judge.mjs`）、LLM 提议器（`proposer.mjs`）、正交因子归因、Pareto 池与岭回归校准缺一不可。
2. **禁止重新混入 DSH 宿主工具面**：`cfb` 只做思维链出生即压缩与认知编译，不接管宿主工具定义。
3. **修改文件必更清单**：改动任何入库文件后，若修改了 `.cfb-offline` 状态需先跑 `npm run snapshot`，随后必须执行 `npm run manifest` 与 `npm run verify:offline` 确保 0 漂移、0 失败。
