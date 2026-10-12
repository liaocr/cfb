# 唯一主线：先证明压缩有用，再训练微模型

更新：2026-10-12，按用户“全面推进”落实参考稿优先的闭环。事实以 [`PROJECT.json`](../PROJECT.json) 和实跑回执为准；实施报告见 [`CONTINUATION-PROGRAM-2026-10-12.md`](CONTINUATION-PROGRAM-2026-10-12.md)。**阶段完成、技术通过与产品达标分开。**

## 1. 目标和唯一研究路线

**一个出生时 reasoning raw＋当时压缩器可见 ctx → 更短生成式思考稿 → 原目标模型后续读回。**

保留承重证据、条件、否定、主体、精确量值、因果、反证、不确定性、已做/拟做和未解问题。不是选句器、五家族模板、静态工具指令、模型无关进度摘要或仅降低 loss。

“任意 CoT”是覆盖目标，不意味着每段任意输入都必须更短且绝对无损；短、高信息密度、超窗或不可证安全输入允许回退，但回退与覆盖必须进入全案例统计。详细输入/输出/资源/授权契约在 [`task-contract.json`](../tools/micro-generator/task-contract.json)。

首期 receiver 按现有 dataset policy 为 **DeepSeek-V4.1-Flash**。其他模型 raw 可探索辅助来源；没有新预注册和目标 heldout 迁移证据时，不准混成主线已准入数据。source model、reader model 和 reference 作者不是同一个字段。

只推进 **预训练生成式学生 SFT**。RWKV7 `fla-hub/rwkv7-0.1B-g1@7450ee04eb9c66baa7161b7a5c0fe09e5b2817d8` 为首个未晋级候选，元数据实际 191,034,624 参数。其 CPU、语言/语义能力、长输入和停止均未验证。不是围绕候选先造大数据，再寻找成功理由。LoRA 要另验证，不并开 DPO、多底座、从零训练或旧 Qwen 探针。硬可行性失败时，明确退役并选择一个替代，不降低门槛。

## 2. 已完成的工程底座不是训练许可

2026-10-11 的审计修复与保护回执保留在原目录：事件身份/等待/重复/冲突、研究导出拒绝、训练掩码/洗牌/快照、稀疏清单和事务水位。冻结 v9 的七文件 hash 和 INVALID、1,233 全 `trainable:false` 不变；旧一次性盲测不重开。

2026-10-12 已实做：任务契约；显式源 registry；三个已曝光输入的完整保留文本 AI 审查/开发参考；事实/断言全文覆盖 sidecar；30 条明确标签的开发对照；出生/宿主/transport hash 观测与导入；严格 formal flat-SFT 适配；Python 附着审查/血缘预检；离线 bundle 携带血缘；读回计划与本地观测导入。

这些产物没有把训练、真实读回、CPU 或新尺子声明为通过。完整 AI 审查不是独立人审/金标，已曝光家族仍 dev-only。新校准的 `VALID=NOT_VALIDATED`，不是取代 v9 的有效 activeRuler。

## 3. 阶段顺序与停止条件

### S1：任务、资源预算与真实读回链路

固定出生时刻、raw、压缩器 ctx 的组装/裁剪策略、输出字段及部署 CPU/RAM/延迟/窗口预算。审计 128 MB 是工作区上限，不自动等于部署模型大小。

启用 `traceReadbackHashes:true` 可记录出生决策及下一轮 hook 的 hash，不默认启用，不记 raw/凭据正文。provider 序列化后必须另用 `requestEvidence({stage:'transport-payload',...})` 记录。hook 不等于 wire，wire 字段不等于语义使用，400 不等于读回证明，指纹和计账也不能代替目标续行。

现有 birth 的 compiler ctx 与 finish 时 acceptance ctx 可能不同（本轮调用拼接）；新证据分别记 hash，不能把事后 acceptance ctx 冒充学生当时输入。

**产物**：用户资源预算、真实状态快照、当前通道/served version/tools/解码、原始流→装配/持久化→实际出站的证据链。**停止**：稿未进入实际读回，先修接入，不训。

### S2：高质量参考稿的价值实验，不先训学生

对少量合法、可重建状态的开发输入制作完整审查稿和长度梯度；保留不可压缩/回退案例。先 raw/raw 的 A/A，再同出生状态 raw/reference；测完成、约束、虚假完成、错误动作、额外工具轮、累计 provider usage、缓存、CPU/句柄/元数据/重试及时延。

[`reader-study-plan-final.json`](../transfer/program-2026-10-12/reader-study-plan-final.json) 已准备，但实际状态、版本、预算缺失，尚不能运行。9 个最少续行臂不等于 9 个实际请求；完整多轮和预检/重试要另限额。当前没有 live execute 命令，也没有擅自读凭据。

**产物**：绑定原始请求/响应/状态/结果审查的开发读回报告。**停止**：认真审查的参考稿没有有意义净收益或显著损害，修任务/ctx/长度，不归咎于学生大小。

### S3：新尺子的效度与阈值冻结

另起 [`continuation-prereg.json`](../tools/micro-generator/continuation-prereg.json)，不改 v9。确定性格式/血缘层、完整内容审查层、真实原 reader 效用层分别报告。加入等价好稿、漂亮坏稿和主体/时间/量值/否定/条件最小反事实。显式标签对照通过只验证审查管线，不证明能自动判语义。

开发阶段数值晋级阈值仍为空，资源预算/校准完成后才正式冻结。新有效尺子须有新 prereg 和报告 hash，完整正负对照及目标读回证据；不能让 apparatus PASS 自动产生 VALID。

