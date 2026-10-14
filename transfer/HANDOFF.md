# CFB 当前交接（v14.25.4 基线，2026-10-12 参考稿优先）

> 这是当前入口，不是实验成绩晋级书。先看 [PROJECT.json](../PROJECT.json)、[唯一主线](../docs/PROJECT-PLAN.md)、[本轮实施](../docs/CONTINUATION-PROGRAM-2026-10-12.md)、[前阶段审计](../docs/AUDIT-2026-10-11.md)。

## 1. 技术水位

<!-- watermark:begin 由 node tools/doc-watermark.mjs --write 生成，勿手抄 -->
- **当前版本：v14.25.4** · **插件核心零第三方运行依赖**（Node.js ≥ 20；审计自测另需 Git/Python，训练有额外依赖）
- **自测（本块由 `node tools/doc-watermark.mjs --write` 生成，勿手抄）**
- 验收口径 `npm run verify:offline`（真断网 Linux 命名空间）：48/48 套件通过 · `1441 通过 / 0 失败 / 1 跳过`
- 快速自检 `npm test`（联网机上跑，需要隔离的那条断言按设计跳过）：48/48 套件通过 · `1440 通过 / 0 失败 / 2 跳过`
- 用时与记账时刻**不进文档**（每次 `--record` 都会变 ⇒ 写进文档就永远在漂），要查 `transfer/watermark.json` 的 `seconds` / `at`。
- **规模**：`src/` 25 个零依赖模块 · `tools/` 73 个脚本 + 33 个 helpers · `test/` 48 套自测 · `transfer/gold/` 13 条（4 个家族）
<!-- watermark:end -->

有跳过/稀疏范围；自测不证明真实宿主、GPU、CPU 生成或语义不退步。

## 2. 当前判断

- 目标：出生时 raw＋ctx → 生成式短稿 → 原目标模型后续读回；不是选句器或五家族模板。
- 只推进预训练生成式学生 SFT。首个候选 RWKV7，revision `7450ee04eb9c66baa7161b7a5c0fe09e5b2817d8`，191,034,624 参数；没有晋级，也没有 CPU 实机质量/延迟证明。
- 冻结 v9 独立重放一致，结论 INVALID 保留。1,233 标签全不可训练；没有当前主线已准入 corpus。
- 24 个 audit 快照缺路径全在固定 main 可定位，六份原 SHA 精确找回并归档；剩余未完整物化。不要再写“永久丢失”。
- JS v5 是历史特征排序/模板兼容路径，默认关闭，不是生成式语言模型。没有 RWKV 生产接入。

## 3. 已改掉的真问题

raw 不再按完成顺序取第 k 行；事件日志统一排等待态、去逐字重复、隔离冲突；旧 raw 重标来源不会继续当无歧义证据。改稿没有内容绑定审查时，不再选较新稿/自动做 preference pair。

研究 SFT 导出显式 non-admitted，坏 JSON、冲突、缺 frozen dev、未知 repo 和覆盖已有产物都失败。训练前本地预检和 model revision 必填；launcher 不再把本地代码混配可变 main 数据，默认只打包。

训练掩码与真实生成前缀一致；按 epoch 洗牌并轮换 DDP 裁尾；微批不足不能零步成功；dev loss 按有效目标 token 加权；未来曲线点真存权重。GPU 部分还没运行，不写“GPU 已修复验证”。旧 step72 没权重的事实不变。

## 4. 下一步，不能跳闸

先任务/资源和真实读回 → 高质量参考稿同出生A/A与utility → 新尺子效度/数字冻结 → 覆盖来源与完整监督/whole-family → pinned底座能力/CPU → 获批诊断SFT → 量化/shadow/有限晋级。便宜硬检查可并行但不替代任务效用。

失败停止，不降 v9 阈值，不把 off-target 或规则稿偷偷转为训练，不新增平行底座路线。

## 5. 安全命令和禁止误用

```bash
node tools/project.mjs scope-restore     # 仅当快照丢失Git稀疏配置；核对既有ledger/索引，不下载/改正文
node tools/project.mjs doctor
node tools/project.mjs readiness   # 当前 exit 2 是预期未就绪
node tools/project.mjs plan
node verify.mjs
node tools/verify-offline.mjs
node manifest.mjs --check --sparse
```

本地分支 `repair/audit-2026-10-11`，基线 `3922da88b35fe790ba145b3442a4800aac7fb4d1`。128 MB 下保留 10 项稀疏排除；排除字节未核验。

不要自动执行 restore/snapshot/ceiling/gold replace/新盲测；`.cfb-offline` 含不可再生付费材料。当前没有付费 API、真实模型训练、远端推送或新盲测授权。历史文档、旧冠军与分数不是当前操作指令。


## 前阶段工程交接（2026-10-11；不当本轮新回执）

普通 46/46：1366/0/3；真隔离 46/46：1367/0/2。共同 skip 为稀疏清单资产与真实 store 兄弟包；不是宿主/模型全验。水位已事务式重记；失败事务原日志保留。初始 1235 个历史路径、七个冻结文件 byte/hash 不变。

新增 cross-file validity 去重：复制/改名日志不再增加 n；旧错误测试“复制同一文件后合法 n=24”已纠正为 n=12、unvalidated。不要为了恢复旧数字改回去。

改动在 repair/audit-2026-10-11，尚未 commit/push、没有训练/付费/新盲测。本轮已改为任务/参考稿优先；不能拿上述前阶段全绿解锁未经批准训练。

## 2026-10-12 新增实施

- 42 source records/22 unique inputs/9 families/0 admitted；三完整AI开发审查74facts/20claims。AI1、人0、二审0，已曝光/trainingfalse。
- 30显式标签controls只验证apparatus，NOT_VALIDATED；birth→hook→wire三组全fixtures，不认证宿主/原reader。
- 正式flat exporter+完整review/source lineage接入Python预检；旧complete Boolean-only admission拒绝。launcher带全部refs并在bundle mount重验。无正式admitted数据、无训练。
- reader-study本地计划/导入；最少9续行臂，实际state/version/tools/预算缺失而blocked；0 observation留全部missing分母。无live execute。
- `programme:status` / `data:registry` / `data:review` / `data:formal` / `reader:plan` / `reader:import` / `readback:audit` 已接package，verify新加入compression-program技术回归。
- 下一步需要用户确认真实reader/宿主访问和部署预算，先测参考价值再采覆盖数据。不要把完整AI审查、helper单测或复制receipt视作真实效度。
