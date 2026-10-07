# 微生成数据 AI 单人 reviewer 审核记录（2026-10-07）

> **身份**：本记录由 Arena.ai Agent Mode 作为唯一 reviewer 完成，reviewer ID 为 `arena-agent-mode`。这是 AI 单人审核；没有第二位 reviewer，也没有独立人工复核。不得把它描述为人工审核或独立裁定。
>
> **范围与限制**：已逐条检查当前 17 条记录的 `ctx`、完整 reference draft、输入哈希/家族关系，并核对 raw 中支持或反驳关键“已改/已测”断言的工具历史。先前输出被截断的 `flaky-timeout-abc7c84a60543747` 本轮按 4 个有界片段重新读取完整 29,903 字符 raw；未发现 edit 工具回执或改后测试结果。此表是 **reference-draft 支持性/状态审查**，不是对原始 17 条逐条完成完整原子事实覆盖。后续另建的 16 个唯一 `raw+ctx` rewrite candidates 只标注支撑候选稿的关键事实 span，仍是 `sourceCoverage=partial`、`trainingEligible=false`，因此没有任何一条获准训练。
>
> **运行状态**：本轮未修改这些场景中的产品源码，也未调用模型/API、未训练、未对场景运行真实 CI。文内“现有记录显示”只指输入 transcript 内已有材料，不代表本工作区复现。

## 审核结论

- 17 条现有 reference drafts **全部暂不接纳为训练 gold**：有的把推测写成定因，有的把拟执行步骤写成已执行，有的错误地把改动落点限定在测试文件，还有一对相同 `raw+ctx` 配了不同目标。
- 这不表示 17 个输入都不可用。它们可以保留作已知开发家族的审核/改写候选，但原目标须改写或排除，并完成原子事实与来源 span 标注后才能导出。
- 当前 3 个家族 `flaky-timeout`、`perf-regression`、`sse-truncated` 都是既有 development 家族。不得为了填充 train 把它们移入 train；也不得拿它们冒充新 family blind set。

## 逐条 reference 处置

| caseId | 决定 | 单 AI reviewer 依据/问题 |
|---|---|---|
| `flaky-timeout-27ad98621b224ab9` | 改写，不接纳原稿 | 原稿把约 100ms 的时序窗口和调度影响提升为定因，并指定 `hedgeAfterMs=5000`。raw 有 1500/1600 与 `got≈1700` 的推理片段，但没有 2 核复现或该改动后的验收回执；`blocked ~1400–1700` / `we can't un-fire it` 不构成工具观察。 |
| `flaky-timeout-445555c31e8f51b1` | 改写，不接纳原稿 | 原稿说机理“坐实”，随后又列出两个未决方案并称探查结果待回。现有输入支持“100ms 裕量可能过紧”的假设，不支持把根因或修复口径说成已证实。 |
| `flaky-timeout-516ae841af7e4451` | 拒绝原稿 | 把 `test/helpers.mjs` 定为唯一落点并给出 `node verify.mjs` 验收；没有相应 edit 回执或改后运行输出。引用的“原文已自证”是模型推理，不是独立工具证据。 |
| `flaky-timeout-618b42a02b6aa205` | 拒绝原稿 | 与短稿模板相同；由 `got≈1700` 推到 helpers-only 改法，未给源文件改动或新鲜复测证据。 |
| `flaky-timeout-abc7c84a60543747` | 拒绝原稿 | 完整 raw 只有诊断推理与拟议参数，没有 edit 工具调用、测试 helpers 修改或改后测试输出；不能把“决定改 helpers”当作已落定事实。 |
| `flaky-timeout-b79f3481defb4912` | 拒绝原稿 | 同一短稿声称 timer/`primarySettled` 状态后，直接指定 helpers 与 `node verify.mjs`，没有执行或验收证据。 |
| `flaky-timeout-f008aed867a41545` | 拒绝原稿 | 同上；目标压缩掉了不确定性与证据状态，并把计划写成唯一改法。 |
| `perf-regression-1b5bf68718d1be80` | 改写；与下一条冲突 | 同一输入哈希 `81467a41d7ee4b81ee87214eeb0d8537bcec8b34de821a872248163698b1dec0` 被配成另一条不同 target。原稿把长度目标回滚写成确定改法，但同一输入里 `analyze-trace` 脚本口径/最近样本输出还待确认，也无回滚后 trace。 |
| `perf-regression-b658aaee22057ecf` | 改写；与上一条冲突 | 同输入异目标；原稿虽保留字段口径和 `birthFinishWaitMs` 未解，却又称回滚决定已定。不得从两份候选中任选一份充当金标。 |
| `perf-regression-bf171c05465d1bab` | 拒绝原稿 | 把 450→1800、字符/时延数字链说成因果定论，并建议改配置后只 `cat` 验收；raw 未显示配置改动或改后 trace。历史 `cat`/统计数字也不能替代回归验证。 |
| `perf-regression-c5a46f633a734bab` | 改写，不接纳原稿 | 表述较像“建议回滚”，但把“原文落定”当依据；它自己仍要求后续 trace 验收。可重写为明确的候选假设与待验证动作，不可作为已验证修复摘要。 |
| `sse-truncated-2c6c7d60c10b5d86` | 拒绝原稿 | “只认真实 `finish_reason`”方向可能正确，但 target 把落点写成 `transport.selftest.mjs`，未覆盖需要核对/修改的 `src/transport.js` 逻辑；没有改后结果。 |
| `sse-truncated-36a50e856e426f8e` | 拒绝原稿 | 同上，误把生产逻辑修复缩成测试文件修改，并以未显示的新结果作为验收条件。 |
| `sse-truncated-8b948358cca4b9e7` | 拒绝原稿 | 点出 `[DONE]` 不应伪造 `stop`，但落点仍写成测试文件；其 raw 还留有 `out.length>0` 兜底是否影响 settle 的疑问，未完成端到端验证。 |
| `sse-truncated-95fd0d6633ab9b19` | 拒绝原稿 | 指出 `out.length>0` 也不能单独判成功，但落点仍只写测试文件；缺生产实现修改和回放验证。 |
| `sse-truncated-9cf468008d803a3a` | 改写，不接纳原稿 | 对真实结束信号的要求较清楚，但只提出 `transport.js` 的拟议改法；`npm test` 绿灯本身不能证明截断回放或 passthrough 验收通过。 |
| `sse-truncated-ab9f32022400104e` | 拒绝原稿 | context 里的历史回放是旧结果 `ok:true, finish:"stop", outputChars:212`。raw 后续只有分析和拟做改动，没有两条实际 edit 回执或改后 replay；target 却称“本轮直接发了两条 edit_file”。这是明确的状态误报。 |

