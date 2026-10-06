# `liaocr/cfb` 扫描报告 v2（勘误版 · 取代同目录 cfb-SCAN-REPORT.md）

> v1 是我在只读了 16% 文档的情况下写的。读完训练与金标这条主线（`docs/TRAINING-AND-BENCHMARK.md`、
> `KAGGLE-MICRO-RUN.md`、`GOLD-STANDARD.md`、`GOLD-WRITING-GUIDE.md`、`GOLD-EXPANSION-PROGRAM.md`、
> `docs/reports/CFB-MICRO-{READINESS,HANDOFF}-2026-10-04.md`、`transfer/HANDOFF.md`、`ARCHITECTURE.md`、
> `INSTALL.md`、`ROADMAP-GOLD.md`、`HISTORY-AND-EXPERIMENTS.md`、CHANGELOG 的 v14.18–v14.25 全文）之后，
> **v1 的 5 条结论作废**。本文件只留复验过的东西。

---

## 一、勘误：v1 里我错在哪（每条都给出现在的实测数）

| # | v1 的说法 | 真相 | 我错在哪 |
|---|---|---|---|
| 1 | "65M/97M Transformer 是装饰性假元数据；7.6KB ONNX 装不下 60M 参数 ⇒ 物理不可能" | 教师与学生**是两个产物**：教师 `ibm-granite/granite-embedding-97m-multilingual-r2` @ revision `835ad14…`，INT8 **98,688,445 B / CPU 280ms**；`cfb-micro-neural.onnx` 7,760 B 是**紧凑学生**（micro 交接记 12,002 B / batch=36 0.0956ms）。`TRAINING-AND-BENCHMARK.md` §6.1 明写"**它不会在 JS 调用中执行完整 97M Transformer**"、"紧凑 ONNX 延迟仅代表学生"；§6 还写了训练前硬检查 `totalParameters < 100,000,000` | **范畴错误**：我拿学生的体积去否证教师的参数量 |
| 2 | "编译延迟宣称 9.38 ms，实测 41–51 ms ⇒ 虚报 2–4 倍" | 在他们**真实金标语料**（13 条，raw 1,436–5,195 字）上逐条 20 次实测：**外部均值 4.1 ms**、`meta.localMs` 均值 **4.9 ms** | 我用的是 `text.repeat(28)` 的合成高重复输入，非典型样本；**他们的宣称偏保守** |
| 3 | "模板家族 == 金标家族 ⇒ 1.000 是检索而非泛化 ⇒ 项目自欺" | **项目自己先发现并写死在代码里**：`src/policy.js:77` 把这 5 个叫"手写原型模板"，并专设 `forceGeneralPath` 测量臂，注释原文"**= 真实用户仓的处境**"；`transfer/models/micro-gap-map.json` 已按 `archetypeProduction.distanceScore **1.000**` vs `generalProduction.distanceScore **0.1548**` 四向分栏记录；CHANGELOG v14.23.1 原话"**此前 8/8 都是自我参照的读数，等于没有尺子**" | 我把我**准备提的建议**当成新发现丢回去，而他们早已落地 |
| 4 | "金标与训练料混用 = 泄漏，未处理" | v14.21.0 已做 `use:'ruler'｜train｜both` **缺省 ruler**、5 个读取口逐个接线、`bench-run` 命中训练条目抛 `gold-use-mismatch`、训练前断言 `ruler-leakage-into-train`、自测 39 项；v14.22.0 `goldCeiling` C1–C6「尺子不得低于产品」；v14.24.6 盲测集不达标时**选"换真载荷"而不是"改判据"**（"动判据是给闸门松绑"） | v1 只读了 `GOLD-EXPANSION-PROGRAM.md` 第 27 行那一句警告，没往下读 §1 的落地段 |
| 5 | "README 吹'1.000 满分'当作既成结论" | 现行权威读数是 `train-v5-micro --eval-only` **`closeCount 0/7`**、标尺侧 **17 → 4**、`accepted=false / promoted=false`、**生产权重从未被替换**、`case-fold-collision` 一次性盲测 `0/8` 如实入 ledger；文档写明"缺盲测集 ⇒ 一定是 `blocked`，**这是设计而不是失败**" | 我把 README 首屏的滞后当成了项目的自我认知；实际**操作文档比 README 诚实得多** |
| 6 | "宣称 6 道门，实际只有 4 条" | `ARCHITECTURE.md` §2.1 明列六道顺序（归档成功→编译非空→无发明标识符→字符净省→token 严格下降→替换成功） | 挑字眼。**但**：README 那份清单（…结构闭合、死路不复活）与 ARCHITECTURE 那份**成员不一致** ⇒ 降级为文档互斥问题 |
| 7 | "`case-fold-collision` 0/8 说明模型被抓包" | 读数真实；缺语境：它是**一次性盲测的消费记录**，且整个 micro 流程状态就是未晋级 | 用他们的诚实记账反向指控他们 |

