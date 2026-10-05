# 金标注册表（v14.11 / 闭环 v4.6 模式 2 的标准）

每项 `<family>/<id>.json`（`cfb.gold/1`）= 一份**过了闸、主模型读后真修好**的助手手写稿，连同它压缩时看到的原文（`raw`）、上下文（`ctx`）、本轮调用、拼接后真正进历史的稿（`stored`）、闸门结果、该轨迹与同组 raw 臂的 L2 结局。

- 来源：`node tools/cfb-cycle.mjs gold add --plan N`（模式 1 单元 `plan-traj --arms raw,hand` 跑完、`ceiling --plan N` 之后）。
- 切分：按任务池的家族切分标 `dev` / `holdout`；holdout 金标只用于报告，不用于选策略，也不能进【风格样例】。
- **落盘后不改**：`plan-bench` 把每项的摘要（raw+ctx+draft）冻进计划，`bench-run` 发现摘要不符即 `gold-changed` 拒跑。要修正就新增一项、作废旧计划。
- **装置话术（越界）审计口径 v14.20.1**：定罪只看**作者自己写的主张**；整句、或「…」/`…` 定界引用里的片段若原样出现在 `raw ∪ ctx`，算「报告观测」⇒ 免检（记在 `qualityAudit.exempted[]`）。所以工具回显被程序抄进 `stored` 不再牵连整条数据。
- **被隔离 ≠ 报废**：`node tools/cfb-gold-repair.mjs audit` 复算隔离区 ⇒ 稿子本就干净的 `restore --id … --apply`（字节不变 ⇒ digest 不变 ⇒ 冻结计划仍可用）；真越界的改稿后 `replay`/`stage`（$0 复跑生产闸链 + 逐槽差归因），全绿才登记待真机复测，重跑完用 `gold add --plan N --replace` 换稿（旧条目自动归档 `transfer/gold-history/`）。
- 用法：`plan-bench --policies base,<候选>` → `tools/bench-run.mjs`（每项一次压缩调用 ≈ $0.0075）→ `bench-report`。指标 `draftDistance`（dd/2 口径见 `docs/TRAINING-AND-BENCHMARK.md` §3.1；公式版本一改，旧基准计划按 `metric-mismatch` 拒跑）。
- **天花板资格（2026-10-05 真机定）**：`gold add` 默认还拒收 `outcome.vsRaw === 'loss'` 的稿 —— 天花板稿至少要跟主模型自己读原文一样快；`--include-loss` 可强收。这类跳过不进隔离区（它不是越界），稿连同整单元结果落 `transfer/gold-repair/measured/` 继续当模式 2 素材。
- **标尺自洽**：每条 active 金标的稿对自己必须 `draftDistance(draft, draft) = 1.000`（`A41` 钉）。稿里出现原文与上下文都没有的锚点（哪怕是把 `ctx`、`raw` 这类工具词写进正文），会把这条天花板的上限钉死在 0.97 以下 —— 遇到这种判罚就改稿重挣，不许改标尺。
- **改稿 / 复测的手艺**：只照当轮 `pending` 的 `raw + ctx` 写；`node tools/hand-preflight.mjs <plan>` 在 $0 侧复跑 hand 臂闸链（G2 → lint → `compileV4Direct` → `birthOffline(gate)` → stored lint）后再花钱。注册表里允许存在本地微模型追不上的条目（`dd < 1`）：那是模式 2 的目标，不是金标的缺陷。
- 自测改道：`CFB_CYCLE_DIR=<dir>` 时注册表在 `<dir>/gold`，不碰这里。
