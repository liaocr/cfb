# CFB：出生时思考稿压缩（v14.25.4 基线，参考稿优先闭环）

> **当前事实：生成式学生还没有晋级，冻结 v9 尺子无效，没有已准入训练集。**
> 用户质疑现有数据后，已推进完整开发审查、来源/读回观测与正式准入链；不是把旧选句器换名成 LM 或立刻开始训练。权威状态见 [PROJECT.json](PROJECT.json)，路线见 [PROJECT-PLAN](docs/PROJECT-PLAN.md)，本轮实施见 [continuation programme](docs/CONTINUATION-PROGRAM-2026-10-12.md)，上一阶段见 [审计报告](docs/AUDIT-2026-10-11.md)。

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
> **当前版本：v14.25.4** · **插件核心零第三方运行依赖**（Node.js ≥ 20；审计自测另需 Git/Python，训练有额外依赖）
> **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**
> · 验收口径 `npm run verify:offline`（真断网 Linux 命名空间）：47/47 套件通过 · `1432 通过 / 0 失败 / 2 跳过`
> · 快速自检 `npm test`（联网机上跑，需要隔离的那条断言按设计跳过）：47/47 套件通过 · `1431 通过 / 0 失败 / 3 跳过`
> 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。
> **规模**：`src/` 25 个零依赖模块 · `tools/` 73 个脚本 + 31 个 helpers · `test/` 47 套自测 · `transfer/gold/` 13 条（4 个家族）
<!-- watermark:end -->

水位只表示所执行的技术自测。稀疏未下载项、真实宿主、GPU 和 CPU 模型推理分别记账；不能由全绿推导普遍语义“不退步”。

## 1. 唯一目标与路线

出生时 `raw + ctx` → **小型生成式语言模型**输出更短、供原目标模型后续读回的思考稿。不是抽取句子、五家族模板或进度摘要。任意 CoT 是覆盖目标，不承诺每条输入都能更短且无损；不可净省、越界或不确定时回退原文。

只推进**预训练底座 SFT**这一条路线。首个候选 `fla-hub/rwkv7-0.1B-g1` 钉在 `7450ee04eb9c66baa7161b7a5c0fe09e5b2817d8`，实际 **191,034,624 参数**，仍是未晋级候选。先固定任务/资源和真实读回，证明高质量参考稿有用，再建立有效尺子与覆盖监督，验证底座能力/CPU 后才考虑获批诊断训练。便宜硬预检可并行，不替代参考效用；当前 CPU/分词/EOS/模板/窗口尚未运行。LoRA 是否适用要另测；不并行打开 DPO、从零训、多个底座。

首期 source/receiver 按现有政策为 DeepSeek-V4.1-Flash；off-target 料不得默认混入。JS `compileV5Local` 为历史特征排序＋模板渲染兼容 API，**不是生成式 LM**；默认 `compressLocalModel:false`。`src/` 目前没有 RWKV 生产推理接入。

## 2. 安全入口

无需 npm install；插件核心使用 Node 内置模块。审计/自测还使用 Git 与 Python（建议 ≥3.10）；真实宿主及未来训练另有依赖。

```bash
node tools/project.mjs scope-restore     # 仅当快照丢失Git稀疏配置；核对既有ledger/索引，不下载/改正文
node tools/project.mjs doctor            # 状态口径检查；成功不表示模型就绪
node tools/project.mjs readiness         # 当前预期 exit 2：模型未就绪
node tools/project.mjs plan              # 唯一实施路线，不自动执行
node tools/micro-generator/program.mjs status
node tools/micro-generator/reader-study.mjs plan  # 当前 blocked，无live execute
node tools/micro-generator/formal-sft.mjs --out NEW_DIRECTORY # 当前exit2，无train/dev
node tools/project.mjs audit --json --out NEW_REPORT.json
node verify.mjs
node tools/verify-offline.mjs             # Linux 真隔离：无外部网络路由，不仅是禁用 API key
node manifest.mjs --check --sparse        # 本次已物化范围，不是完整资产验收
```

本轮 128 MB 工作区为稀疏检出：原快照 1,853 路径，1,843 已物化、10 排除。排除见 [checkout-scope.json](transfer/audit-2026-10-11/checkout-scope.json)。严格 `node manifest.mjs --check` 对稀疏缺失仍报失败；生成默认也拒绝静默删项。显式 `--sparse` 保留未下载项旧 hash，**不声称核验了那些字节**。

未来训练前的 `train_rwkv7.py --preflight-only` 是本地检查，不导入 torch、不下载底座。Kaggle launcher 默认只准备 hash-bound bundle，无凭据/网络/GPU；发布需另获批准并显式 `--execute`。当前不要执行训练、付费读回、一次性盲测或远端 push。

旧 `cfb-cycle` 等工具保留作兼容/历史复核，不再支配当前 next。`npm run restore` / `snapshot` 已从默认恢复流程停用，旧训练导出 `train:export` 也失败关闭，旧功能仅留显式 legacy 别名；不能用它们覆盖不可再生材料。

## 3. 证据和数据分桶

| 内容 | 当前用途 |
|---|---|
| 冻结 v9、旧轨迹/收据、已核验归档 | 证据；可重复不等于质量正确 |
| 未完整审查教师池、规则样例、旧训练料 | 研究；不能默认 SFT |
| 终态冲突、raw 重标、未经审查改稿、off-target | 隔离；不能最后行胜出或按时间制造偏好 |
| 排除大制品、固定 main 可找回但未物化资产 | 范围外；保留元数据，不叫永久丢失 |

