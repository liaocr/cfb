# CFB训练就绪手册（v13.3，离线准备→快速启动训练）

## 能做与不能冒称

主路径是**训练专用CFB编译器**：保留完整RAW/当前上下文，学习副模型原始完整回复，再经过原编译/标识符/证据门。不是抽句、不是拼原文尾巴、不是以更短或Likert选训练目标；默认插件/提示词/权限不改。

当前已实际验收：流式语料治理、私有HMAC审核、族/谱系/重复连通分组切分、SFT/偏好导出、不可变配方、实际无依赖byte模型SGD与续训、loopback远程作业协议、发布闸门与加密搬迁。

当前**没有**PyTorch/Transformers/PEFT/模型权重，因此LoRA/DPO worker只经过语法、doctor、纯mask/cache辅助逻辑验证；没有完成CUDA/HF真实训练验证。远程HTTP替身不能证明A6或其他供应商支持微调；推理API兼容不等于训练能力。网络、权重下载、实际数据质量与算力不能凭软件变得“瞬间完成”。

## 1. 现在直接演练完整链

```sh
npm run training:demo
npm run training:ready -- help
npm run verify:offline
```

演练会实际训练小型byte-bigram模型，验证第5步续训和连续训练逐字节相同、loss下降、重跑0新增梯度；模拟两上传+一提交+一状态查询、重跑0追加。测试模型/数据/证书均标记fixture/simulated，不能发布为生产模型。所有替身返回的shell从不执行，外部API与费用0。

## 2. 组织训练数据——先审核，不能把旧分数当真值

记录格式是 `cfb.training-example/1`：uid/family/lineage/objective/source/messages/target（SFT）或chosen/rejected（偏好）。完整字符串保留；source必须明确来源sha、数据许可与`trainingAllowed`，messages只包含真实模型输入，不含判据/参考答案。

将语料放 `.cfb-runtime/train-ready` 或可靠外部私有持久卷，不进Git/MANIFEST。模型钥匙/口令不放语料、profile或CLI参数。

```sh
# 可选历史候选导入：完整生产prompt→完整原始side；默认训练批准0。
npm run training:ready -- import-history --out .cfb-runtime/train-ready/historical.jsonl

# 人/独立宿主逐项确认，不默认帮你把null改成true。
cp deploy/training-review.example.json .cfb-runtime/train-ready/checks.json
# 用编辑器填写已证identifierSafe/completeNative/goalVerified/criterionFrozen。
# 真实数据必须有合法训练权；未知/false不能签发。
npm run training:ready -- review --input .cfb-runtime/train-ready/records.jsonl \
  --out .cfb-runtime/train-ready/reviewed.jsonl --accept --mode expert \
  --reviewer operator-review --checks .cfb-runtime/train-ready/checks.json

npm run training:ready -- dataset --input .cfb-runtime/train-ready/reviewed.jsonl \
  --out .cfb-runtime/train-ready/dataset
npm run training:ready -- audit --dataset .cfb-runtime/train-ready/dataset
```

审核回调/证书由可信宿主持有，只有同步true生效；签名绑定**具体完整记录**。改目标后旧review无效，撤销最新head不能被旧ref覆盖。审核是一项宿主信任承诺，不是HMAC替人证明语义或版权。

缺审核/未知版权/旧消费族进隔离；密钥或非法记录只保留错误码/行号、不保存原正文。结构accept=ok不是训练真值，旧Likert不能筛样本。已消费 `chunked-header`、`delayed-headers` 不能改uid/family别名重进训练或盲测。

按family+lineage+标准化重复输入/目标的**连通分量**整体切分，不按单行随机分。指纹标准化只用于去重，实际文本不改；不足3组失败。test放本地custody，不上传、不作epoch/模型选择。族/谱系声明仍需可信来源，框架不能自动识别一个被恶意隐瞒来源的全新别名。

输出：train.jsonl / selection.jsonl / custody/test.jsonl / export/train.sft.jsonl / export/selection.sft.jsonl（偏好为preference）。provider导出必须与审核过的记录逐行等价，不能加参考/审核/family/split。每个文件有sha/行数/字节数，全部重验；隔离区不成为训练目标。

## 3. 冻结配方与基模型缓存

