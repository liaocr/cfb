# 给接手者的工作规则

先读 `PROJECT.json`、根 README、`docs/PROJECT-PLAN.md`、`docs/CONTINUATION-PROGRAM-2026-10-12.md`、`docs/AUDIT-2026-10-11.md`，再读实现。历史文件不自动成为当前指令。

1. **目标及唯一研究方向**：预训练小型生成式学生，输入出生时 `raw + 当时可见 ctx`，生成供原目标 DeepSeek-V4.1-Flash 后续读回的较短思考稿。不是选句器、模板、仅工具摘要或从零训练；旧 Qwen 探针不并行复活。
2. **先证任务/参考有用，再训学生**：任务/资源预算与真实读回 → 同出生 raw/raw A/A 与 raw/reference → 新尺子效度 → 覆盖来源/可靠监督 → 底座能力/CPU → 诊断 SFT → shadow/有限晋级。便宜的候选硬检查可并行，不能代替前面内容；CPU/tokenizer/nativeEOS 未测，固定 RWKV7 191M 仅候选。
3. 本轮三个完整 AI 开发稿（74 源事实、20 断言）是已曝光开发 proposal，不是金标/独立审查。单 AI、人0、二审0必须保留；旧16派生稿仍 partial，不把全部旧稿一刀切称未做新审查。
4. 全文 review sidecar 绑定每个非空白 raw/ctx 片段、事实 span、每个 draft claim 和 hash。完整覆盖与来源追踪是完整性检查，不自动证明内容真伪、原 reader 有用、许可干净。
5. **证据不改写**：旧轨迹、金标正文、历史回执、冻结 v9 代码/产物、已消费盲测账本保持原字节。更正另写、说明基线/来源。v9 INVALID 不降阈值，新对照30/30只是 apparatus、NOT_VALIDATED。
6. 日志是事件流：等待不算成功；键序/时间复制去重；终态/身份冲突隔离；raw 按 task/state + variant + sample 匹配，不按完成顺序/最后行。复制与多参考不增加独立 n。
7. `traceReadbackHashes` 默认 false；开启只捕获 hash。birth 决策≠宿主装配/CAS≠hook≠serializer 后 wire≠provider 读入≠真实语义续行。400/计账/缓存/指纹都不是语义证明。compiler ctx 与 finish acceptance ctx 分开，后者不冒充当时模型输入。
8. 新稿不天然优于旧稿；偏好对、正式 SFT 必须内容绑定的完整审查和来源/曝光证据。旧 declaration-only admission 现在拒绝；正式 `formal-sft.mjs` 缺前闸只产 blocked report，0 train/dev。
9. `doctor/status/registry/review/plan` 只本地，读回工具无 live execute。API/权重/真实 CPU/GPU/发布/新盲测须另确认 scope/budget/access。`restore/snapshot` 不默认，`.cfb-offline` 含不可再生付费材料。
10. 自测全绿不证明真实宿主/CPU LM/训练或普遍不退步。固定分母，包括失败、拒绝、超窗、不可压缩和回退；全路径累计成本/缓存/元数据/CPU/重试与压缩覆盖一起报告。不能全回退刷不退步。
11. 工作区128 MB；不下载权重或大 tokenizer。稀疏不等于丢失，定位不等于核字节，归档不等于准入。新报告新路径，不覆盖已存证据；保持排除清单/旧hash。
12. 更新入口水位须 `watermark:record` 真运行事务；清单最后重算。部分检出用显式 `--sparse`，未下载项保留旧 hash；跳过及不完整范围必须展示。

本文件是贡献约定，不替代用户对付费、训练、发布及数据用途的逐项授权。用户“全面推进”已落实安全的本地闭环，不表示有了好学生或无限资源授权。

环境快照不保存`.git/config`；若已保留sparse patterns/skip-worktree但配置位丢失，先显式`node tools/project.mjs scope-restore`核对并恢复两个非凭据配置位。它不fetch/checkout/reapply，不放宽资产缺失断言。doctor现在对此失配报错。
