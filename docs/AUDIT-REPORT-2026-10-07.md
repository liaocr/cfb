# 全仓深度审计报告（2026-10-07）

> **本报告只陈述当前 checkout 可复核的事实。**审计基线：`main`，本轮执行 `git fetch --prune origin main` 后，`HEAD = origin/main = 7a5a863`，版本 `14.25.4`。以下工作区修改尚未提交、未推送；本报告不代表发布或官方 benchmark 认证。

## 1. 结论摘要

- **生产 champion 仍是 `base`。**本轮预筛第一名 `p-1490eefcdf` 不能晋升：它在 L1 的当前预筛领先，但在已落盘的 L2 汇总中 `policy` 臂只有 `1/24（4.2%）` 严苛修好。不得用 L1 排名替代端到端收益。
- **没有产生新的随机化盲测或付费模型实验。**`npm run bench` 是对本仓已有轨迹与预筛数据的零 API 汇总；它不是独立样本随机试验。下文数字因此属于“当前命令对当前资产的输出”，不是新采样证据。
- **多组旧结论不能直接互相比较。**L1 预筛池、L2 在盘轨迹、A39 冻结集、模式 2 的不同 benchmark 计划，分母与任务构成不同。`8/8、482 tok、Oracle 0.908、真值分 0.781` 等旧读数与本轮 `npm run bench` 不一致；具体口径映射尚未证明，报告保留为不同快照，不强行合并。
- **STATUS 文件是历史快照，不是当前状态错误。**[`STATUS-2026-10-07.md`](STATUS-2026-10-07.md) 明确基于提交 `8c918cc`；当前基线后来前进到 `7a5a863`。按要求未改写快照，只在目录索引与本报告说明新旧边界。
- **探针历史读数尚不可复现。**当前 `universal_bench.mjs` 直接运行即因 `/home/user/cfb/...` 绝对路径失败；多个 random 对照无种子。探针资产 README 已改标历史快照，不把它们算成当前实测。

## 2. 本轮可复核的当前读数

| 来源 | 本轮输出 | 正确解释 |
|---|---|---|
| `npm run bench` · L2 | `raw n=80`、`auto n=7`、`ledger n=6`。`auto` 严苛解决率 `85.7%`、伪修好 `0%`、`pass@1=0.889`、`pass^2=0.778`、平均 `4.86` 轮（相对 raw `−24.9%`）、思维链字符 `−27.4%`；Elo `1104`，95% CI `[945,1279]`。 | 在盘轨迹描述统计；样本数不是独立随机样本量，CI 覆盖 raw 锚点 `1000`，不足以宣称稳赢。`ledger` 伪修好 `16.7%`。 |
| `npm run bench` · L1 | `p-1490eefcdf`：金标 `12/13`、净省 `431 tok`、`dd=0.724`；当前池 `4/4` 题、`9/9` 轮、均省 `1111 tok`、Oracle `dd=0.831`、真值分 `0.696`、AA 密度效率 `0.6473`。 | 是本次预筛榜首，不是 champion。其 L2 `policy` 臂 `1/24`，故不采纳。 |
| `npm run cycle` | champion `base`；飞轮 `93/93`；CPU ranker LOO-CV `0.763`；尺子效度 `suspect (n=304)`。 | 闭环内部读数；LOO-CV 与飞轮通过数不等于外部泛化验证。 |
| Gold 与 attest | `transfer/gold/` 13 条：`4 gold / 9 not-gold`；`gold-score --dedup`：19 个唯一 id，`4 gold / 15 not-gold`；attest 处理 23 条，`4 gold / 19 not-gold`，过期章 `0`。 | 当前代码与当前台账的输出。R2 `n<2` 按失败处理：`not-gold`，不再把已测不足样本误写成 provisional。 |
| 微模型 | 入库完整报告时间 `2026-10-04T13:57:17Z`；`accepted=false`、`promoted=false`；新独立家族测试门未通过。最终测试台账只有 `case-fold-collision` 一条，状态 `evaluated-below-90-percent-gates`（unit `0.8333`，draft `0`）。 | 一次性盲测已经消费，禁止重跑刷分。06g 折报告/候选权重未入库，不能独立复算或据快照晋升。 |

