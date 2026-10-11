# PREREG-v8（已冻结，2026-10-11，冻结于 t135 运行之前）

**冻结 ≠ 授权花费。** t135 的计划与预算登记于 `.cfb-runtime/traj/t135/plan.json`（预估与上界见 plan.md）。用户已授权"一直跑"。

## 0. 为什么需要 v8（题目缺陷，不是方法调参）
- t134（PREREG-v7，v2 题目）：hand 修好 10/12，raw 12/12；主指标 d(hand−raw) 均值 +0.42 轮，bootstrap 95% CI [−0.083, 1.083]；判定 **未区分**（hand 未超过 raw）。见 RESULTS §10.12。
- 归因线索：t134 中 24 条轨迹有 17 条去探查 `verify.mjs`。3 对 hand 慢于 raw 的样本（sse s1、sse s4、wm s4），**全部是 hand 探查了 verify.mjs 而 raw 没有**；两臂都探查或都不探查的对，轮数相同。
- 缺陷根因：v2 题目的 `package.json` 写 `"test": "node verify.mjs"`，但仓库里没有 verify.mjs；沙箱的 npm test 是 canned 输出（照跑 test/*.selftest.mjs 并打印 PASS），README 又说"npm test 跑 test/*.selftest.mjs"。两份说明互相矛盾，模型会为此绕路。这是**题目的客观错误**，与手写稿无关，也与真机任务无关。

## 1. 修复（运行前冻结）
- 新文件 `tools/traj-fixtures-v3.mjs`：从 v2 派生，仅对 wrong-model 与 sse-truncated 两题补上一个**真实可运行**的 `verify.mjs`（运行 test/*.selftest.mjs；与 canned npm test 输出格式一致）。其余 files / canned / fixed / prompt 与 v2 逐字相同。
- `tools/traj-fixtures.mjs`：新增环境变量开关 `CFB_FIXTURES=v3`；缺省仍为 v2，v2 的历史结果不变。
- 已检验：v3 的 sse-truncated 落盘后 `node verify.mjs` 退出码 0，输出 `PASS test/transport.selftest.mjs / 合计: 1 通过 / 0 失败`。
- **不降低标准**：判定规则、闸门、尺子的 fixed 谓词（oracle）、样本数与主指标均不变。修复只让题目声明的测试入口真实存在。

## 2. 设计（与 v7 相同，仅题目版本不同）
- 场景：sse-truncated、wrong-model，每场景 6 样本（共 12 对）；raw 与 hand 同窗新跑（不复用 t130、t134）。
- 手写稿：作者（我）在压缩轮按 v6+v7 闸门撰写，只能使用该轮原生输入中的内容；草稿撰写方法与 t134 相同，不因 t134 的结果修改。
- 草稿在运行前逐份通过 v6 闸门、v7 闸门（`audit-2026-10-11/v7-proposal/gate-v7.mjs`）与 check-spans。草稿被使用后不得修改。

## 3. 主指标与判定（与 PREREG-v7 §3 完全相同，不改）
- 每对 `rounds_to_fix`（未修好记 7）；配对差 d = hand − raw；bootstrap 10,000 次，种子 20261011。
- **「hand 超过 raw」**：均值 d < 0 且 95% CI 上界 < 0，且 hand 修好率 ≥ raw 修好率。
- **「hand 劣于 raw」**：CI 下界 > 0。其余为「未区分」。
- 分析脚本：`audit-2026-10-11/v7-proposal/analyze-t134.mjs`（只读，原样使用）。

## 4. 预先登记的检验（操纵检查与机制）
- **操纵检查 M1**：v3 下 verify.mjs 探查率（探查过 verify 相关命令的轨迹占比）应显著低于 t134 的 17/24。若 M1 不成立，说明修复无效，本次结论只能写「修复未生效」。
- **机制 M2**：统计两臂 hand−raw 配对中「仅 hand 探查 verify」的对数，与轮数差的关系只做描述（n 太小，不做检验）。
- 次指标：v6 主指标（第 r+1 轮 action 类别与首个命令意图的一致性）、prompt tokens 合计、修好后验收比例、声明相称。

## 5. 结论规则（预先写死）
- 若判定为「hand 超过 raw」：仅在 PREREG-v8 下成立，且仍须 n=12 的 CI 排除 0；不推广到真机，不推广到其它题目族。
- 若判定为「未区分」或「劣于」：如实报告；不因结果改判定、不删样本、不加样本、不改草稿方法。
- 任何「hand 超过 raw」的结论都需要在新的（未用于调参的）样本上复现，才能成为真机相关的证据。本轮 t135 不是独立复现集，因为草稿作者已见过 t134 的结果。

## 6. 不做什么
- 不修改 PREREG-v6、PREREG-v7 及其结论；t134 结果保持原样记录。
- 不删除或改写 t134 的轨迹与草稿。
- 不触碰教师文件（`cfb/.cfb-offline/teacher/v4-full.jsonl`）。
- 不把沙箱修好率解释为真机成功率。

## 7. 局限（预先写明）
- n=12，CI 宽；「未区分」是最可能的结论之一。
- 作者同时是草稿撰写者，且已知 t134 结果；此偏倚无法在本设计内消除，只能在报告中说明。
- 样本是 traj-fixtures 假仓库；题目缺陷修复只覆盖已发现的 verify.mjs 问题，未排查其它题目缺陷。
