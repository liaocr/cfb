# MEMORY（上下文压缩后第一件事：读这个文件）

## 常驻事实
- 密钥：`source /home/user/.secrets/keys.env`（DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL=a6api、DEEPSEEK_MODEL=deepseek-v4.1-flash、GITHUB_PAT 永久用）。用户授权落盘；不进 repo、不打印。
- 推送：`git push https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git HEAD:main`，只 fast-forward；作者 `cfb-cleanup <cleanup@local>`。
- repo /home/user/cfb；自检 `node verify.mjs`；改文件后 `node manifest.mjs`。
- 用中文回复。副模型 = 主模型关思考（永不再问）。目标 = 主模型更好（判断/专注），不是省钱、不是"不掉分"。
- 抽取式（x1）路线被否；不要"末尾保留原文"（除非理论证明）；不要多变体并跑。
- 省钱：每轮只测 raw + 1 个变体；样本砍半（每题 2）；改渲染用 `--recompile`（零成本），不重压。
- 流程（用户规定）：理论规划 → 实现 → 实测失败 → 归因（理论/实现）→ 理论问题先改理论，实现问题直接改 → 继续。
- 用户长期不在：自主迭代，工作留痕，记忆精简。

- 中转：主域 a6api.com 对沙盒 403（人机验证），用 https://api.a6api.com/v1（已写进 keys.env）。

## 数据
- 录制：/home/user/live-all/recordings.json（5 题）。raw 基线：/home/user/effect-5/results.jsonl（raw 每题 4 样本：总 5.4 / 直接改 40%）。
- 理论：docs/theory/CFB-THEORY-COMPLETE.md 第二部分 S8（R1 修订：判读 Pol、块尾放判读、第一人称、预算≥800、末尾不留原文）。
- 评测记录：docs/analysis/EFFECT-EVAL-2026-09-28.md。

## 测量须知
- 中转后端混杂：同一输入 prompt_tokens 差 300–450；claude 形 usage 丢思考；system_fingerprint=fp_dspure_app_v1 已验证拼接思考。
  ⇒ 评测一律 `--require-fp`，raw 与变体同一次运行、同一后端（effect-5/6 的 raw 基线混了后端，只作参考）。
- 结果两极（直接 edit ≈9–10 分 / 回头 read ≈2 分）；每题 2 样本 SE≈1 分，Δ<1.5 分不可判。

## 迭代日志（每轮一行：假设 → 结果 → 归因）
- it0（v12.5，086edb1 / 理论 82b86d4 已推送）：重压 → /home/user/direct-ops7d.json（带 side，5/5 有 IF，4/5 有 READY）。渲染修「若若」/尾段问句 → recompile → direct-ops7e.json。评测 → /home/user/effect-6（effect-5 拷贝 + v4p）。
- it1（ops7e，effect-6，混后端）：v4p 4.6/30% vs raw 5.4/40%。归因：IF 多为机理条件句，真判读（flaky「如果失败复现，再修」）漏了 → 理论 S8-R1′（IF cond=待回观察的结果）+ 实现（提示词 IF 定义、COND_RE 加 再/才、问句除外、READY 探查→PLAN）。
- it2（ops8b，effect-7，同后端受控）：**v4q 4.8/直接改 40%/死路 40% vs raw 4.2/30%/50%** —— 首次 ≥ raw（Δ 未显著）。剩余失败=「改之前先 read_file」→ 理论 S8-R2′（READY 带原文逐字位置锚点 at）。
- it3（ops9b，effect-8）：v4r 4.4/30%（wrong-model 2.0；无 READY ⇒ 无锚点）→ 理论 R2″（动作接口逐字代码行 ≤2 行必留，actionLoci）。
- it4（ops9c = ops9b + loci，recompile，effect-9）：v4s wrong-model 仍败；**本轮思考 <800 字 ⇒ 直接改 0%（n=9），≥2000 ⇒ ~50%** → 理论 R4′（语域→思考深度；层 A 改散文，cfg compressV4Prose）。
- it5（ops9p = ops9b + prose，effect-10）：**v4t 6.4/直接改 60%/死路 30% vs raw 4.2/30%/50%，Δ+2.2（4/5 题正）**。但本轮思考反而更短（1403）⇒ R4′ 机理（深度）不成立，效果成立 → 机理待改写。复现 n=20：**v4t 5.8/50%/死路 20% vs raw 5.0/50%/40%**，本轮思考 1574 vs 3719。散文设为缺省；R4′ 机理改写为「归属」假设。v12.5.0 = 4a3a091 已推送。

