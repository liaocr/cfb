# GPU 训练就绪推进计划 — 从当前到首次诊断 SFT

日期：2026-10-12。目标：把项目推进到**需要 GPU 训练模型**的状态，即数据、尺子、环境、预算和执行链路都已准备好，只差在外部环境启动训练。

## 当前已完成（离线）

- 技术回归双 lane 47/47 通过
- 3 份完整单 AI 开发审查（74 facts/20 claims），registry 42记录/22唯一/9家族，0准入
- 30 controls 装置匹配，NOT_VALIDATED
- 诊断训练集 `diagnostic-train.jsonl` 2条 + `diagnostic-dev.jsonl` 1条，已通过 `train_rwkv7.py --preflight-only --smoke`
- OpenI 预检包 `cfb-openi-preflight-2026-10-12.zip`，本地 inventory 验证通过，无权重/无训练
- 资源预算草案 `transfer/program-2026-10-12/resource-budget-draft.json`

## 距离 GPU 训练就绪还缺什么（按依赖顺序）

### P0 — 必须先确认的

1. **部署目标**：CPU 型号、RAM、文件大小、窗口、p95 延迟、回退策略
   - 未确认前不能定模型是否 191M 够用
2. **Reader API 兼容性**：a6api.com/v1 是否完全兼容 DeepSeek thinking 模式
   - 需要验证 `reasoning_content` 的传递规则：官方文档说带 tools 时必须回传，不带 tools 时忽略
   - 需验证实际计费、缓存、并发限制
3. **预算确认**：首阶段 $50 / 200 请求 / 5M token / 2重试/请求，5-7 工作日
   - 超限前停止，不自动追加

### P0 — OpenI C500 环境实测（你来执行，我来解读）

1. 上传 `openi-cfb-preflight` 包到 C500 任务
2. 运行：
   ```bash
   python environment_probe.py --stage inventory --out env-inventory-001.json
   python environment_probe.py --stage tensor --timeout-seconds 180 --out env-tensor-001.json
   python environment_probe.py --stage triton --timeout-seconds 300 --out env-triton-001.json
   ```
3. 返回 JSON + 任务页面资源/镜像信息（去除账号隐私）
4. 我据此判断是否可直接跑 RWKV7，或需适配

**注意**：不要 `pip install -U torch triton` 覆盖厂商适配版。C500 单卡标称 64GB 是产品规格，实际可用以任务分配为准。

### P1 — 真实读回价值实验（需 API 预算确认后）

- 目标：证明“好压缩稿有用”
- 输入：20-40 个可重建开发输入，3 arms (raw-a, raw-b, reference)，同一冻结出生状态
- 产出：任务结果、约束违反、虚假完成、额外工具轮、累计 token/费用/时延、回退率
- 停止条件：参考稿自身无净收益 → 修契约/强度，不训练

我已准备 `tools/run-reader-smoke.mjs` 草案，实际执行前需你确认预算。脚本不落盘密钥，使用环境变量，记录完整轨迹 hash，不伪造 provider 执行证据。

### P1 — 新尺子冻结

- 现有 30 controls 仅是装置测试，VALID=NOT_VALIDATED
- 需要用真实读回结果校准，冻结数值门槛
- 保持 v9 INVALID，不改历史

### P1 — 第一批正式监督（100-300 条）

- 每条绑定：源模型/版本、出生 raw/ctx/时刻、许可/隐私、family、完整审查、先前用途、模板血缘
- 冻结 tokenizer 后的实际监督序列、EOS、mask、超窗拒绝集合
- 旧 6001 规则池、开发/盲测材料不能直接变训练集
- 需独立复核支持，否则工期延长

### P2 — 诊断 SFT

- 在 OpenI C500 或 BI-V100 上，2-20 GPU 小时
- 验证：训练内映射、实体/否定/阈值反事实、whole-family dev、原目标续行
- 区分 loss 下降、风格模仿、真实保真
- 保存版本/hash，支持复验

## 详细步骤（我已可独立执行的部分）

1. **诊断训练集**：已生成 2+1 条，smoke 预检通过
   - 下一步：扩到 20-40 条可靠参考，含非编码任务
2. **资源预算**：草案已写，需你确认部署目标和 $50 预算
3. **OpenI 预检**：包已就绪，待你在 C500 上执行
4. **Reader 烟雾测试**：脚本草案已写，待预算确认后小范围试跑（例如 3 cases × 3 arms = 9 请求）
5. **正式数据准备**：需创建 source-admission-review，绑定真实来源证明

## 开销估算（首轮到诊断 SFT）

| 项 | 规划区间 |
|---|---:|
| 接入/CPU预检 | $0-15 |
| 小批 A/A + 参考续行 | $5-30 |
| 100-300 条参考/完整审查 | $40-200 |
| 小 SFT/GPU 调试 | $5-30（免费额度则 $0） |
| 学生续行复验 | $10-60 |
| 存储/重试预留 | $20-60 |
| **合计** | **$80-395，建议准备 $100-400** |

人力：100-250 人时，主要在审查和归因，不是 GPU 小时。

## 下一步执行顺序（我现在就能做）

1. 你确认部署目标和预算（回答之前 ask_user 的 5 个问题，或直接说“按 $50 / C500 先验 / 允许新来源 / PAT 只读”）
2. 你在 OpenI C500 上跑预检包，贴回 JSON
3. 我基于真实环境信息，准备 RWKV7 真实 kernel 测试包
4. 预算确认后，我用 a6api 跑 3×3 的最小贯通 reader 实验，记录完整轨迹和账单
5. 冻结新尺子，准备 100-300 条正式监督，进入诊断 SFT

## 安全说明

- 我没有创建 `keys.env`，也不会明文保存 API Key / PAT
- 你贴出的 Key 已暴露在历史中，建议轮换
- 训练权重、依赖、checkpoint 放在 OpenI 持久存储，不占本地 128MB
- 正式训练准入仍 0，技术全绿不等于可训练

## 本地核对命令

```bash
cd /home/user/cfb
python deploy/kaggle/train_rwkv7.py --data transfer/program-2026-10-12/diagnostic-train.jsonl --dev transfer/program-2026-10-12/diagnostic-dev.jsonl --model fla-hub/rwkv7-0.1B-g1 --model-revision 7450ee04eb9c66baa7161b7a5c0fe09e5b2817d8 --preflight-only --smoke
node tools/project.mjs doctor --json
```
