# CFB 离线准备 → 联网启用手册（v13.2）

## 你现在可以做什么

**所有准备、体检、演练、报告和迁移都无需外部模型。** 默认不联网，只有 `run --live` 才可能发送已批准的请求。当前可执行计划严格限定：1 次渠道探针 + flaky-timeout / wrong-model / eacces-config 三个已知开发题 × raw/一个 current 变体 × 每格两样本，最多 13 请求、USD2、零评委/自动重试。

这是一条受预算保护的评测/交付链，**不是 DSH 自主工具接管器**。现有插件仍走原 birth/compress；新证据执行接口仍要求宿主明确提供并冻结契约/文件与上下文适配器。完整外部 DSH/Cordis 依赖缺失的跳过项仍保留。架构细节与实际证据见 [本轮报告](analysis/OFFLINE-READY-2026-09-30.md)。

## 1. 现在，离线完成准备

```sh
npm run effect:simulate                 # 真断网、真实本机HTTP整链与9类故障
npm run effect:ready -- prepare         # 缺钥匙/价格也可冻结，明确blocked
npm run effect:ready -- doctor          # 只读体检，不做DNS/TLS/API探测
npm run effect:ready -- report          # 只读认证缓存；未开始时响应数0
```

`doctor` blocked 退出码 2 是前置条件未满足，不是“钥匙已被API拒绝”。报告中的 `channel: not-live-verified` 明示没有实际通道证据；`requestsReserved:null` 表示未开始或状态不可判，不能冒充实际请求0。`actualCostUsd:null` 表示没有账单证明；本机模拟外部API/费用0另列，不从模拟 usage 推断真实供应商收费。

## 2. 接通网络后，最短启用

### 配置：只放非敏感参数

```sh
cp deploy/eval-profile.example.json eval-profile.json
# 用编辑器填写 eval-profile.json 的 pricing，或另用 --pricing JSON文件。
# 模型钥匙在安全的进程环境配置，不写此JSON、源码、命令参数或聊天。
```

公开配置字段：

| 字段 | 作用 |
|---|---|
| `model` / `baseUrl` | 精确请求型号与HTTPS基础地址；不接受userinfo/query/fragment，不把请求名当响应身份 |
| `apiKeyEnv` | 模型钥匙的环境变量名（缺省 DEEPSEEK_API_KEY），不能指向 GitHub/PAT |
| `pricing` | 实际中转计费的输入/输出每百万token美元价、每请求固定费、可信来源和核对日期；默认null，不能拿零价样例当免费 |
| `timeoutMs` / `maxResponseBytes` | 每次请求截止/正文字节上限，默认240000 / 1048576 |

`pricing` 必须含 `inputUsdPerMillion`、`outputUsdPerMillion`、`requestFeeUsd`、`source`、`verifiedAt`。数字为 **USD**，不自动把人民币或额度单位当美元；来源为无凭据的HTTPS URL，日期须真实且最近7天。不得用上游官方价替代该中转实际价格，也不得猜固定费。需要同时设置供应商账户额度：本地预算依赖真实价表与保守输入估计，无法物理限制一个不遵守价表/token限制的服务商。

当前适配器只支持 `chat-completions-history-reasoning/1`：响应型号必须精确匹配，历史 reasoning 必须被本次 canary 证明可见，且命中已核验指纹。**不伪装 Claude/OpenAI 的任意协议都支持替换历史思考**。适配器用 Node fetch，不隐式采用代理环境变量；请提供可靠的出站路由，不能关闭 TLS 校验绕过网络问题。

### 冻结与显式运行

在安全环境设置**轮换后的**模型钥匙；若使用既有 keys.env，只在实际需要联网时按约定 `set -a / source / set +a` 加载，工具自己不读取该文件，不读取/使用 GitHub PAT。

```sh
npm run effect:ready -- prepare --profile eval-profile.json
npm run effect:ready -- doctor
npm run effect:ready -- run --live
```

前置条件都通过才可能发送**单次**探针；坏型号/指纹/历史不可见、usage异常、JSON/工具参数损坏、截断、超限、网络未知立即停止，不降级、不重试、不请评委。A/B两个sample的先后顺序反转，工具与可见消息一致，只更换完整 reasoning。参考/规则不进入模型请求；仅完整唯一配对进入结果。

## 3. 推荐：每次预占/回复自动加密检查点

在安全进程环境设置至少16字节、建议长随机值的 `CFB_STATE_PASSPHRASE`，不要把口令放CLI参数/聊天。选择一个**可靠持久卷、且不在私有状态目录内**的文件：

```sh
npm run effect:ready -- run --live --checkpoint /persistent/cfb/current.cfbstate
```

