# 参考稿优先闭环：2026-10-12 实施记录

用户在完成审计后指出现有数据不能支持好微模型，并要求全面推进。**本轮已修改代码、文档、数据与测试，不是只列建议；但没有训练、付费调用、真实 CPU LM、宿主访问、远端发布或新盲测。**

## 已实做

### 1. 调整主线与机器状态

主顺序从“先跑 CPU 候选，再找数据/尺子”改为：任务/读回 → 高质量参考稿效用 → 新尺子 → 覆盖语料 → 能力/CPU → 诊断 SFT → shadow/有限晋级。预训练生成式路线和未晋级 RWKV 候选保留；便宜硬预检允许并行，但不能替代任务与监督效度。

任务契约将 ctx 的当时可见/裁剪范围、未来泄漏、source/report/hypothesis 与拟做/已做、回退/覆盖、全路径经济性、预算/授权分开。预算仍未确认，不编造部署参数。

### 2. 建立显式数据 registry

[`source-registry.json`](../transfer/program-2026-10-12/source-registry.json) 登记 17 原队列、16 派生开发稿、六份 off-target seed 和本轮三个开发稿：**42 条来源记录、22 个去重 raw/ctx、9 个 source family、0 准入**。20 个重复输入观察不增加独立样本；independentSampleCount=null。

旧教师语料报告作为研究 metadata 绑定，不重新认定为金标；不扫描/打开新盲测，不从恢复 archive 自动取训练。原料质量、标签质量、世界事实真伪、target 兼容和许可分别保留未验证状态。

### 3. 三个完整保留文本 AI 审查与生成式开发稿

原始输入完整阅读后另写参考，保留原坏稿不改。覆盖 flaky-timeout、perf-regression、sse-truncated：**74 个源事实记录、20 个稿件断言审查单元**。原始 raw/ctx 未改，parent artifact、行/record hash 和新 draft hash 绑定。

- flaky：100ms 裕量、计时起点、报告 1712/1698、pending 期间对冲合法性、listen/address 未证、多个未选定修法；不虚构三条已发出调用/重复测试。
- perf：输出/时延与 target/cap 的区分、450 回退只为建议、1500/2400 未解、下一步仍取更多数据；不强迫只改一行就宣布修好。
- sse：真 finish_reason vs [DONE]、无结束信号、length/空 stop 例外、done 暴露形态仍矛盾、计划加测试未执行；不改成仅编辑测试的模板。

`review-contract.mjs` 和 sidecar 检每个非空白 source/draft 单元、span、引用、哈希和明确断言结果，拒绝仅审 ctx 几句却标 source complete。**74 是明确保留源事实记录，不是独立标注者或 74 训练样本。** ctx ledger 原样留在 reader 前缀，不要求全部重复进新稿。

AI 单作者/单审、人0、独立二审0；完整仅针对保留 raw/ctx，不证明完整原会话/当时真实 served version。参考属于已曝光开发 proposal，trainingEligible=false，未由目标 reader 验证，不叫金标。

### 4. 新开发协议与 30 个对照

`continuation-prereg.json` 明确 A/A、同出生状态配对、缺失/回退计分、调用/模板族独立性、累计经济性和止损；数值晋级阈值仍未冻结。

[`control-calibration-final.json`](../transfer/program-2026-10-12/control-calibration-final.json)：24 个合成 condition/actor-time/math/reading 中英文对照（8 raw/ctx，4 最小反事实源对，含等价好稿与漂亮害稿）＋六个已有输入的正/虚假完成对照，**30/30 明确标签的审查管线预期匹配**。

这里调用显式 AI 标签，不是自动语义 oracle，也不独立于作者。**新协议 VALID=NOT_VALIDATED**，realOriginalReader=UNMEASURED，activeRuler=null；绝不让 fixture PASS 改写 v9 INVALID。

### 5. 出生→hook→transport 观测与预检修复

新增 `src/readback-evidence.js`，`traceReadbackHashes` 默认 false；开关打开时在 birth 决策与下一轮 hook 记录 hash，不存 raw/凭据正文、不改变消息。compiler ctx 与 acceptance ctx 分开记录，以免后拼调用污染训练输入血缘。

`tools/readback-audit.mjs` 只读 JSONL/trace：身份缺失/冲突拒绝；时间/键序复制去重；精确 reasoning channel digest 匹配但不推独立 n/语义读回。transport 捕获需在真实 provider serializer 后单独接入；plugin hook 不冒充最终 wire。

三组全是假夹具：前两组 hook/wire 可匹配，第三组 hook 有稿而 wire 丢 reasoning，工具正确显示 hook-only。出生 chunks→装配 assistant→下一次 hook 的单测也是 fixture，不证明真实 Cordis/CAS/provider。

修 `traj-run`：缺 reasoning 返回 400 只说明 syntax，不再当 carry success；所有计账结果 semanticCarryVerified=false。旧 V4-year 不再自动归一成 V4.1。preflight 缓存默认不复用；只有显式选择、相同 endpoint/model/tools scope、15分钟内且真实字段声明的 delta-accounting 回执才复用；不将旧缓存时间刷成新验证。

### 6. 正式 flat-SFT→预检→离线 bundle 连接

