# 给下一个模型的开工提示词（整份粘贴，不要删改）

你是接手 **cfb** 项目的模型。工作目录 `/home/user/cfb`，仓库 `github.com/liaocr/cfb`，当前分支 `arena/01a0eba2-cfb`。**只用中文回复。**

---

## 一、开工第一步：先读，读完再动手

按顺序读完这些，然后跑自检：

1. `transfer/LIVE-MEMORY.md`（工作记忆；**每次上下文被压缩后第一时间重读**）
2. `docs/analysis/HANDOFF-2026-09-30.md`（项目全貌 / 约束 / 已知坑 / 迁移清单）
3. `docs/analysis/BREAKTHROUGH-4-REPRESENTATION-2026-09-30.md`（最新、最重要）
4. `docs/analysis/CAPABILITY-BREAKTHROUGH-3-2026-09-30.md`
5. `docs/analysis/BREAKTHROUGH-MAP-2026-09-30.md`
6. `docs/analysis/CAPABILITY-SWEEP-2026-09-30.md`
7. `docs/theory/CFB-THEORY-COMPLETE.md` + `CHANGELOG.md`（最新段）
8. `transfer/mr/run4/summary.md`（效果基线）

自检：
```bash
cd /home/user/cfb && git status -sb && node manifest.mjs && node verify.mjs
node tools/audit-noninferiority.mjs
```
应全过（允许 1 条跳过项）、审计 N1–N7 全零。**失败就先修，不要在失败状态下开工。**

---

## 二、你的任务：**一次性**把新架构搭起来

### 背景（你只需要知道这些）

- cfb 现在是一个**压缩器**：把主模型的长轨迹压成一份中文稿，再喂回主模型继续干活。九版修复后，文字层面已到边界（run4 red：raw 4.9 → 当前 8.0，手写上限 8.9）。
- 用户的痛点原话："**反复修改，不知出路，不知前路，不知哪里不好，只能根据返回的数据被动修改，虽然是优化，都有限且零碎。**"他要的是**突破**，不是补丁。
- 上述 8 份文档里有我们四轮文献侦察的全部结论（哪些是墙、哪些机制被证明有效、哪些是硬反证、我们自己的数据形状）。**把它们当资料，不要当设计蓝图**——里面出现的方案建议是**上一轮模型的猜想**，你可以采纳、改写或整体推翻。

### 你要交付什么

**一个新架构：设计、实现、自测、文档、提交、推送——一次做完，一步到位。**

- **设计完全由你决定。** 不要回来问用户"你想怎么设计"，也不要分批等人批准（实现本身已获批）。
- 允许你保留、重写或删除现有部件；但**旧路径必须保留可回退，新东西只能在通过检查时启用**（"给模型的每一样东西在任何情况下都必须是优化、不能变差"是用户立的硬规矩）。
- 目标：让系统不再依赖"改文字 → 看分数 → 再改文字"这条被动路径，并把"哪里不好、下一步做什么"变成系统自己能回答的问题。
- **零付费调用**：设计与验证都用**零调用**手段——离线回放仓库里已有的数据（`transfer/mr/run4/results.jsonl`、`transfer/mr/auto-d2*.json`、`transfer/traj1-3`、`transfer/direct-*.json`、`transfer/mr/chains.json` 等）。**任何要花钱的实跑先报用户批准，绝不自行开跑。**
- 若中途遇到只有用户能决定的事（花钱、外部依赖、不可逆动作），**停下来问**；其余一律自己决定并写下来。

### 完成定义（DoD，缺一不可）

1. **代码 + 自测**：新架构有对应单测；`node manifest.mjs`、`node verify.mjs` 全过。
2. **不退化**：`node tools/audit-noninferiority.mjs` 的 N1–N7 仍全零（旧行为一条都不许坏）。
3. **文档**：设计文档写进 `docs/`（含**你的设计决策与权衡**、被否决的备选、为什么）；更新 `CHANGELOG.md` 与 `transfer/LIVE-MEMORY.md`。
4. **可证伪的预注册预测**：写清楚"如果这个架构成立，哪些指标该变、哪些**不该**变"。这条是用户最在意的验收方式。
5. **提交与推送**：小步提交但一次性做完（每条提交信息说清"为什么"）；快进推送到工作分支。

---

## 三、红线（违反即前功尽弃）

- 中文回复；少测、少花钱；自主推进，不要反复确认。
- 密钥在 `/home/user/.secrets/keys.env`：**永不打印、永不提交**（用 `set -a && source /home/user/.secrets/keys.env && set +a` 加载）。
- git 作者必须是 `cfb-cleanup <cleanup@local>`；**只允许快进推送**：
  `git push https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git HEAD:arena/01a0eba2-cfb`
- 推送/提交前必跑：`node manifest.mjs` → `node verify.mjs`；**改闸门/渲染先跑** `node tools/audit-noninferiority.mjs`。
- 评委（也是 DeepSeek 系）很贵：缺省 1 票 + 条件补票；**禁止批量重判**；评测每轮 `raw + 1 变体`、2 样本/任务；渲染/闸门改动一律 `--recompile` 零成本回放，改提示词才重压副模型。
- 不做抽取式压缩、不保留"原文尾巴"、不加第 N 条 K 规则、不把稿子压更短、不把评委 Likert 当训练信号、没有留出集不做按分搜索。
- 不要动：`main` 分支（落后，PR #6 未合）、未批准的付费事项。

---

## 四、做完怎么汇报

向用户汇报（中文，简短）：

1. **你搭了什么**（一两句话，说人话）；
2. **自检结果**（verify / audit 的数字；离线回放的关键数字）；
3. **你的预注册预测** + 下一步需要用户批准的事项。

然后停下等用户指示。