分母事前固定；超窗、拒绝、超时、异常、回退都留下。按仓库/任务/模板/输入/调用血缘聚类；复制件不增 n，未经独立性审查 independentSampleCount=null。**停止**：等价误杀、明显害稿漏判或 reader 效度未建立。

### S4：重建一套可追溯数据，而不是复制旧教师池

源 raw/ctx、参考稿、行为结果、审查分开登记。已有开发原料可重标，坏稿可作负例；来源/许可不明、未来泄漏和盲测保持隔离。已经完整审查的三个开发稿仍 trainingEligible=false；当前 registry 的 42 记录归并 22 raw/ctx，不是 42 个独立监督样本。

按 [`COVERAGE-AND-COLLECTION.md`](COVERAGE-AND-COLLECTION.md) 的能力矩阵采集：语言/任务/长度/轮次、数值主体条件例外、假设证据、分支长依赖、工具限制和不可压缩输入。非编码合成对照只是探针，不填补真实目标分布。

whole-family 划分考虑同模板/仓库派生关系，不按行随机分。相同输入多个等价稿可以保留给评测；首次 SFT 只能选择明确裁决的一个规范目标，不取最后行。不把训练 prompt 重贴成历史 teacher prompt。

**产物**：来源/许可/隐私/出生边界证明、完整 annotation＋sidecar、split/prior exposure 和冻结 hash。当前准入仍零。

### S5：底座能力与 CPU 硬可行性

便宜的硬检查可在 S1–S4 早期并行，但需机器/模型资源授权；无效 CPU 后端不要等大数据造好才发现。检查固定 revision 的原生 tokenizer/vocab/EOS/模板、真实输入预算、递归解码、量化、可停止、峰值 RAM 与 p50/p95。

191M 的权重不能塞进当前工作区。FLA CUDA/Triton 训练实现不是 CPU decoder 证明。metadata EOS=0、tokenizer 文本/历史 export 的 EOS 差异仅提示风险，不等于原生运行时 id 已测。不得猜 id、静默 resize、删监督 token 或换模板使 smoke 过。

验证语义能力而不是“能出字”：否定/数值/条件/长依赖及语言覆盖。**停止**：预算、窗口、模板或后端失败，记录并退役候选。

### S6：正式 flat-SFT 适配及诊断性训练

正式入口为 `formal-sft.mjs`，不复用旧 research/legacy exporter 解锁。先核对全部 annotation/full-text sidecar、source registry/source admission、许可/隐私/出生边界、whole-family/prior exposure、reader study、新有效 ruler、CPU receipt 和预算；拒绝 blind 输入。缺一项只写新 blocked 报告，不写 train/dev/admission。

将 raw/ctx 编成统一 JSON user，输出 `id/repo/system/user/assistant`；逐行 lineage 保留 annotation、完整审查、来源证明与 prompt 血缘。Python `--preflight-only` 不导入 torch，现已拒绝仅有 complete Boolean 的旧 admission，检查附着审查覆盖、UTF-16 span、断言、血缘/拆分、逐字source proof与真实阶段收据的声明绑定；不同input也不能绕过已曝光family，source model与served version明确匹配首期target。它仍不能证明审查者没有漏判或外部实际执行真实性。

获得明确训练授权后才做小 GPU smoke/诊断性 SFT。训练内拟合、反事实变化、whole-family dev 的事实/续行与 loss 分别看。不要从几百条或 loss 降低许诺最终能力。所有 dev 保留，prompt mask/模板一致；未来快照真保存权重，旧 step72 缺权重不变。

**停止**：强参考稿可行而学生不行，归因 data/分布/容量/长度；不能盲加步数。诊断支持以后才扩大数据/训练。

### S7：产品化与有限晋级

量化后重新测内容/续行；一致接口、deadline/取消、故障隔离、资源限额及原文恢复。先 shadow 生成但不替换用户上下文，再有限启用、监控/回滚。六道门只保护结构/来源/成本，不保证语义。

同时报告损害率、全输入净节省、压缩覆盖、回退/拒绝/超时和 CPU。不能靠全回退刷不退步或只看成功压缩的收益。实际理想上界和缓存变化不划算时停止该配置。晋级只支持实测范围，不宣称所有 CoT 永不退步。

## 4. 安全入口与授权

```bash
node tools/project.mjs scope-restore     # 仅当快照丢失Git稀疏配置；核对既有ledger/索引，不下载/改正文
node tools/project.mjs doctor
node tools/project.mjs readiness                  # 当前预期 exit 2
node tools/micro-generator/program.mjs status
node tools/micro-generator/program.mjs registry   # 只读；--out 只接受新文件
node tools/micro-generator/program.mjs review
node tools/readback-audit.mjs --events YOUR_LOG --out NEW_REPORT.json
node tools/micro-generator/reader-study.mjs plan
node tools/micro-generator/formal-sft.mjs --out NEW_DIRECTORY # 当前 exit 2，不产 train/dev
node verify.mjs
node tools/verify-offline.mjs
node manifest.mjs --check --sparse
```

复现三个既有开发审查与对照时默认只读，`--write` 拒绝覆盖已存在产物。真实 API、模型资源、GPU/SFT、发布或新盲测必须逐项明确 scope/预算/访问；“全面推进”已经授权本地方案实做，不表示无限付费或重开盲测。历史 restore/snapshot/ceiling/gold replace 不自动执行。
