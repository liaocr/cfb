# 离线训练架构预注册（2026-09-30）

## 本轮范围

用户再次要求将架构推进到接网后能快速训练。本轮不修网、不探测外部API、不加载模型/GitHub密钥，不开展收费训练或生产接管。原USD2/13次许可只属于旧最小A/B，不能拿来批准微调。

上轮已做评测/状态恢复，不等于具备训练设施。本轮主路径是理论F3：**训练专用CFB编译器**。默认学习完整生产边界（RAW+ctx→副模型原始完整回复），既有编译门仍判验输出，旧提示词/正文/权限不变。SFT为默认；偏好格式只接受同输入、同冻结判据的有证据选择，不用Likert/更短稿选样本。

## 固定实施项

1. **数据治理**：完整文本保留，严格schema/字节/敏感材料/版权与训练权检查；私有HMAC审核证书绑定具体记录，结构通过不冒充行为正确；历史未证样本进隔离区。按family+lineage+重复输入/目标的连通分量整体切分，test留在本地，不进训练/远程上传。已消耗chunked-header/delayed-headers永不洗成新训练/盲测数据。
2. **训练准备**：不可变数据集清单、源/配方/基模型/权重缓存指纹、SFT/偏好导出、预算/步数/序列上限；超长整条拒绝，不截目标/不把prompt也算监督损失。缺依赖/权重/价表/新训练批准明确blocked，不默认下载/提交。
3. **可执行后端**：无依赖reference-byte模型做真正梯度更新、loss/优化器/游标续训与checkpoint验收，只是测试模型；可选本地HuggingFace/PEFT LoRA训练器，禁止远程代码与隐式下载；远程files/fine-tuning作业适配器必须显式能力与单独训练预算，不假定A6支持微调。
4. **作业/发布**：任务状态与公开单调水位、未知提交不重发；缓存/续训拒绝数据/配方/私钥/源码漂移。训练完成只成为candidate；逐项客观无负/unknown且留出严格提升才可发布，默认不改CFB模型配置。独立heldout证明/真实计费仍未知。

## 实现前可证伪验收

- prepare/doctor/export/dataset/audit/reference-demo 外部网络0、收费0；只明确批准后的execute/live才能训练实际权重/发作业。
- 未审核、未知版权、密钥材料、假review、真值未知、旧holdout全部拒绝或隔离；样本ID改名不能绕过family/lineage/重复连通分组。
- 真实训练文件仅含train/selection允许字段；test/ref/checker不被上传，不用test挑epoch或候选。模拟证书/数据/模型不能变成真实release。
- reference smoke必须实际更新参数、loss下降、续训与不中断逐步相同；这不证明LLM/CFB模型增益。
- 远程作业loopback故障/重复run不多提交；lost private/older checkpoint不变成零预算；unknown不退款或补发。
- 本地LoRA脚本无依赖也能doctor/语法验收；没有torch/权重时不报pass或训练完成。真实CUDA/HF训练需接网/缓存后另验。
- 原267稿N1–N7全零、旧编译33/33、默认路径无变化；不重跑旧18任务/39episode/已消费留出，不训练真实生产模型。

## 实测

本轮新增43自测，全部真断网通过。全量 **889通过 / 0失败 / 1原有依赖跳过、29/29套件、24.2秒**；manifest **329 文件** 无漂移/新增/缺失；267稿N1–N7全零，旧编译33/33逐字一致。DT仅Node strip-types语法，非tsc语义验收。

真实无依赖训练：8条fixture审核样本/8组、train6/selection1/test1；20次梯度更新，训练交叉熵5.54907608489521→5.382317406312822，第5步中断后续训与连续训练权重逐字节一致；已完成再跑0梯度，权重被改拒绝cache。host数据审计可读custody以检查泄漏，trainer不拿test预测/挑参数。不能把此loss当CFB/LLM成功率。

真实loopback远程作业协议：2上传+1提交+1状态查询=4 HTTP；再跑0追加，unknown提交停止不重发，取消无已知job时不创建新job。test/review/family/reference不上传。是固定替身，供应商是否支持微调/真实计费仍未知。

搬迁：私有语料、审核authority、作业与梯度checkpoint AES256-GCM+scrypt加密；恢复新物理路径保持原逻辑planDigest/批准/steps，通过内容指纹与公开水位；旧包/错口令/非法路径拒绝。大模型/大optimizer/token cache需独立可靠持久卷，128MB包上限不等于无限制备份。

新增可执行Python LoRA SFT/DPO worker：完整chat template+最终助手mask、超长整条拒绝；token cache绑定数据/tokenizer/revision，int32二进制+mmap；每epoch一次shuffle、真实梯度累计、精度/梯度checkpoint/裁剪、adapter safetensors、optimizer/RNG/游标原子续训。当前torch/transformers/peft/safetensors均缺失，未导入/安装；仅AST/doctor/纯mask验收，**不能说真实HF/CUDA训练已验证**。

CLI冷启动真实验收：历史完整生产prompt+side导入10候选，默认训练批准0，全部隔离，train文件不存在、外部API0。发现Python自测缓存被清单收录，已清理仅本轮__pycache__并补Git/manifest忽略与禁止bytecode环境；换机不会依赖pyc。

外部模型/供应商/API/收费训练/GPU0，provider费用USD0；只实际训练了测试模型。未读/保存用户模型/GitHub密钥，未重探网、未训练生产LLM、未接管DSH、未重跑旧18任务/39episode或消费旧留出。原USD2/13许可未使用且不用于微调。完整宿主依赖SKIP保留。

具体操作见 [训练就绪手册](../RUNBOOK-TRAINING-READY.md)。现在软件关键链已闭合，后续实际数据/许可/基模型缓存/算力/新批准准备好后可明确execute；不是保证接网即训练成功。训练/模型收益、真实计费与独立泛化仍须接网后实际验证。
