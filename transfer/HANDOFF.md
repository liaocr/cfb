# AI 模型与开发者一页交接卡（`transfer/HANDOFF.md`，v14.18）

> 本文件替代了原先分散的 `MIGRATION.md`、`LIVE-MEMORY.md`、`MEMORY.md`、`NEXT-MODEL-PROMPT.md` 与 `SUMMARY-2026-10-02.md`。
> 接手本项目的 AI 模型或人类开发者只需读完本页即可 **30 秒内零盲区开工**。请始终使用**中文**回复。

---

## 1. 三步环境恢复与全量自检（换机器 / 新会话第一件事）

```bash
# 1. 从入库快照重建 gitignored 的可再生闭环状态 (.cfb-offline)
npm run restore             # = node tools/cfb-cycle.mjs restore

# 2. 校验 SHA-256 清单并在断网命名空间跑满 29 套自检（要求 Node.js >= 22）
npm run manifest:check      # = node manifest.mjs --check（0 缺失 / 0 失配）
npm run verify:offline      # = node tools/verify-offline.mjs（29/29 套件全绿，884 pass / 0 fail / 1 skip）

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

- **分支与版本**：`arena/01a0f127-cfb`（`v14.18.0`），`29/29` 套件全绿（`884 pass / 0 fail / 1 skip`）。
- **核心架构**：100% 纯净的思维链出生即压缩（`birth` + `compile-v4`），已彻底剥离 DSH 外部宿主混入层与冗余旁路。
- **当前 Pareto 冠军策略**：**`p-e62a037097`**（四维满配：`continuationPath: 'bounded'` + `statePartsMode: 'compact'` + `modularPromptPrune: true` + `birthAdaptiveFloor: true`，提示词净减 `-1037` 字）：
  - **L1 金标基准（8/8 全过闸）**：金标省 `454 tok`（较基线 `247 tok` **+83.8%**），全池均省 `437 tok`，真值均值 `0.762`，AA 密度效率 `0.6986`。
  - **L2 多轮轨迹基线（`transfer/traj1..3`）**：`auto` 臂 SWE 严苛解决率 **`85.7%`**（伪修好水分 **`0.0%`**，而只挂台账的 `ledger` 臂含 **`16.7%` 伪修好**），平均轮次 **`-13.7%`**，思维链字符 **`-27.4%`**，**LMArena Elo `1110`**（胜过 `raw` `1000` 与 `ledger` `951`）。
- **飞轮与排序器**：`train/pairs.jsonl` 已积累 56 对跨 5 家族偏好对，CPU 排序器 LOO-CV 达 **`92.9%`**，`npm run train:export` 随时可按 5 家族严格组隔离导出 SFT/DPO 数据与 In-Context DPO 范例。

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