```sh
cp deploy/training-profile.example.json .cfb-runtime/train-ready/profile.json
# 填model.path、本地基模型id、精确40hex revision、许可确认；默认均未完成。
# 可选提供提前冻结、独立保护的客观评测suite，后续发布不能删负项/挑test。
npm run training:ready -- prepare --dataset .cfb-runtime/train-ready/dataset \
  --profile .cfb-runtime/train-ready/profile.json --out .cfb-runtime/train-ready/plan.json
npm run training:ready -- doctor --plan .cfb-runtime/train-ready/plan.json
```

准备不下载模型、不安装依赖、不读取keys.env、不调用供应商。基模型文件流式sha指纹与数据/配方/源码冻结；缓存变化拒绝旧计划。大型权重放独立可靠缓存/卷，不要提交Git。

SFT监督**仅最后完整助手回复**，prompt标签为-100；template前后token边界不一致或超过maxSeqLength整条拒绝，不截RAW/target。token cache绑定数据sha+tokenizer文件+revision+长度/目标，int32二进制+mmap，epoch只生成一次shuffle顺序；不拼接不同样本导致跨例注意力泄漏。

LoRA参数可配rank/alpha/targetModules，支持梯度累计、混合精度、梯度checkpoint、裁剪、确定seed。SFT或DPO（固定base作reference，不用test挑beta/epoch）。默认单进程/单设备；多GPU/分布式、CUDA逐字节确定性、模型家族实际兼容仍需后续专门验证，不冒称已验收。

## 4. 有网/缓存/算力后，明确批准再运行

仅接通网络不会让旧USD2/13 A/B许可变成训练许可。**新训练需独立计算资源/价格批准**。

### 本地LoRA（推荐，当前未实测真实权重）

未来明确安装可选依赖，并取得合法本地safetensors权重后：

```sh
python3 -m pip install -r training/requirements.optional.txt
npm run training:ready -- authorize --plan .cfb-runtime/train-ready/plan.json \
  --mode local-compute --max-usd 0 --confirm-training
# 记下返回的approvalRef；0表示本地provider费用，不表示云GPU免费。
npm run training:ready -- doctor --plan .cfb-runtime/train-ready/plan.json --approval APPROVAL_REF
npm run training:ready -- run --plan .cfb-runtime/train-ready/plan.json \
  --approval APPROVAL_REF --execute
```

实际worker强制HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE、local_files_only、trust_remote_code=false、use_safetensors=true；缓存miss只blocked，不在训练中偷偷下载/执行远程代码。输出/优化器/RNG/游标原子checkpoint；数据/配方/source/revision不符拒绝resume。用户选明确checkpoint可以`--resume DIR`；未知中断不会把已经花掉的steps/HTTP清零。实际GPU/FP16/BF16/特定模型兼容在本轮未验证。

训练完成只产candidate。必须验证新数据/基模型缓存与同批准后才继续；公开作业水位保存于transfer/training-sessions，私有语料/authority/模型/optimizer在ignored或持久卷。模型文件变动不能当cache命中重用。

### 远程训练（不假定A6支持）

`deploy/training-remote.example.json` 默认supportsFineTuning=false、模型/价格空。实际供应商的files/fine_tuning/jobs能力、可训练精确型号、训练terms/费用确认后才能配置。训练价必须是训练价，不能取推理价；epochs×保守token估计+固定job费需小于新批准/账户额度。

```sh
npm run training:ready -- authorize --plan PLAN_FILE --mode remote-money \
  --max-usd CONFIRMED_LIMIT --confirm-training
npm run training:ready -- run --plan PLAN_FILE --approval APPROVAL_REF --execute --live
# 之后同命令只查询/恢复已知状态，不重复上传/提交。达到HTTP上限停止。
npm run training:ready -- report --plan PLAN_FILE --approval APPROVAL_REF
# 只对已知job取消；没有job不会先创建再取消。
npm run training:ready -- run --plan PLAN_FILE --approval APPROVAL_REF --execute --live --cancel
```

钥匙只来自provider.apiKeyEnv，不能指向GitHub/PAT。上传仅train与selection，不会上传test/审核/判据。每个HTTP动作先持久pending、禁redirect/重试；未知上传/提交不能重发，也不能按异常退款。远程实际计费仍unknown，异步服务商可能不遵守估价；必须设置账户限额、保全jobId并监控/取消，不以本地maxUsd冒充物理账单锁。