## 训练处置与家族隔离

1. 原始 17 行队列继续保留为审核来源，不把原 draft 当作 gold；逐条机器可读决定见 `transfer/models/micro-generator-ai-review-dispositions.jsonl`。
2. 针对 **16 个唯一 raw+ctx 输入**，已写出同一 AI 会话起草并复核的保守 dev-only rewrite candidates，见 `transfer/models/micro-generator-ai-reviewed-dev-candidates.jsonl`。它们只标注支撑新 draft 的关键事实，`sourceCoverage=partial`、`trainingEligible=false`，因此是可继续审阅的候选，不是已认证 gold 或训练数据。
3. 两条 `perf-regression` 原始输入相同、目标不同：两份原目标均拒绝；现在只有一个共用 canonical rewrite candidate，原队列冲突不会被静默抹掉，也不会任选旧稿。
4. 当前三家族均保持 `dev` 身份，不移入 train。原始 QMSum 与 `etri/QMSum_SummaryEvidence` 均只作来源筛选，不并入 CFB 训练；后者虽有句级 CES/PES 支持证据，但 checked files 不含完整 transcript，使用 target-conditioned evidence 会改变任务。SWE 轨迹来源也没有现成 summary targets，需另行许可/家族筛查和 AI 单人目标审查。
5. 本地家族与源文件盘点见 `docs/MICRO-GENERATOR-FAMILY-INVENTORY-2026-10-07.md`：没有新的、可直接用作 `raw + ctx -> draft` 的已审核 train 家族。当前仍无合格 CFB train/dev 组合，也没有为此生成任务登记的新家族 blind set。AI single reviewer 政策不会自动把未审内容变成训练数据。

相关细节见 `docs/MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md`。

## 2026-10-07 Open-SWE target-model compatibility stop

另筛取并单 AI 审核了 6 条固定 revision 的 Open-SWE-Traces 轨迹；逐条 facts、source spans 和 reference claims 见 `transfer/models/micro-generator-open-swe-seed/annotations.jsonl`，源行与复核限制见 `docs/MICRO-GENERATOR-OPEN-SWE-SEED-2026-10-07.md`。这 6 条的教师模型全部为 Qwen3.8-27B，harness 为 mini-swe-agent，而项目指定目标是 DeepSeek-V4.1-Flash。虽然来源行哈希已核对，且摘要保留了测试失败、跳过和任务边界冲突，这仍不足以把它们当作目标模型思维轨迹或目标域监督。故 6 条全部标为 `finalSplit=null`、`trainingEligible=false`，只作标注流程探索；未声称迁移有效，也未调用目标模型 API。此处审核仍是 `AI single reviewer`，没有人工或第二 reviewer。