`npm run bench` 输出沿用了 SWE-bench、TAU-bench、Arena Elo、AA 等名称，但它们在这里是**本地借鉴的指标变体**，不是官方测试集、正式参测成绩或认证。命令行记分卡标题已改成“本地代理评测”。

## 3. 已实施的代码、测试与文档修复

1. **出生闸门 fail-closed。**[`src/birth.js`](../src/birth.js) 过去把标识符扫描异常当作 `invented=[]`，可能将“无法核验”误判成安全。现在扫描器抛错、缺失或返回非数组均给出 `identifier-check-error`，由生产收网路径原文放行；新增 T36/T37 故障注入测试。
2. **金标 R2 语义统一。**[`tools/helpers/gold-standard.mjs`](../tools/helpers/gold-standard.mjs)、[`GOLD-STANDARD.md`](GOLD-STANDARD.md) 和自测一致规定 `n<2 ⇒ not-gold`；诊断文字展示实际 `n`，新增 `n=0` 例，避免零样本仍被写成 `n=1`。
3. **测试夹具隔离外部状态。**v3 闭环测试显式只使用冻结内置池；A39 测试在临时 cycle 目录运行，只复制需要的策略/飞轮输入，结束后恢复目录并清理；保留其原有隔离周期目录做法。微模型数据集构建测试改写临时输出，不再只为刷新时间戳重写跟踪快照。`manifest-ignore` 使用 `git check-ignore --no-index`，正确验证即使被强制跟踪的路径是否仍匹配忽略规则。
4. **新增文档水位记账工具。**[`tools/doc-watermark.mjs`](../tools/doc-watermark.mjs) 与自测锁定 package/CHANGELOG/活动文档版本、水位区块、代码锚点及自测回执；`--record` 要求在线和隔离两条测试车道都通过，否则拒绝记账并恢复。本轮第一次记账确实被 README §5 的微模型四个历史数值/台账引用断言拦下；恢复带来源说明的历史数后再记账成功，说明文档数字并非可随意删改而不影响证据链。
5. **文档边界与评测命名修正。**README/HANDOFF 当前数值按本轮 CLI 输出更新；v14.20 训练指南、EVIDENCE 设计稿、探针报告均标出历史/新鲜度边界。CHANGELOG 保留历史事实，只把当前树不存在的 9 个旧报告链接改为可搜索的原路径文本；理论文档的 `[n](url)` 示例改为代码文本。文档索引中错误拼接的 `--record && --write` 也改为工具实际支持的两个互斥模式说明。CLI 记分卡和对应测试名改为“本地代理评测”，不再暗示正式 benchmark 成绩。

## 4. 根因：结论为什么看起来反复变化

1. **“当前正文”没有一致的新鲜度协议。**版本号、benchmark 数字、报告摘要手工散落在 README、HANDOFF、CHANGELOG、STATUS 与专题文档；有的章节是当前输出，有的只是当时快照。文档水位工具现在校验版本/结构/回执，但**不会自动证明任意业务数字正确**，所以每个数仍必须标来源、日期与复跑命令。
2. **不同数据池被当成同一条排行榜。**`npm run bench` 的 L2/L1、A39 冻结夹具、金标注册表和微模型盲测不是同一分母。样本池一变，数值变化可能完全合理；没有输入哈希/计划 id/口径对应关系就不能拼成“进步/退步”曲线。
3. **测试曾受 ambient 本地状态影响。**闭环测试自动加载本地离线任务/策略、cycle 目录或微模型快照，会让同一套件在不同状态下改变题数、输出或文件时间戳。本轮已隔离关键测试，但 CLI 读取在盘资产仍是其设计行为，报告必须注明资产来源。
4. **实验资产不自包含。**通用压缩器探针有绝对路径、未固定随机对照、部分旧报告/输入未入库；微模型 06g 缺折级产物。留下一个汇总数字而没有数据、权重、版本、切分哈希与种子，无法形成可复核结论。
5. **本地 proxy 被写成外部官方成绩。**记分卡引用外部 benchmark 名称，但使用本仓自有任务、规则和变换。现在统一称“本地代理评测”，不再把指标借鉴包装成官方参测。
6. **判据说明与代码漂移。**典型例子是 R2：旧文把 `n=1` 写成 provisional，实际轴值已失败；现已统一为 `not-gold` 并增加零样本测试。

