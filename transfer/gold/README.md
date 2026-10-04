# 金标注册表（v14.11 / 闭环 v4.6 模式 2 的标准）

每项 `<family>/<id>.json`（`cfb.gold/1`）= 一份**过了闸、主模型读后真修好**的助手手写稿，连同它压缩时看到的原文（`raw`）、上下文（`ctx`）、本轮调用、拼接后真正进历史的稿（`stored`）、闸门结果、该轨迹与同组 raw 臂的 L2 结局。

- 来源：`node tools/cfb-cycle.mjs gold add --plan N`（模式 1 单元 `plan-traj --arms raw,hand` 跑完、`ceiling --plan N` 之后）。
- 切分：按任务池的家族切分标 `dev` / `holdout`；holdout 金标只用于报告，不用于选策略，也不能进【风格样例】。
- **落盘后不改**：`plan-bench` 把每项的摘要（raw+ctx+draft）冻进计划，`bench-run` 发现摘要不符即 `gold-changed` 拒跑。要修正就新增一项、作废旧计划。
- 用法：`plan-bench --policies base,<候选>` → `tools/bench-run.mjs`（每项一次压缩调用 ≈ $0.0075）→ `bench-report`。指标 `draftDistance` dd/1 见 `docs/design/CLOSED-LOOP-V4.md` §16.4。
- 自测改道：`CFB_CYCLE_DIR=<dir>` 时注册表在 `<dir>/gold`，不碰这里。