**另外两条过程性更正**：① 我上一轮跑 `node tools/gold-vs-line.mjs` 时改动了**受 git 跟踪的** `.cfb-offline/ruler/gold-vs-line.json`（29 行，全为 `"at"` 时间戳），我此前判断"该目录被 ignore 所以无影响"是错的；已 `git checkout` 复原，现 `git status --porcelain` = **0 行**。② 我曾怀疑模板注入不存在的路径（`src/transport.compat.js` 等），复查后**撤回**：`:629/:681/:727` 都有 `has(…)` 条件守卫，无守卫的那处被 `invented-identifier` 拒。

---

## 二、复验后仍成立的（这 4 条，加 1 条新的）

### 1. 文档层滞后与互斥（不影响科学结论，影响第一印象）

| 宣称处 | 文本 | 实测 |
|---|---|---|
| `README.md:4` | v14.20.0 · 31/31 套件 · 916 pass | CHANGELOG 顶 **v14.25.0**；**39 套 / 1,195 pass / 0 fail**（`npm run verify:offline` 实跑） |
| `README.md` §5 | 11/11 满分 `1.000`、gold 8 项/4 家族 | `npm run bench`：`p-1490eefcdf` **12/13、dd 0.724**，8 行里 4 行是 `[预估]`；`transfer/gold/` 实存 **13 条** |
| `ARCHITECTURE.md` §5 | 31 套 / 916 pass；"src/ 22 个模块" | 39 套 / 1,195；**23** 个模块 |
| `package.json` | version `0.1.0`（恒定） | 装了查不出哪版；真实版本只在 CHANGELOG 里 |

> 他们**已经有**解法：`docs/TRAINING-AND-BENCHMARK.md` §6.2bis 是脚本从产物生成的水位块，并注明"上方 §6.2 的旧数以此块为准"。缺的只是把同一招用到 README 首屏与版本号上。

### 2. `npm test` 在联网 Linux 上必红 1 项（真 bug，可复现）

`node verify.mjs` → `FAIL test/eval-ready.selftest.mjs` `Error: offline-namespace-required`；`npm run verify:offline`（`unshare -Urn` 内）→ **39/39 全绿**。根因：跳过判据 `offlineNamespaceVerifiable()` 只判"Linux 且有 `/proc/net/route`"，联网机恒真，于是去跑需要"只有 lo、零外部路由"的断言。修法：把 `assertOfflineNamespace` 的 `interfaces.every(n==='lo') && routes.length===0` 同时用于跳过决策。

### 3. 入库权重文件带陈旧且无人校验的元数据（卫生问题）

`transfer/models/v5-micro-weights.json` 的 `architecture` 块：`name: CFB-Micro-65M`、`totalParameters: 60,854,837`、`schema: cfb.v5-micro-weights/2-neural-65m`；当前训练器写出的是 `…/3-distilled-pretrained` + `CFB-Micro-97M-Multilingual`。`validateV5MicroWeights()` 逐条校验 `featureNames` 顺序、向量形状、`textHashBuckets`，**唯独不看 `architecture`**（`grep -rn totalParameters test/ tools/ src/` 除训练器外 0 命中）。⇒ 建议：删掉该块（运行时不需要它），或让校验器比对训练器版本戳。