此模式先保存预算初始化；每次 dispatch 前，私有仓 + 公开收据 + pending 加密包均落盘成功才允许发请求；已认证回复后再原子更新 accepted 包。口令错误、包旧于当前水位、无法写包均阻塞，不能为了继续而删包重置额度。自动包仅允许同计划/同仓身份单调更新，手工 `export` 默认不覆盖已有文件。

已认证回复之后备份失败不会把该回复改成“provider失败”或擦掉缓存；先修复存储/导出最新包，再继续。**未知/pending始终不能重发**。逐步备份有本地加密/IO开销，默认关闭；不改变模型内容或采样预算。

## 4. 搬机器、断点恢复与报告

默认私有数据：`.cfb-runtime/bounded-ab`；可以用 `--home /persistent/cfb/state` 或 `CFB_EVAL_HOME` 指向可靠持久卷。该目录含完整输入/响应、本地 HMAC authority，**不进Git/manifest，不作为普通明文包分享**。

公开单调收据固定在 `transfer/api-budget-approval.watermark.json`，只含 scope/计划摘要/仓身份/head修订/计数/预留费用/状态，不含任务正文、canary、API钥匙或私有路径。它需要与私有仓/最新加密包一起保存。真实运行产生/改变该小文件后，请重新生成 manifest 并保存/同步此公开收据；Arena可保留此非ignored文件，但不承诺所有宿主平台自动保存私有目录。

```sh
# 口令由CFB_STATE_PASSPHRASE提供；没有模型请求。
npm run effect:ready -- export --file /persistent/cfb/backup-001.cfbstate
# 把公开收据与加密包安全搬到新机器，目标必须不存在或为空。
npm run effect:ready -- import --file /persistent/cfb/backup-001.cfbstate --home /persistent/cfb/restored
npm run effect:ready -- doctor --home /persistent/cfb/restored
npm run effect:ready -- report --home /persistent/cfb/restored
# 只有原认证状态完整、源码/计划/价表/鉴权上下文相同、没有未知，才继续未调用job。
npm run effect:ready -- run --live --home /persistent/cfb/restored
```

AES-256-GCM + scrypt 包含本地 authority 与完整计划/仓，**不包含模型钥匙明文**。鉴权指纹不可还原，换钥匙/换池后不能直接复用旧探针。错误口令、认证篡改、文件穿越/符号链接、超大包、非空目标、旧 watermark 全部拒绝；旧包不能使计数或费用倒退。

## 5. 故障处理：不拿便利替代证据

| 状态/错误 | 正确处理 |
|---|---|
| `plan-missing` 且没有收据 | 先prepare；不是provider鉴权失败 |
| `api-budget-restore-required` | 收据存在但计划/仓/authority缺失，导入最新完整包；绝不初始化零额度 |
| `api-watermark-conflict` | 仓/收据修订不一致或回滚，保全两者并恢复最新一致检查点；不自动修补或退款 |
| `api-auth-context-changed` | 换钥匙/池了；先离线report，重新获准通道计划，不用旧探针继续 |
| `source-current` blocked | 未开始可重prepare；已开始需原源码/原计划，不换稿重新测 |
| `api-unsettled-dispatch` / rejected / 网络未知 | 已占请求及上限费用，停止；不能把异常当没收费而补发 |
| `eval-checkpoint-busy` / `eval-checkpoint-changed` | 同一包正被写入或状态变了；保留锁/两平面证据，停止，不自动抢锁或覆盖新包 |
| `api-checkpoint-write-failed` | 保留已认证缓存，修存储/导出；不把模型成功改成失败 |
| `channel-*` | 不可信通道不能拿来宣布CFB收益；本计划停止，无第2次探针 |
| 截断/坏工具JSON/正文过大/usage越界 | 不作为有效样本、不补样本、不执行返回shell |

公开收据/HMAC/加密包不是 OS 沙箱或远程不可回滚账本；拥有同权限的人可同时删除所有副本，不能靠本地代码检测一个已抹掉全部证据的世界。操作者须保护密钥与判据、保存最新副本/可靠持久卷；服务商账单仍需账户额度限制。重新授权新实验不能靠换目录、换scope、删收据、扩大样本或解除指纹闸门伪装。

## 6. 验收与退出码

```sh
npm run verify:offline     # 真断网全套 + N1–N7 + 历史回放 + 本地控制演示
npm run manifest:check
npm run effect:simulate
```

退出码：0操作完成，2前置条件blocked或未明确live，3执行中停止/未知；1为参数/存储/加密等操作错误。doctor不探测网络，不能证明钥匙有效；当前full宿主依赖SKIP不能说已通过完整DSH验证。模拟仅证明协议/控制/恢复路径，真实模型增益、真实计费、独立泛化及生产自动接管仍未证明。