`formal-sft.mjs` 对完整审查、registry/source proof、许可/隐私/出生边界、repo/family/prior exposure、新尺子/reader study/CPU/预算逐项检查。统一 flat 格式并保留逐行源/目标/审查/prompt 血缘，拒绝 blind 输入。当前三个开发稿没有资格，正式入口实跑 **exit 2**，只写 blocked 报告，没有 train/dev/admission。

Python preflight 新增附着完整记录检查：全文 UTF-16 coverage、facts/claims、flat raw/ctx/目标、source hashes、registry/source proof、whole-family/曝光、reader/ruler/CPU/预算。**仅手填 review complete 的旧 admission 现在拒绝**。JSON/声明完整性仍不是独立语义或实际执行证明。

launcher 会带上所有 hash-bound lineage/annotation/review/registry/contract/prompt/stage-receipt 和逐字 source-review 文件再在新 mount 下重验；不只拷旧 ruler。不同输入仍不能绕过已曝光family；source model/served version必须属于首期target scope，不能只勾modelVersionVerified混入off-target。默认仍离线，无凭据/上传/执行。

### 7. 可执行的本地读回计划和导入，不擅自开 API

`reader-study.mjs` 只有 plan/evaluate，无 live execute。计划三个现有开发源 × raw-a/raw-b/reference，最少9续行臂；缺完整出生环境快照、真实版本/通道/tools/decoding与消费预算，所以明确 blocked。

导入须绑定计划/授权scope、完整出生模板及环境snapshot、指定reasoning槽位之外不变的请求、channel/tools/decoding、provider响应/id/usage及结果审查；拒绝symlink越界、复制去重、冲突双方隔离。它仍只是初始continuation＋绑定的结果声明，完整多轮轨迹/实际账单不验证、不发晋级收据。缺失全留分母，fixture/错版本不放行；当前空观察实跑 **exit 2**，三个登记案例全部 missing，没有伪造零损害/零成本。

## 验证与保护

新的 `compression-program.selftest.mjs` 覆盖 registry、源/稿全文审查、正负/等价/反事实夹具、400/cache/version、birth/装配/hash、serializer 丢字段、复制/冲突、formal flat/跨语言 hash、拒绝导出和缺失 reader 分母。技术水位以实际事务回执和验证日志为准，不手填全绿。

已实际执行 targeted：新programme 59/0/0，Python trainer 32/0/0；两项完整临时协议fixture验证producer→Python preflight及新bundle mount，包含source proof文件。临时fixture的版本/阶段声明刻意模拟schema，仅测代码通路，无model/tokenizer/API/训练/真实准入；临时文件已删除。JSON边界覆盖浮点指数/整数形式、键序、emoji/lone surrogate、ECMAScript whitespace；超出可无新增舍入回写的整数与NaN/Infinity拒绝，不偷改材料量值。

针对测试首次发现 fixture 沿用默认 dryRun，导致未触发 condensed；仅修夹具显式 `dryRun:false`，没有将生产默认改为启用。初次失败日志保留。另发现 `--mode` 被argparse缩写误认成`--model-revision`，仅生成smoke包；测试改用明确`--train`，两个资源CLI禁用缩写，随后完整train-protocol bundle只离线验证通过。它并没有执行训练。最终保护/完整性报告将记录前一交付 tree 与本轮的差异，冻结 v9、旧轨迹/gold/审查/历史 audit 与旧盲测账本应全部原字节。

## 未完成且不可假装完成

1. 真宿主/serializer/CAS 链路及当前原 reader 行为；现有新证据只有接口和技术夹具。
2. 资源预算、实际 CPU/tokenizer/model 运行；权重未下载，0 模型执行。
3. 高质量参考的 A/A、长度梯度和真实净收益；0 paid API。
4. 新尺子效度与数字冻结；NOT_VALIDATED，不 active。
5. 合法、target-compatible、whole-family 准入语料与迁移实测；当前0训练准入。
6. SFT、量化、shadow、有限晋级；尚未执行或授权。

下一步不是立即训练，而是用户提供实际宿主/reader访问、预算及部署资源后，执行小批参考稿价值实验，再据失败结构采真正的新监督。完整覆盖与学习成功不是本轮技术全绿的推论。

## 本轮完整技术验收

事务式实跑：普通 **47/47，1431通过/0失败/3跳过**；真网络隔离 **47/47，1432通过/0失败/2跳过**。两项共同skip仍为明确稀疏未核字节和真实store兄弟包，不是真实宿主/模型质量。日志hash在`transfer/watermark.json`的rawLog；不会手抄它们当模型成绩。

首次完整事务两lane均46/47失败，正确拒记并恢复旧回执/生成块。原因是环境快照未保存`.git/config`：已保留的10条sparse patterns和skip-index标记失去启用位，9个清单内未下载资产因此异常缺失。仅恢复经ledger/索引核对的两个Git设置，没有下载或改正文，也没降断言。`project.mjs scope-restore`为显式复现入口，doctor会发现配置位失配；未来重新取快照后必要时重做。首次事务控制台尾部及专项失败详情保留；原工具未保存完整lane输出，已修为每次raw日志与attempt journal均保留，包括后续失败。最终两lane原始输出已保存并hash绑定。

新programme 59项、Python trainer32项和audit-integrity32项均进入全量47套验收。协议fixture下的exporter→Python→离线bundle正例只是技术连通性；实际正式出口仍exit2，0训练数据/0模型执行。
