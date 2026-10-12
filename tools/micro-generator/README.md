# 出生思考稿压缩：参考稿优先的生成式闭环

当前目标/顺序以根 `PROJECT.json`、`docs/PROJECT-PLAN.md` 和 `task-contract.json` 为准；不是本目录旧 Qwen 模板定义路线。唯一方向是预训练生成式学生；固定 RWKV7 191M 为未晋级候选。

## 已实做及边界（2026-10-12）

- `program.mjs registry`：42 retained records → 22 unique raw/ctx、9 family、0 admitted；20 repeated inputs 不增加 n。
- `build-program-dev.mjs`：三个已曝光编码 raw/ctx 完整 AI 单审/开发参考；74 source facts、20 claim units。源完整 retained text，不是完整原会话或许可证明。AI1、人0、二审0，仍 dev-only/trainingEligible=false。
- `review-contract.mjs`：每个非空白 source/draft 片段覆盖与精确 UTF-16 quote/fact/claim/hash，防止几条 ctx facts 冒充完整。检查审查完整性，不推断自动语义。
- `build-program-controls.mjs`：30 explicit-labelled equivalent/counterfactual/harmful 开发 controls 的 apparatus；不是金标、训练数据、新blind或独立 ruler。
- `reader-study.mjs`：本地 blocked plan / strict evidence import；3案例×3臂，实际 state/version/budget 未提供，无 live execute。
- `formal-sft.mjs`：正式 flat-row/lineage 适配；source/review/family/target/ruler/reader/CPU/budget 缺任何前闸不出 train/dev/admission；全registry的已曝光family及source model/served version绑定，不能只换输入或勾Boolean绕过。
- `deploy/kaggle/train_rwkv7.py --preflight-only`：不导入 torch，重新检查附着 complete reviews 和所有血缘/文件绑定；旧 complete Boolean-only admission 拒绝。
- `start-rwkv7.py`：保持 refs relative paths 复制整个 lineage及逐字source-review文件，再于新 bundle mount 重验；默认只打包，不推送/训练。

全部新产物在 `transfer/program-2026-10-12`；`formal-export-latest` 是预期拒绝回执，**不是训练 corpus**。协议 NOT_VALIDATED，原目标读回/CPU/监督准入/模型执行仍零或未测。

## 安全命令

仓库根执行；未指定 `--out` 不写文件，指定只接受新文件/目录：

```sh
node tools/micro-generator/program.mjs status
node tools/micro-generator/program.mjs registry
node tools/micro-generator/program.mjs review
node tools/micro-generator/build-program-dev.mjs
node tools/micro-generator/build-program-controls.mjs
node tools/micro-generator/reader-study.mjs plan
node tools/micro-generator/reader-study.mjs evaluate --plan PLAN.json --observations EVIDENCE.jsonl --out NEW_REPORT.json
node tools/readback-audit.mjs --events YOUR_LOG --out NEW_REPORT.json
node tools/micro-generator/formal-sft.mjs --out NEW_DIRECTORY # 当前 exit 2
node test/compression-program.selftest.mjs
python3 test/trainer-contract.selftest.py
```

两个开发 builder 的 `--write` 仅首次写入；已有报告不覆盖。reader import 是描述性报告，绝不自动发布 `cfb.original-reader-study/1` 晋级收据或 VALID 尺子。0 observation 不等于0损害，缺失全部留分母。

## AI 单审，不伪造独立性

授权身份 `arena-agent-mode`，reviewProvenance 必须 mode=ai-single-reviewer、reviewerType=ai、reviewerCount=1、humanReviewerCount=0、independentSecondReview=false。不要求第二审，但也不能说 independently adjudicated。完整材料、来源 span、无 unsupported claim 与 family isolation 不因单审免除。

源推理可能错误/自相矛盾；保留 source 的证据/假设/不确定性，而不是把理想正确答案注入稿。任何计划/测试/修复必须区分实际发生。source-fact count 不是样本数或模型成功率。

字符压缩仅 `draft.length/raw.length`，ctx 不进入分母；这是 UTF-16 字符代理，不是原生 token/净收益。不能把提示/句柄/CPU/失败重试成本排除后喊压缩划算。

## 当前禁止的捷径

- 17 原 queue / 16 派生 partial candidates 不升 train；6001 启发式 teacher 不是可靠监督；四 gold family 不代表任意覆盖。
- 六份 pinned Open-SWE Qwen/off-target 摘录是探索，不是 V4.1 已准入；prior exposure 与 whole-family 必须冻结，禁止按行 random split。
- 同 raw/ctx 多稿需显式 canonical adjudication 或等价评分，不取最后行；队列/旧训练 prompt 不自动成为事实真值。
- 尚无新family blind。已有 v9消费账本不重开；新的盲测需另授权/预注册，freeze predictions 后再看 labels，blind 永不进 Kaggle train bundle。
- 正式来源、实际 reader、新 ruler、CPU、预算未满足，不能靠结构 Boolean/fixture 打开训练。

## 旧工具的保留用途

`prepare-review-queue` / `build-fact-draft-suggestions` / workbook / `export-reviewed-corpus` / evaluation-gates 和 `kaggle_qwen3_qlora.ipynb` 保留用于历史/研究合同，不再是本轮正式训练入口。建议器只提局部 preamble facts；旧 workbook 是审查界面，不是 gold importer。旧局部 exporter 不能绕过完整 sidecar/source/runtime 血缘。

`run_gguf.py`、历史 HF/QLoRA 模板是研究 smoke，不是候选 CPU/质量证明。旧 Qwen3-0.6B Q8_0 的 PAIT-GGUF-100 预警不可绕过，文件未下载/加载；mock tests 不证真实模型。不能从 Qwen 模板提另一条并行路线。

外部来源/公开 survey 决策仍以 `docs/MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md` 和 `docs/MICRO-GENERATOR-TARGET-MODEL-SOURCE-SURVEY-2026-10-07.md` 的**当时范围**为准：QMSum 不是 CFB 出生CoT，未准入；SWE-agent 需来源许可/完整review；SWE-chat 接触条件未接受；benchmark holdout/encrypted reasoning 不取作训练。没有本轮新联网采集或覆盖当前公开生态的保证。

接下来先确认真实原 reader/宿主状态与部署预算，测参考稿效用，再按 `docs/COVERAGE-AND-COLLECTION.md` 建新监督；不以训练数量/loss 替代这个结论。
