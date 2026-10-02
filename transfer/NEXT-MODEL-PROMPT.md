# 给下一个模型的开工提示词（整份粘贴，不要删改）

你是接手 **cfb** 项目的模型。仓库 `github.com/liaocr/cfb`，当前工作分支 **`arena/01a0f127-cfb`**。**只用中文回复。**

> **本节于 2026-10-01（v13.6.0）更新，覆盖下方原始正文里过时的路径与任务描述。** 以本节为准，正文仅作背景。

## 零、先读这段（最新的、必须知道的）

0. **v14.2（2026-10-02）闭环 v2 已落地，先读 `docs/design/CLOSED-LOOP-V2.md`。** 旧的 `cfb-cycle run` / `scoreCandidates` / `activeSelect` / `feedback` 流程已被替换：
   现行环是 `node tools/cfb-cycle.mjs plan`（零 API，成稿 → 离线裁决 → 冻结 v9 计划 → 停）→ 人批准 → `node tools/effect-ready.mjs run --live --v9 --round N`（唯一花钱）→ `cfb-cycle ingest --round N` → adopt 改 champion → `propose` 出生产 diff。
   用户预算只有**几美元**：一轮实付 ≈ USD 0.13 / 预占 0.50；**任何花钱前先给用户看 `plan` 打印的预占 / 实付 / 每 bit 价并等批准**。评委 LLM 不再是选择信号；没有长度杠杆；`bind=off` 是惰性杠杆。
   自测 `test/closed-loop.selftest.mjs`；加杠杆照 CLOSED-LOOP-V2.md §7。**v9 一轮都没实跑，不要把模拟当结果。**

1. **最重要的一条**：v13.4.0/v13.5.0 的核心前提「a6api 中转全部路由丢弃历史 reasoning_content」**已被推翻**。
   真实原因是聚合站 a6api 内**某个商户（上游）行为异常**；a6api 是低价聚合站、内含很多商户、**可随时切换**。
   换掉故障商户后 canary 立即恢复拼接（`Δprompt(1000字−1字)=539`、剂量-反应严格线性）。
   **教训（写进纪律）：单点/单商户失败不足以证明通道级不变式。** 细节见 `CHANGELOG.md` v13.6.0 与
   `docs/analysis/LIVE-VISIBLE-2026-10-01.md` 顶部的更正块。
2. **生产里 cfb 真正做的事**是「把压缩稿写回 reasoning 位」——即 v1/v8 协议（`chat-completions-history-reasoning/1`）。
   v3–v7 测的「可见协议」建立在一个**当时并不存在**的场景上。v2–v7 的收据/判据/结论按原样封存、不改分、不追溯。
3. **claimOfV3 已落地**（`tools/effect-mr.mjs`）：让步/意图/拉丁前缀/否认四类守卫。v7 报告的 5 例伪阳性 5/5 不再误判，
   5 例真阳性 5/5 保留。回归在 `test/eval-reasoning-v8.selftest.mjs`（12 项，全过）。
4. **v8 协议已就绪、但尚未实跑**：`buildReasoningReplayPlanV8`（`cfb.bounded-ab/8`、
   scope `cfb.history-reasoning-revalidation.2026-10-01`、claimVersion 3、12 主 + 3 探针、预留 ≈USD 0.4515）。
   跑法：`node tools/effect-ready.mjs prepare --v8 --profile eval-profile.json` → `doctor` → `run --live`。
5. **实跑前必做三件事**（v8 尝试时全部踩过）：
   - **逐次 canary**：`node tools/channel-check.mjs --base-url https://a6api.com/v1 --model deepseek-v4.1-flash`。
     商户不稳定，几分钟内即可能变；**canary 不稳就别开 v8**（别在漂移的通道上做对照）。
   - **型号回显**：a6api 接受点号写法但**回显连字符**（`deepseek-v4.1-flash` → `deepseek-v4-1-flash`），
     直接请求连字符是 400。已在 profile 用**显式声明的 `modelAliases`** 处理（`eval-profile.json`），
     身份闸仍是硬闸：未声明别名 / 近似但不同型号 / 缺 model 一律拒（有单测）。
   - **定价**：`eval-profile.json` 已按用户给的价填好（输入 $1/M、输出 $4/M、缓存 $0.02/M；缓存费率项目 schema 不建模，仅备注）。
6. **环境坑**（每轮复发）：Windows 下 3 个平台门槛失败（2 个需 `symlink` 权限、1 个需 Linux `/proc/net/route`），
   与本项目逻辑无关、改动前即如此；全量断网自检的标准入口 `tools/verify-offline.mjs` 是 **Linux 专有**。

---

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