## 5. 复验记录

- `git fetch --prune origin main`：成功；`HEAD = origin/main = 7a5a863`。
- `npm run watermark:record`：在线 `41/41` 套件、`1225 passed / 0 failed / 2 skipped`；隔离 `41/41` 套件、`1226 passed / 0 failed / 1 skipped`。skip 是运行环境/隔离边界的既定 skip，不是失败；回执时间为 UTC。
- `npm run verify:offline`：通过；边界报告 `linux-user-network-namespace`、仅 `lo` 接口、`externalRoutes=0`、`externalApiCalls=0`；41 套件 `1226/0/1`。后续非劣性审计 267 份稿的 N1–N7 均为 0。
- `node test/doc-watermark.selftest.mjs`：`6/6`；`node verify.mjs gold-standard`：`82/82`；`node test/micro-general-arm.selftest.mjs`：`10/10`。
- `npm run bench`、`npm run cycle`：成功，读数见 §2；`node tools/gold-attest.mjs --check`：23 条处理、0 过期章。
- 探针复跑：`node transfer/probes-2026-10-07/universal_bench.mjs` **按预期失败**，Node 报缺失 `/home/user/cfb/src/compile-v5-local.js`；不是自测回归，而是探针不可移植的直接证据。

## 6. 仍未解决与建议顺序

1. **不晋升候选。**先保持 `base`。如要评估 `p-1490eefcdf`，须预注册新 L2 计划、匹配的 raw/control、独立新家族、固定预算与盲评；不能从 L1 预筛结果直接晋升。
2. **恢复或重做 06g 证据。**最低限度要有每折输入/切分/标签哈希、每折报告、候选权重摘要和完整评测命令；找不回时应标记“不可复算”，而不是从快照推算。
3. **为探针另建复跑版，不覆盖历史文件。**把路径改为相对 `import.meta.url`/仓库根解析，random 基线用有种子的 Fisher–Yates，记录 seed、Node 版本、corpus 哈希和逐题输出；特别复查 math oracle 上通用选择器历史读数低于 random 的问题，再决定是否继续。
4. **保持历史记录只读。**`STATUS-2026-10-07.md` 的 `8c918cc`、微模型一次性盲测及 `transfer/probes` 原表都不回写；若恢复了原始材料，新增带日期的复算报告并链接，不替换旧快照。
5. **明确 MANIFEST 的范围。**`manifest.mjs` 按 `.gitignore` 计算交付树，故有意排除 `.cfb-runtime/`、`.cfb-offline/` 等忽略目录，即使其中部分资产被 Git 强制跟踪也一样；它不是全 Git 跟踪树校验。详见 [`manifest.mjs`](../manifest.mjs) 的范围注释。
6. **仍缺真实宿主/外部效度验证。**本轮没有连接 Cordis/DSH 真实宿主，没有付费 API 试验，也没有参加外部官方 benchmark；隔离自测不能替代这些验证。

## 7. 稳定决策

- `transfer/watermark.json` 的 `generatedAt=2026-10-06` 是 UTC 日期；回执 `at=2026-10-06T19:46:03Z` / `19:46:39Z` 转为本地时间已是 2026-10-07，**不是日期错误，不改 UTC 字段**。
- 在线车道的 2 个 skip 及离线车道的 1 个 skip 作为环境/隔离边界记录；不把 skip 计作失败，也不删掉真实 skip。
- `docs/STATUS-2026-10-07.md` 是 `8c918cc` 历史快照，保持不动；A39 临时周期目录隔离保持不动；`git status` 对未跟踪且被忽略的生成物不显示是预期行为，不作为漏报缺陷。
- 完整本地链接扫描（忽略 fenced/inline code 样例）覆盖 504 份 Markdown、46 个本地文件链接，缺失目标 `0`。`npm run manifest:check`：628 个文件，漂移/新增 `0`，缺失 `0`；`npm run watermark:check`、`git diff --check` 与改动脚本的 `node --check` 均通过。
- 工作区仍未提交、未推送。
