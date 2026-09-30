# 给下一个模型的开工提示词（可直接整份粘贴）

---

你是接手 **cfb** 项目的模型。工作目录 `/home/user/cfb`，仓库 `github.com/liaocr/cfb`，当前分支 `arena/01a0eba2-cfb` @ `25688d2`。**只用中文回复。**

## 一、开工第一步（不要跳过）

1. 依次读这四份文件，读完再动任何代码：
   - `transfer/LIVE-MEMORY.md`（工作记忆；**每次上下文被压缩后第一时间重读它**）
   - `docs/analysis/HANDOFF-2026-09-30.md`（交接总览，含全部约束与迁移清单）
   - `docs/analysis/BREAKTHROUGH-4-REPRESENTATION-2026-09-30.md`（最新、最重要的结论）
   - `docs/analysis/CAPABILITY-BREAKTHROUGH-3-2026-09-30.md`（三族突破与硬反证）
2. 自检：`cd /home/user/cfb && git status -sb`（应干净）+ `node manifest.mjs && node verify.mjs`（应全过；有跳过项属正常）。
3. 若自检失败：把失败的套件/输出贴出来，先修再开工，不要绕过。

## 二、项目是什么（30 秒版）

cfb 是压缩器：把主模型的长轨迹压成一份中文稿 → 再喂给主模型续写。
- 单步：`compileV4Direct`（`src/compile-v4.js`）+ 闸门 `birthAccept`。
- 多轮：`buildCompressCtx`（`src/messages.js`，含【台账】）→ 副模型出稿 → `spliceProgramParts` 拼程序部件（延续段 / 验收条款 / 收工三问）→ 写回。
- 生产挂钩：`birthTransform` / `birthFinish`（`src/birth.js`）。
- 当前版本 v12.9.2 = 多轮 **v4d9**；效果（run4，judge median-of-3）：red raw 4.9 → **v4d9 8.0**（手写上限 8.9）；flaky 一格仍是 3.0→5.0 未解。

## 三、已知结论（别重走）

- 九版"改文字"的收益已到边界：**制品是散文、不可机器检查** ⇒ 没有评估器/档案/回滚/验证预算。
- 端到端成功 S=Πp_i：任一因子≈0 时其余改进的导数≈0 —— 这就是"反复修改、有限且零碎"的机制。
- 两条硬反证：**LLM 自写技能/自写测试增益≈0**（人写/独立验证才有增益）；技能库无卫生管理会腐烂（0.26 vs 0.58，1/5 技能有害）。
- 因此突破 = **换被优化的对象**：从"散文"换成"可机器检查的制品"。

## 四、你现在被批准做的事（R1 → R4，全部零模型调用、零费用、可回滚）

按顺序实现，每步都要：**补自测 → `node manifest.mjs` → `node verify.mjs` → 小步提交（中文提交信息，说清"为什么"）**；旧路径必须保留，新路径只在通过检查时启用。

- **R1 制品即程序**：每轮产出附带类型化步骤 `{前置条件, 动作, 期望观测, 检查命令}`；宿主执行检查，通过才允许进入下一步；散文降级为说明。
  - 落点建议：`src/compile-v4.js`（渲染侧）+ 新工具（例如 `tools/check-steps.mjs`）做宿主侧执行器；纯函数、可单测、无网络。
  - 验收：对 `transfer/mr/auto-d2*.json`、`transfer/mr/run4/results.jsonl` 里已有的稿做**零成本**回放：步骤可解析率、检查可执行率、通过率；不允许改变旧路径输出。
- **R2 主动查询**（R1 稳定后再做）：检查失败时系统自选下一个检查（取期望信息增益最大者）。
- **R3 签名档案**：每条新增规则/事实/疫苗记录**逐项符号效果 + 留出门**；不过门进拒绝缓冲、可退役。
- **R4 回滚是一等公民**：每轮前对"制品 + 宿主状态"打检查点；可回到上一个通过检查的状态再走另一条路（宿主侧实现，git 之外的一层）。

**先写下可证伪预测（重要）**：R1/R4 落地后，涨幅应集中在 **flaky**；**wrong-model（9.0）与 eacces（8.5）几乎不该变**。若那两格反而涨 >1 分，说明因子分解有误——回去重做归因，不要庆祝。

## 五、红线（违反即前功尽弃）

- 回复中文；**少测、少花钱**；自主推进，不要反复问用户；但**任何付费实跑方案必须先报用户批准**。
- 密钥 `/home/user/.secrets/keys.env`：**永不打印、永不提交**；用 `set -a && source … && set +a` 加载。
- git 作者 `cfb-cleanup <cleanup@local>`；**只允许快进推送**，推送形式：
  `git push https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git HEAD:arena/01a0eba2-cfb`
- 改闸门前先跑 `node tools/audit-noninferiority.mjs`（零调用）并保持 N1–N7 全零。
- 任何给模型的东西**在任何情况下都必须是优化、不能变差**；不做抽取式、不保留"原文尾巴"；不加第 N 条 K 规则；不把稿压更短；不把评委 Likert 当信号。
- 评委也是 DeepSeek 系且贵：缺省 1 票 + 条件补票；禁止批量重判。
- 未批事项（不要碰）：run5（v4d9 vs 原始）、方向 3（K7–K11 / 程序比差）、S0 留出任务族的实跑、一切付费评测。
- 维护 `transfer/LIVE-MEMORY.md`：只写结论与坑，不写垃圾；每轮结束追加一行摘要。

## 六、常用命令

```bash
cd /home/user/cfb
node manifest.mjs && node verify.mjs                       # 提交前必跑
node tools/audit-noninferiority.mjs                        # 非劣性审计（零调用）
node tools/compile-mr.mjs                                  # 多轮 ctx / 形态检查
# ⚠ tools/effect-mr.mjs 没有 --run <dir> 形式（会报未知参数）；看表读 transfer/mr/run4/summary.md
```

## 七、风格

先归因（理论问题还是实现问题）再动手；理论问题改理论、实现问题直接改；小而准的改动优先；提交要小而清晰；每次改动都能被零成本审计复现。用户要的是**突破**，不是补丁。

读完这四份文件、跑完自检后，请用三句话向用户汇报：现状确认、你打算先做哪一步、预计产出什么，然后直接开工。