### 4. 公开环境不能端到端复现（事实，非缺陷）

`@deepseek-ai/cordis@4.0.4` 在 npm（通用 meta-framework：context/events/fiber/logger/reflect/registry/service/utils），其源码内 `llm/stream`、`cmbStore`、`putText` **0 命中**；`dsh-app-boot`、`cordis-plugin-include`、本包 `npm view` 均 **E404**。`INSTALL.md` 印证它假定私有环境：`~/.dsh/profiles/web`、pnpm `file:` 依赖、Windows 盘符示例。⇒ 39 套自测覆盖的是纯函数 + mock ctx；`README.md` 未声明这一边界。

### 5. 新增（读完全程才看得到的那一条）：**最关键的那个泛化读数没有回归保护**

- `transfer/models/micro-gap-map.json` 里 `generalProduction 0.1548` vs `archetypeProduction 1.000` 是**整个项目最要紧的一个数**（"真实用户仓处境 vs 原型命中"的差，即产品价值本体）。
- 但 `forceGeneralPath` 在 `tools/` `test/` `docs/` 里的引用数 = **0**；`micro-gap-map` 被 `test/` 或 `.github/` 复算的次数 = **0**。
- ⇒ 这个臂只能靠人**手工**调 `--dry` 复现；将来谁改 `compileV5Local` 的兜底路径，**没有任何测试会红**。
- 建议（$0，一处）：加 `test/micro-general-arm.selftest.mjs`，钉住"13 条金标上 `generalProduction.distanceScore ≥ 0.15` 且与 gap map 存档逐位一致"，登记进 `verify.mjs` 的 `ORDER`；`gap map` 重算挂进 CI。这样 `0.15 → 0.08` 那种静默退化会被拦下，而不必靠下一次人工审计发现。

---

## 三、判断修正

v1 我写的是"科学结论可信度存疑"。读完文档与账本后的正确判断是：

**这套训练流程的自我批评强度高于我上一轮的审计强度。** 它有几条我在别处没见过的硬纪律：
- `未测 ≠ 通过`（GOLD-STANDARD §1，且是被反复咬之后定死的）；
- **改稿即失分**（定律一：原稿组 36% vs 改过稿组 0%，改稿只能当候选稿，转正必须重跑那一格）；
- `gold-attest` 的三条性质：**只降级不升级**、**章会过期**（`stampDigest` 钉稿）、未盖章沿用旧口径；
- 判据改了必须**同时**改代码 + 文档 + 自测（`test/gold-standard.selftest.mjs` 每轴一个通过 fixture 一个失败 fixture）；
- 一次性盲测**只允许评分一次**，构造阶段只跑 `--validate-dataset-only`；
- 闸拦不住时**改数据不改闸**（v14.24.6）；
- 主动作废自己的漂亮数字（v14.21.1 废除"与旧稿 dd 应接近 1.000"口径；v14.24.1 抓到一条会自己翻成 gold 的假证据并撤销；v14.24.4 把三处过度声称逐条改口）。

真正剩下的问题只有两类：**首屏文档没跟上诚实的内部账本**（§1、§2、§4），以及**一个关键读数缺 CI 保护**（§5）。

## 四、我仍未读的（避免你误以为我读完了）

`docs/theory/CFB-THEORY-COMPLETE.md` 247 KB（只读了卷结构 + 第四卷 A/B 篇定位：六卷、103 个标题，未逐行）；`CHANGELOG.md` 281 KB 中 v14.17 以前的正文（v12.1–v14.25 的标题全读，v14.18/19/22/23/24/25 全文读）；`transfer/` 下 **70 个** `effect-*/traj*/mr/*` 回执 md 未读；`tools/` 59 个脚本中 40 个未打开。