## 5. 搬迁与续训

安全环境设置长随机 `CFB_STATE_PASSPHRASE`，不作为参数/聊天：

```sh
npm run training:ready -- export --file /persistent/train-private.cfbtrain
# 保留最新公开training-sessions水位；目标home必须空，禁止覆盖。
npm run training:ready -- import --home /persistent/restored-training --file /persistent/train-private.cfbtrain
# 物理路径可以变，但数据/模型必须同内容；逻辑planDigest/已花额度不变。
npm run training:ready -- relocate --home /persistent/restored-training --plan RESTORED_PLAN \
  --dataset RESTORED_DATASET --out RESTORED_EXECUTION_PLAN
```

AES256-GCM+scrypt 包含私有审核/作业authority与语料/小模型或adapter状态，不包含API钥匙明文；旧水位、错口令、篡改、路径穿越/symlink、非空覆盖拒绝。包128MB上限；大基模型/大型optimizer/token cache使用可靠持久卷，不能靠清理公开水位绕过预算。新位置先重验内容再relocate，不因路径变建立新零额度。

## 6. 发布与旧路保护

candidate != verified != released。冻结评测suite在训练前定义全任务/全criterion与独立evaluator sha；遗漏负项、unknown、平局、跨族泄漏、已消费test或模拟证书全部拒绝。只允许逐项不退、selection/test至少一项严格提升，不能由别处平均抵消。

真实发布证书由独立可信宿主签发并在私有发行簿登记；训练器/模型自己给的分数或JSON pass不授予权限。promote只登记模型，`productionConfigModified:false`；不会默认改CFB model/provider/提示词。rollback只回注册表旧版本。线上模型效果/耗时/独立泛化与完整DSH依赖仍待后续实测，不能拿byte模型loss下降宣布CFB提升。


## 7. v13.3.1：本地中断恢复与有限优化迭代

本地worker协议升级为v2：Node先持久预占再ACK，worker获得许可后才开始梯度。`trainedStep`是当前模型逻辑位置，`steps/computeSteps`是累计资源预占；恢复旧checkpoint只能回逻辑位置，不能退资源/墙钟/HTTP额度。`limits.maxComputeSteps`默认等于recipe.maxSteps，重做余量须在训练前明确配置并批准，不能删水位或改同一作业来补额度。

完整checkpoint包含adapter、optimizer、RNG、cursor及plan/dataset/source/attempt绑定；宿主验证文件sha并签发HMAC见证。正常边界暂停可自动使用latest恢复；异常退出仅为recoverable/unknown，不是训练成功。只有worker退出已确认且已有完整见证时才reconcile：

```sh
npm run training:ready -- report --plan PLAN --approval APPROVAL_REF
npm run training:ready -- reconcile --plan PLAN --approval APPROVAL_REF
npm run training:ready -- run --plan PLAN --approval APPROVAL_REF --execute
# 如显式--resume，必须是已认证latest，不能任意指目录或旧v1文件。
```

本机PID/start token确认旧worker仍活时阻塞；移机无法以本机PID缺失猜旧机退出，需操作者明确确认旧worker已停止（`--confirm-worker-stopped`是宿主信任承诺，不是OS证明）。租约不自动抢，退出/见证不明仍停止。HF实际optimizer恢复仍待真实权重实测；本机子进程fixture只证明同一协调器协议。

```sh
npm run training:iteration:demo
```

`tools/helpers/training-iteration.mjs`提供freezeTrainingIteration/runTrainingIteration：先冻结candidatePlans、数据/模型身份、保护的effect suite、evaluationScope与总compute/HTTP上限，再用可信宿主回调propose/train/evaluate及同步认证函数连接。propose只能从有限批准空间选择，不收到test/判据/参考/失败原文；训练先预占，未知不退款或自动重试。开发逐项二元符号选择不按loss/Likert/平均分；负/unknown拒绝，替换incumbent必须严格正项。选择结束后持久消费test族，只测最终候选；换cycle重用同test在train前就拒绝。

这是有界可运行接线，不是已验证真实LLM自主优化器。默认不内置外部模型调用，不自动产生新训练批准或发布；真实模型需要操作者提供受保护的训练/独立观察器适配。演练中原byte目标失败，test未触碰；工程制品案例只证明final-test路径，不能被包装成模型提升。
