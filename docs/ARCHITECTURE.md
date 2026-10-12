# CFB 架构与当前边界（v14.25.4 基线，参考稿优先闭环）

当前状态：[PROJECT.json](../PROJECT.json)；主线：[PROJECT-PLAN.md](PROJECT-PLAN.md)。历史模块名/理论术语不证明实现是生成式 LM。

## 1. 三个职责，只有一条开发主线

| 平面 | 现有实现 | 状态 |
|---|---|---|
| 生产兼容 | `index.js`、`src/plugin.js`、birth/distill/transport/compile | 保留技术回归；RWKV 尚未接入 |
| 生成式学生 | `deploy/kaggle/train_rwkv7.py`、离线 bundle launcher | 唯一研究主线；数据/评测/CPU 验证尚未准入 |
| 证据控制 | `tools/project.mjs`、`program/review-contract/reader-study/formal-sft`、hash读回观测、冻结重放、manifest/水位 | 本地完整性与明确未测；不训练、不付费、不发布 |

旧 `cfb-cycle`、ranker、JS v5、micro/from-scratch/Qwen 探针是历史兼容/研究工具，不再自动决定当前 next。接口保留不是路线保留。

## 2. 现有 birth 流

```text
宿主 llm/stream reasoning
  → block-start 立即透传；delta 累积并透传
  → birthStart：归档与编译并行，不阻塞主流
  → birthFinish / birthAccept：收网与结构门
  → condensed，或拒绝/异常时原文 passthrough
```

`plugin.js` 是组合根；`birth.js` 管生命周期；`distill.js` 组合编译器；`transport/provider/config` 管传输与跟随；`compile-v4`、`messages`、`fidelity` 管格式、部件与标识符。`evidence-program/store` 仍是显式 opt-in。

### 2.1 六道收网门（从源码生成）

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
1. **归档成功** —— 拿不到可读回的 CAS 句柄 ⇒ 不换原文（`birth.js` 的 archive 结果先行判定）
2. **编译非空** —— 空稿或纯空白 ⇒ `empty-candidate`，原文放行
3. **无发明标识符** —— 稿里的路径 / 反引号代码 / camelCase / snake_case 必须逐字出自 `raw ∪ ctx ∪ 程序部件`；发明或核验异常 ⇒ 原文放行
4. **字符净省** —— `raw − candidate ≥ birthMinSavedChars`（默认 50），否则 `no-gain`
5. **token 严格下降** —— 字符达到净省门槛但 token 没降 ⇒ `no-token-gain`（估算按书写系统区分，不是真 tokenizer）
6. **替换成功（condensed）** —— 以上全过才原位改写；任何一步不达标或异常 ⇒ 取消在途请求并原文放行

> **结构闭合**（判读分支闭合、三元组 `new_text ≠ old_text`）与**死路不复活**是**编译阶段**的要求（`compileV4Direct` / `src/compile-v5-local.js`），不在上面这六道收网判定里 —— 两段别混成一条闸。
<!-- watermark:end -->

门的意义是结构/来源/成本保护，不是普遍语义证明。CAS 读回、首次出站、内部异常不破坏主流等不变式保留。字符/估算 token 不是 RWKV tokenizer 预算，也不是实际 API 账单。

## 3. 新生成式路径的接口边界

```text
出生时 raw + 当时 compressor ctx（不含未来；acceptance ctx另记）
  → 任务/资源与真实 birth→装配/CAS→hook→serializer wire 观测
  → 完整开发参考稿 → 同出生raw/raw A/A和raw/reference效用/净成本
  → 新尺子效度/阈值冻结；覆盖数据/来源/许可/隐私/whole-family审查
  → pinned底座能力/native tokenizer/CPU硬可行性（便宜硬检查可并行）
  → hash-bound flat SFT + 全文review sidecars + source/prompt/stage lineage
  → Python preflight及保持relative refs的离线bundle再验
  → 获批诊断GPU smoke/SFT/真实权重点；内容与reader、loss分别看
  → 量化重验/CPU整体收益 → shadow/真实宿主有限晋级
  → 只有在实测范围通过后，才替换birth/distill
```

当前缺真实读回、预算、新有效尺子、准入数据及CPU实证。三完整AI开发审查已经完成，不能说仍只审几句，但不是金标。正式 exporter/Python 已验证附着记录，不只验证complete Boolean；全文/hash也不能独立证明审查语义与真实执行。旧声明式admission已拒绝。

### 3.1 读回观测分层

`traceReadbackHashes` 默认false。开启后 `birth.js` 用 input `[raw, compilerCtx]` hash记录condensed决策，`messages/plugin` 记录下一轮hook的channel digest。实际transport必须在provider serializer之后显式记录 `requestEvidence(stage=transport-payload)`；没有自动代理当前外部宿主。只用hash，不记录raw/凭据。

`tools/readback-audit.mjs` 去重/隔离身份冲突并查later digest；能识别hook有稿但wire丢字段，不能证明CAS真的持久化、provider消费或语义续行。`reader-study.mjs`只本地plan/import，要求state/request/response/outcome refs，当前blocked。HTTP400仅syntax、usage差仅accounting、scope/15min缓存仅路由预检，均semanticCarryVerified=false。

## 4. 日志是事件，不是样本表

`tools/helpers/trajectory-records.mjs`：

- identity = task/state、variant、sample；完成顺序不是 sample。
- `awaiting-draft` 不计分；错误不替代已完成结果；未知状态不推定成功。
- 除时间外内容逐字等价的重复终态只计一次；终态不同不“最后行胜出”，隔离。
- reuse metadata 与 task/sample 矛盾时，严格消费者拒绝。
- runner 续跑、序贯判定与总结共享同一契约；benchmark 只作有范围的历史描述，不给跨计划独立 n。
- ceiling 不再自动混入以往计划；训练/金标/复用等严格入口遇冲突不能默默选一条。

旧日志/收据不改。来源重新标号只表明跨计划身份不可信，不自动证明每个同计划 raw/hand 配对都错；需按引用时间、源 sample 与 shadow 逐项重建。

## 5. 文件与状态纪律

- `.cfb-offline` 并非全可再生，含已付费来源、教师及审查；默认 restore 已停用。
- `.cfb-runtime` 有已入库不可再生历史；不按目录名清除。
- `transfer/audit-2026-10-11` 保存本轮范围、基线、独立重放及原入口/原清单；`transfer/archive-2026-10-11/recovered` 仅历史恢复，不作为训练输入发现目录。
- `data-v9` 及 PREREG 七文件保持历史原字节；新评测另起版本。
- `MANIFEST.sha256` 是当前资产完整性清单；旧清单缺项证据另存，不能靠重算掩盖。
- `--sparse` 只检查已物化范围，未取回项旧 SHA 保留；严格检查仍失败，这是范围事实，不刷成全资产已验收。

## 6. 验证层次不能混

语法/格式扫描 → 单元/负例回归 → 真无外部路由隔离 → 真宿主/目标reference读回与CPU硬检查 → 获批GPU诊断 → 学生/量化CPU与目标读回 → 产品shadow，每层分别记账，不与主线内容门混为一谈。

本轮执行前三层及冻结历史证据重放；没有下载本轮底座 LM 权重、安装 Torch/GPU、执行 CPU LM 实机或访问真实宿主。跳过项、未物化资产与未经事实审查配对必须保留在报告中。水位只能由事务式实跑生成，不手改通过数。
