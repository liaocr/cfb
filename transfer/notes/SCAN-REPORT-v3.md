# CFB 仓库全面扫描报告(2026-10-07 本地日期)

> 扫描对象:https://github.com/liaocr/cfb (clone 至 D:\cfb,HEAD = a676a8c,main 分支,312 commits)
> 扫描方式:git 历史分析 + 全目录枚举 + 源码/测试/文档通读 + 实际运行自测与完整性校验

---

## 1. 这是什么项目(30 秒)

**dsh-cot-form-b**(包名 `@dsh-external/dsh-cot-form-b`,v14.25.4)—— 一个 Cordis 协议的外部插件,
核心做**思维链「出生即压缩」**:主模型每写完一段 reasoning,在进入会话历史之前
用副模型(或本地微模型)压成短摘要,原文写进 CAS 可按句柄取回,带六道「收网门」保真闸。
伴随大量实验装置:金标库、离线评测台、轨迹重放、Kaggle 微模型训练管线、双轨裁判、Pareto 策略池。

**一句话**:**工程严谨、文档繁重、历史重度 AI 化,近期提交纪律正在崩坏** —— 这正是「几经 AI 转手后破烂不堪」的具体表现。

---

## 2. 仓库面貌(实测数字)

| 维度 | 数值 |
|---|---|
| 提交数 / 时间跨度 | 312 commits,2026-09-22 → 2026-10-07(约 2 周) |
| 作者身份 | ~18 个:cfb-cleanup 120 · cfb-agent 46 · cfb-kaggle-bot 37 · liaocr 52 · cfb 24 · arena-agent 15 · 其余零散 |
| 跟踪文件数 | 1668(git pack 78.5 MB;工作区 125.9 MB) |
| 代码 | src/ 24 模块 537 KB · tools/ 61 mjs + 4 py + 29 helpers · test/ 42 套 · deploy/ 6 文件 |
| 文档 | docs/ 36 文件约 0.6 MB;全仓 .md 共 518 个(含 transfer 内的交叉拷贝) |
| 数据 | transfer/ 495 文件 107.6 MB(models/gold/轨迹/effect/语料占大头) |
| 边界目录 | .cfb-runtime/ 746 文件、.cfb-offline/ 160 文件(.gitignore 规则 + git add -f 强跟,历史抢救产物) |

README 声称的结构数(24 src / 61 tools / 29 helpers / 42 套件 / 13 金标)**与实际逐项核对一致** ✓

---

## 3. 扫描验证了什么

| 检查项 | 结果 |
|---|---|
| 全源码语法 (`node --check` src+tools+helpers+test) | 0 失败 ✓ |
| 文档水位 `node tools/doc-watermark.mjs --check` | passed ✓(v14.25.4 的防手抄系统真实存在且工作) |
| 密钥泄漏扫描(sk-/api_key/Bearer) | 仅测试夹具假钥,无真实泄漏 ✓ |
| 全量自测 `node verify.mjs`(本机 Windows) | **38/42 套件 · 1234 通过 / 7 失败 / 5 跳过** |
| 完整性清单 `node manifest.mjs --check` | **FAIL —— 漂移/新增 97 处** ✗ |
| README 目录声明 vs 实际目录 | deploy/ 描述失实 ✗ |

**自测失败逐条定性(全部为「平台环境差异」而非代码缺陷,需在 Linux CI 上复核)**:
- closed-loop-v4 A18/A19 —— 测试内部 `execFileSync('bash')`,本 Windows 无 bash ⇒ 重放畸形
- mode1-quality-parity —— `spawnSync('python3', …)` 在本机 python3 为 WindowsApps 替身,spawn 失败 exit null
- micro-general-arm #08 —— 用 `path.join` 拼路径去 `endsWith` 匹配 MANIFEST(清单是正斜杠)⇒ Windows 反斜杠失配
- eval-visible-v3 #11 —— 并发下 flaky,单独跑 14/14 通过

> ⚠ 推论:在目标环境 Ubuntu(CI 用 ubuntu-22.04)上,这些套件大概率是绿的
> (watermark.json 记录的 2026-10-07 隔离态读数就是 42/42、1242 通过 / 0 失败)。

---

## 4. 问题清单(按严重度)