**新开发产物，不是训练/质量成绩**：42 registry 记录归并22个输入/9家族/0准入；三个完整 AI 开发稿74源事实/20断言（单AI、人0、二审0，已曝光），30显式标签对照只证明管线；9事件读回仅fixture；最少9续行臂的真实计划因版本/状态/预算缺失而blocked。完整记录在 [programme目录](transfer/program-2026-10-12/)，协议NOT_VALIDATED、原reader效用未测。

完整路径与工具角色见 [文档索引](docs/README.md) 和 [FILE-INDEX.json](transfer/audit-2026-10-11/FILE-INDEX.json)。历史文档的“当前/唯一/已达标”只属于当时陈述，不优先于本入口和实际证据。

`.cfb-offline` **不全可再生**：含已付费教师、审查及来源记录。`.cfb-runtime` 也有已入库的不可再生轨迹；不要按目录名一把删掉。模型大权重仍不应放入本次工作区。

## 4. 生产兼容层与保障边界

现有 `index.js → src/plugin.js → birth/distill` 保留，供后续学生接入与技术回归。远程副模型路径属于现有兼容功能，不是另一条并行小模型训练路线。

### 4.1 六道收网门（源码同源渲染）

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
1. **归档成功** —— 拿不到可读回的 CAS 句柄 ⇒ 不换原文（`birth.js` 的 archive 结果先行判定）
2. **编译非空** —— 空稿或纯空白 ⇒ `empty-candidate`，原文放行
3. **无发明标识符** —— 稿里的路径 / 反引号代码 / camelCase / snake_case 必须逐字出自 `raw ∪ ctx ∪ 程序部件`；发明或核验异常 ⇒ 原文放行
4. **字符净省** —— `raw − candidate ≥ birthMinSavedChars`（默认 50），否则 `no-gain`
5. **token 严格下降** —— 字符达到净省门槛但 token 没降 ⇒ `no-token-gain`（估算按书写系统区分，不是真 tokenizer）
6. **替换成功（condensed）** —— 以上全过才原位改写；任何一步不达标或异常 ⇒ 取消在途请求并原文放行

> **结构闭合**（判读分支闭合、三元组 `new_text ≠ old_text`）与**死路不复活**是**编译阶段**的要求（`compileV4Direct` / `src/compile-v5-local.js`），不在上面这六道收网判定里 —— 两段别混成一条闸。
<!-- watermark:end -->

这些门检归档、结构、标识符与净节省，拒绝/异常会回退原文。**通过稿可能仍丢承重事实或影响目标模型续行**；不能写“六闸＋回退永不劣于 raw”。真实 tokenizer、语义审查、原目标模型读回和真实宿主都是另外的验证闸。

## 5. 当前实测基线（技术检查和历史值分开）

软件基线是 **v14.25.4**；本轮修复未声明发布新版本。新技术自测两态读数只在文首生成块与 [watermark.json](transfer/watermark.json) 记账。

- 修复前普通/真隔离均 42/44 套通过，失败是资产存在性和文档水位；原始日志已保存。
- 独立重放冻结 v9：hand **17/26**；负例漏 **15/88**；教师 test 硬门 **5/216**；1,233 唯一标签逐字节一致，仍全 `trainable:false`。结论 **INVALID** 保留，七文件和历史产物未改。
- 重放扫描 29 个可用源文件，历史为 34；重复统计 79/75 对比历史 741/588。缺少冗余/旧来源影响枚举，不能把当前重复数当完整历史统计；唯一标签和验证结果分别核对一致。
- 原清单的 24 个路径不在 audit 快照，但全在固定 main `ccf8c4c801fa4dfc29339abe1e55c24ee4bbea77`。六份 5,763,690 字节与原 SHA 完全一致，放历史归档、不进训练。其他未完整取回，不能宣称永久丢失。

- **历史读数（未在本轮重跑）**：`transfer/models/micro-gap-map.json` 标注 `measuredAt=2026-10-04`、7 组真机对；当时 `archetypeProduction.distanceScore=1.000`、`generalProduction=0.1631`（W1 前 `0.1549`；W1.1 后 `0.1596`）。这组原型/兜底差距是旧测量，不是当前泛化成绩；编译延迟（13 条 × 20 次）与 Mode 1 `t10–t14` 9 组配对也来自已有记录。本轮没有重做，需按各自冻结口径复测后才能作为新版本现状引用。

**另一份历史失败（本轮未重做/不重开盲测）**：97M 学生的一次性 `case-fold-collision` 账本为 `evaluated-below-90-percent-gates`，unit 25/30=0.8333、draft 0/8；旧报告 `accepted:false/promoted:false`、`blocked-no-new-independent-family` 保留。它不是本轮生成式候选成绩，不能靠改稿重跑已消耗的家族。

本地历史代理 scorecard 不是 SWE-bench/Terminal-Bench 等官方实测；复用或跨计划重复不是新独立样本；规划单价不是实际账单。

## 6. 接手顺序

1. [AGENTS.md](AGENTS.md) → [PROJECT.json](PROJECT.json) → [PROJECT-PLAN](docs/PROJECT-PLAN.md)。
2. 看 [本轮实施](docs/CONTINUATION-PROGRAM-2026-10-12.md)、[覆盖采集](docs/COVERAGE-AND-COLLECTION.md)、[前阶段审计](docs/AUDIT-2026-10-11.md)、[一页交接](transfer/HANDOFF.md)、[架构](docs/ARCHITECTURE.md)。
3. 再按 [历史索引](docs/README.md) 查过去记录；不要照抄历史付费/恢复/盲测命令。
4. 默认只做可重放、可验证的本地工作；另获批准才能进入模型资源、付费试验或发布。