## 当前状态 / 下一步
- 仍输：wrong-model（raw 恒 9，v4t 5.8）。flaky 两组都 ~2.5（基准偏严）。
- 下一轮候选（先零成本归因再花钱）：wrong-model 的差异来源；「归属」假设的判别实验（同内容 散文 vs 行式 已测 = it5 vs it4）。
- 评测命令模板：`node tools/effect-eval.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --recordings /home/user/live-all/recordings.json --report NAME:v4=FILE --variants raw,NAME --samples 2 --concurrency 3 --require-fp --out DIR`（DIR 从 effect-10 拷贝可复用 raw）。
- 【turn 27 新方向】用户要我**亲手写压缩稿**（oracle）喂主模型，先找出最优形态，再固化成副模型提示词。
  纪律：写稿只看任务原文 + 原文思考；**不看 effect-specs 的 followup / reference**（否则泄漏）。稿件放 /home/user/oracle/。
- oracle 第1轮 A（/home/user/oracle/A.py→A.json；理论全修订的手写稿）：评测 effect-11（effect-10 拷贝 + oA）进行中。
- oracle 第1轮 A：5.8/50%/死路20%（=v4t）。失败样本本轮思考仅 117–215 字即 read_file；成功都 ≥1000。归因：节选代码行缺出处/逐字性 → 第2轮 B = A + 「read_file 原文，逐字，可直接作 old_text」。
- oracle 第2轮 B：6.1/50%/死路20%（eacces 9、flaky 7、perf 9；wrong-model 3.5「节选⇒先读全文」、sse 2.0 raw 也 2.3=题难）。第3轮 C = B 内容 + DeepSeek 原生语域（我们需要/看起来/所以/下一步工具调用/如果…那么），检验「归属」机理。effect-13。
- oracle 第3轮 C：**6.4/直接改 70%/死路 20%，本轮思考 4395**（C=B 内容+原生语域）⇒ R4″「语域→深度」成立（「我判断」不够原生）。理论 S8-R5/R4″、EFFECT-EVAL §11、渲染器已固化并推送。
- 下一步候选：副模型直接写原生语域散文（以 docs/analysis/oracle/C.py 为风格样例）+ 程序校验判读/锚点；wrong-model 仍输（raw 9 / C 5.5）。
- 第4轮（固化）：实现 compress-v4-direct（f091996，589 通过）：V4D 提示词（样例驱动）+ compileV4Direct 程序门。付费编译 direct-od.json（5 次副调用）进行中，effect-14 待跑。
- 第4–8轮（固化 C 形态 → compress-v4-direct，f091996/c2d1fea 等）：oD 4.8→oE 5.5（**wrong-model 10.0** 首超原文）→oF 6.0/3任务（**perf 10.0**）；oracle 上界 oC 6.4。flaky 2.0–2.5 不过（oracle 8.5）：副模型不肯在两个改法候选间落定 ⇒ 把复现排下一步（第8稿承认证据充分仍如此）＝判断力边界，候选出路=改法机械落定规则 / 代码写死「下一步=改法」句。effect-14/15/16，direct-od/oe/of.json。文档 CHANGELOG v12.6.0、理论 S8-R6、EFFECT-EVAL §12。
- compressV4Direct 仍缺省关（完整 5 任务上 oE 5.5 vs v4t 5.8 未全面胜出）；转正条件：flaky 落定机制 + 全集复测。
- 中转坑：非流式偶发 60s socket hang up（长输出必撞）；compile-direct 用 distillStream:true 稳。