### 🔴 P0 MANIFEST 完整性清单漂移 97 处 —— 仓库「铁律」被最近的 AI 提交违反
`node manifest.mjs --check` 退出码 1:92 个「新增(不在清单)」+ 6 个「漂移」+ 0 缺失。
- 最后更新 MANIFEST 的提交是 `83b3d80`(2026-10-07 11:50);其后 7 个提交(a676a8c/1993fe8/48a7982/cb45ad6/21f3080/…)又新增/修改了
  deploy/kaggle/*.py、docs/MICRO-GENERATOR-*、tools/micro-generator/*、transfer/models/micro-generator-* 等,**没有再跑 `npm run manifest`**。
- HANDOFF/README 自己写明「修改任何入库文件后必须执行 npm run manifest」—— 纪律当场失效。
- 直接后果:**CI 的 manifest 步骤现在会红**(`node manifest.mjs --check` 在 CI 第一步)。

### 🟠 P1 文档与目录脱节(README 目录地图失实)
README §3 写 deploy/ 含 `probe/ 探针 + systemd/`,实际 deploy/ 只有 kaggle/ + onboard.mjs + eval-profile 模板,探针与 systemd 目录**不存在**。

### ⚪ P2(已证伪,撤回)乱码污染 —— **误判,非真实问题**
- 初次用 PowerShell 查看时中文显示为「璇ユ矙绠?/濂椾欢」等,误判为 mojibake。
- 用 Node 直接读文件做全仓扫描(1523 个文本文件)后确认:**仓库内没有任何真实乱码**;transfer/traj*.jsonl、watermark.json 的中文均为正常 UTF-8(如「我先读取测试文件和 package.json」「42/42 套件」)。
- 根因:Windows PowerShell 控制台用 GBK 解码 UTF-8 输出,属于**显示问题**而非数据问题;PowerShell 里看到的乱码字符本身也不存在于文件中。
- 教训:前任脚本/报告若仅凭终端显示下「乱码」结论,同样需要复核。

### 🟠 P3 版本标记不一致
src/universal-select.js 头注释标「v14.26 原型」,而包版本是 14.25.4;该模块是未接线的原型(README 如实声明「未批准接线」,这点诚实)。

### 🟡 P4 测试平台假设过强(Linux-only)
closed-loop-v4 / mode1-quality-parity / micro-general-arm 硬依赖 bash / python3 / POSIX 路径分隔。
没有 `platform` 守卫、没有 win32 skip ⇒ 在 Windows 上 `npm test` 必红(与本扫描实测一致)。
仓库声明支持「Node ≥ 20 即可」的普适性,但没有写「仅限 Linux」。

### 🟡 P5 仓库体量与库内大文件
- 126 MB / 1668 文件,含 24 MB 的 tokenizer.json、多个 6–10 MB 的 .jsonl.gz 语料、5.7 MB 数据集。
- 无 Git LFS(.gitattributes 只有 eol 规则);`.cfb-runtime/` 本质是运行痕迹却被 add -f 强跟了 746 个文件(2026-10-06 迁移抢救的决策,理由「不可再生」,在 .gitignore 里有注明,算有意识的选择)。
- 克隆/检出较慢,任何历史重写几乎不可能。

### 🟡 P6 文档快照冗余与过时(他们自己也知道)
- docs/ 同日多份:STATUS-2026-10-07、AUDIT-REPORT-2026-10-07、HANDOFF-2026-10-06、9 份 MICRO-GENERATOR-*-2026-10-07。
- STATUS-2026-10-07.md 是 8c918cc 的只读快照,其中 P8(「doc-watermark 不存在」)等条目**已被后续提交修复**,但文档仍被 README 引用为参考 ⇒ D9 困境(文档领先/落后代码)自述成立。
- transfer/notes/ 里已躺着两份前代 SCAN-REPORT-v1/v2。

### 🟡 P7 探针脚本带绝对路径不可移植
transfer/probes-2026-10-07/ 下多数 mjs/py 硬编码 `/home/user/cfb/...`,换机器直接 import 失败;README 已自认「未复现的归档读数」,但资产仍占用 495 文件中的很大一部分。

### 🟢 P8 历史数据缺口(他们自己记账,非新发现)
- 06g 折报告未入库、折候选权重未复制 ⇒ flaky/perf 折不可恢复,只能重训。
- 金标覆盖缺口 36/40(30 格矩阵);gold 判定「provisional-gold 文档与代码不一致」未决。

---

## 5. 好消息(别被上面的清单吓到)

1. **自保护机制是真材实料**:doc-watermark 防手抄系统(带 5 条负例夹具)、MANIFEST 哈希、负例测试文化、12 条不变式、12 轴金标判据、离线命名空间真断网验证——这套东西维护得很认真。
2. **核心代码质量高**:源码零第三方依赖、模块职责清晰、注释大量「为什么」；语法全过。
3. **交接文档非常可用**:transfer/HANDOFF.md 30 秒上手、三档省钱评测、铁律清单,是给后续 AI 的最好入口。
4. **结构数/版本读数与磁盘一致**(除 MANIFEST 漂移本身外),水位的「数字不手抄」哲学执行到位。
5. 无真实密钥泄漏;git 历史干净线性(仅有 7 个 arena PR 合并)。

---

## 6. 建议的修复顺序(供你决定,本次未改动任何文件)

1. 【止血】跑 `npm run manifest` 重新生成清单并提交 —— 让 CI 变绿(一条命令,5 秒)。
2. 【止血】修 README §3 deploy/ 描述(删掉不存在的 probe/systemd 字样)—— 随 1 一起。
3. 【核验】在 CI(Ubuntu)上确认 42/42 全绿,排除我在 Windows 上见到的失败是平台伪影。
4. 【整理】决定 transfer/ 的归宿:哪些是一次性证据(ledger/盲测,必须留且不许重跑)、哪些是过时可删、哪些该转 docs/ 快照区;probes 资产要么修相对路径要么明确归档为「历史证据、不可运行」。
5. 【治理】给测试加 platform guard(Linux-only 的套件在 win32 上 SKIP 而不是 FAIL);给 docs 的「快照型」文档加过期横幅并按日期轮转。
6. 【长期】大文件走 Git LFS 或移出仓库(语料/数据集可放外部对象存储 + sha 引用,反正他们有 MANIFEST 文化)。

---

## 7. 一句话结论

**这不是「代码烂」,是「过程烂」**:核心引擎是一个被认真维护的科研型插件,但 2 周内 18 个 AI 身份、312 个提交、126MB 资产、97 处清单漂移、Linux-only 测试,把仓库推到了「每次接手都要先花一小时考古」的状态。最近 7 个提交尤其赶(13:50–14:00 连发),纪律(manifest 铁律)第一次系统性失效。(注:初版报告含一条「乱码」误判,已按 Node 全仓扫描结果撤回;数据文件编码完好。)
