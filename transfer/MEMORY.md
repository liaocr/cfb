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

## 2026-09-29 第二会话（接手；Arena 沙盒，分支 arena/01a0eba2-cfb）
- 环境恢复照 HANDOFF 做完，verify 590/0/1；密钥写 /home/user/.secrets/keys.env（0600）。
- **归因（零成本，读 effect-16 逐样本）**：flaky 的 oC 与 oE/oF「下一步」都是 taskset 复现；差别只在分支动作项：oC 分支句内有
  「改测试 §4 的 hedgeAfterMs: 1600（可直接当 old_text）不用再继续复现」⇒ 主模型 2/2 edit_file old_text=hedgeAfterMs: 1600；
  oE/oF 分支「拉开或改用 fake timers 即可」+ 末尾游离通用可用句 ⇒ 4/4 read_file test/hedge.selftest.mjs。perf oF（分支内绑定）10.0 vs oE（游离句）6.0；
  eacces oC（落定一个候选 + 那一行可用句）9.0 vs oF 6.0。⇒ R6「副模型不肯落定＝判断力边界」偏了：是形态规格缺口（分支 then 未被要求 R2′ 闭合、R5 可用句游离）。
  评测消息 = [system, 任务, assistant{可见回答含已发出调用, reasoning=变体}, 工具结果] ⇒「下一步工具调用是 X」必须 = 可见回答那条；R6 的下一步仲裁与之矛盾且没赢过一次 ⇒ 撤回。
- **理论 S8-R7** 写入（分支闭合 / 落点绑定 / 机械落定 / 回溯一致 / 程序门 / 可证伪预测）。
- **实现 v12.7.0**：`bindFixBranches`（compile-v4.js；cfg compressV4DirectBind 缺省开）+ 提示词 compress-v4d2（样例改为两分支闭合 + 候选落定）+ §5p 六条自测；verify 596/0/1。
  迭代中修掉的门坑：40% 尾段切在句中（改为整句 + 跨线句算尾段）；光秃标识符 / 路径 / 命令 / 日志 / diff `-` 行 / import 行不作落点；「补 `X`」的 X 是新文本；
  「而不是改 …」否定；「需要改用 docker 再复现」= 换复现手段不算改法；文中已引的行不再吃「与全稿重叠」加分（自我强化）；值行按「token 作键 +4 / 作值 +2」；
  分支的下一句已有可用句也算 had（oracle 稿写法）。
- 零成本重编译（direct-og-src.json → direct-og.json）：flaky 6/6 绑 `hedgeAfterMs: 1600`；eacces env 行 / 测试行；perf `+  compressTargetMax: 1800,`；wrong-model observe/callConfig；
  sse `f === '[DONE]'`（调用方不在手）；oracle A/B/C 已有可用句的分支不动，缺的绑到与参考一致的行（sse → return 行）。
- **沙盒外网被切**：curl api.a6api.com / api.deepseek.com / example.com 全部 SSL_ERROR_SYSCALL（github/npm/pypi 200）⇒ 付费编译、评测一次都没跑。
  第 A 轮（oG，零成本稿）与第 B 轮（v4d2 重压 → oH）命令写在 HANDOFF「下一步」。预测：oG flaky ≥ 7；否则回到 R6 判断力假设。
- 推送：平台只允许 `arena/01a0eba2-cfb`；回 main 需另一方 fast-forward。
- 续：补生产前提 `compressCtx` 自动构造（messages.js buildCompressCtx + plugin compressCtxFor；cfg compressCtxAuto/compressCtxMaxChars；§5q 三条；verify 599/0/1）。
  sse 逐样本：全部稿（含 oracle）都 `sed -n '200,245p' src/transport.js`——工具结果里 `ok: r.finish === 'stop'` 没被任何分支覆盖 + 改法跨两处 ⇒ 记为 R7 之后的缺口「判读覆盖」。
  ops 路的 R7（合成 READY + bindLocus）作后备候选未做。
- 续：写 hook-wiring §6 端到端（真实 apply()：tool-result → compressCtx → 提示词 → 核真 → 绑定）时抓到**生产 bug**：birth.js 发明标识符闸只对原文查，
  `edit_file`/`old_text`（R5 可用句自带）被当发明 ⇒ 整份稿 invented-identifier 放行；v12.5 起潜伏，评测绕过 birth.js 从没暴露。
  修：fidelity.GATE_ALLOW 豁免模板接口词；inventedIdentifiers(src,out,{extra: compressCtx})；birth.js 传 compressCtx。compress §4b2/§4c2。verify 602/0/1。
- 续：直写生产接线——v4Incremental 在 compressV4Direct 下恒 false（否则分段器接管、直写永远不跑）；收网窗口自动抬到 compressV4DirectMinWaitMs 6000
  （真机 3.6–10.9 s/块 vs 缺省 1500）。转正前必须用 v4-live 量真实命中率。verify 603/0/1。
- 续：compile-direct 加 accept 列（birthAccept 纯函数抽出）⇒ 发现第二个真机误杀：gateTokens 的 `…`≤80 正则在长片段下把散文配成代码（oG 3/5 会被放行）。
  改 split 配对；历史 138 份稿 135 过闸（3 份真编造）。oG 五份 accept=ok。verify 604/0/1。
- 续：R7 用到 ops 路——validateOps 认 ctx 出处、无 at 的 READY 用 bindLocus 绑、autoHint 去项目符号、FIX_RE +拉大/增大/调大/调小；
  ops9p 重编译 → direct-ops9u.json（flaky 尾段闭合到 `hedgeAfterMs: 1600`）。compile-direct 的 ops 行也带 ctx。verify 606/0/1。
- 续（用户提醒要查外部资料）：沙盒网络 = 出口白名单（github/api.github/npm/pypi 可达；其它域名 TLS 握手被切，含 deepseek/a6api/example.com），
  web_search/fetch_page 工具在沙盒外可用。检索并写进理论 S8「外部佐证与定位」：DeepSeek Thinking Mode 官方（带 tools ⇒ 所有前轮 reasoning_content 拼进上下文）；
  JetBrains Complexity Trap（观察遮蔽≈摘要，摘要使轨迹 +15%）；morph「re-reading loop」/「exact-match penalty」；ACON（成对失败分析修订压缩指南）。
  新工具 tools/effect-pairs.mjs（成对归因 + 动作类别分布：raw 回头 read 35%、v4t 50%、oE 60%、oC 20%）。verify 607/0/1。
- 迁移前终态（5812ec6）：本会话 11 个提交全部在 arena/01a0eba2-cfb；main 可 fast-forward。未跑任何付费步骤。待办 = A/B/C 三轮 + v4-live hold。
  网络诊断结论：出口白名单（github/api.github/npm/pypi 通；其余域 TLS 被切；DNS/TCP 正常 ⇒ 透明代理按 SNI 放行）。

## 2026-09-29 第三会话（接手；网络通）
- 环境：clone 分支 → keys.env（0600）→ 数据放回 → verify 607。curl 首次超时一次（重试 200），不是白名单。
- **A 轮 oG**：5.7 / 直接改 60% / 回头 read 40%；flaky 7.0（2/2 edit `hedgeAfterMs: 1600`）⇒ R7 成立。失败 3/4 是短思考（299/527/691 字）。
- **B 轮 oH**（v4d2 重压 6 次副调用：perf/sse 撞 1300 熔断 → 熔断改 1600 零成本重编译；eacces 超时重跑）：5.8 / 70% / 30%；flaky 8.5、eacces 8.5、wrong-model 2.0。
  中转变差：新指纹 fp_5a4b7738a7d3（922 tokens，丢思考，不可信）、0 字思考样本。
- **工具**：effect-eval 落盘主模型 reasoning（头 6000 字）、no-thinking 作废重发、盲评失败只补盲评；compile-direct 错误行记 promptVersion。
- **归因（读主模型原话）**：perf「diff 行实际文件里可能没有加号，先 read_file 确认」；wrong-model「Need to see normalizeRequest to confirm n.model」+ 全部压缩稿 10/24 vs raw 4/4
  （逻辑改动没给 new_text ⇒ 回头读文件拿设计材料）；sse 观察里冒出稿没覆盖的 rawFinish。⇒ 理论 S8-R8a 文件逐字 / R8b 三元组 / R9 判读覆盖 / 定义处优先。
- **oracle I**（I.py，三题，预测先写）：wrong-model 9.0（3/3，new_text 被原样采用）、perf 9.0（2/2）、sse 8.5（2/2）；三题 8.9 / 100% / 0% 回头 read。
- **落地 v12.8.0**（未付费实测）：fileVerbatim + normalizeQuotedLoci（R8a）、new_text 出处闸（R8b，birth 与程序门同口径）、hedgedTrigger 统计、compress-v4d3、熔断 1600。verify 612/0/1。
- **用户指令**：副模型先别测；主模型没突破前，自己写稿测主模型，最小成本，先查资料再动手。外部资料本轮：Thought Anchors（arXiv 2506.19143：plan / 回溯 / 自检句是注意焦点）、
  Overthinking（arXiv 2502.08235：LRM 在 agent 里偏内部推理而少环境交互——我们的失败是反向：多一次取证）。
- 下一步：oracle 补全五题（4 次主调用）→ 单因子消融（≤6 次）→ 才回副模型 v4d3。

## 2026-09-29 晚（同一会话续）
- 用户换渠道 → channel-check 发现该渠道不认 thinking、指纹空、**丢 reasoning_content**（372=372）⇒ 不可用；换回后混合池可信 50%。
- 消融（10 次主调用）：noNew 3/3、noClose 3/3、noPre 2/2（思考翻倍）、noNote 1/2 ⇒ R8b 证伪；R10 明文清单 + 短思考中介。
- 反驳题（12 次）+ 五题补全（4 次）：oI 五题 8.9；反驳 6/6 错改 0（perf~refute 9.5 / wrong-model~refute 6.5 / flaky~refute 7.0；raw 5.0/6.0/4.0）。
- 用户校准：终局目标不是分数（四类原生弊端：前后脱节 / 掩盖全错 / 死锁内耗 / 言过其实）；本阶段目标调高到自动稿 ≥ 8.0 + 反驳错改 0；不为小分反复测；副模型评测等口令。
- 零成本落地 v12.8.1：宿主工具名自适应（editToolOf / adaptEditTool / compressEditTool）、v4d3 收口（四问明文、new_text 只换值类、第二分支具体 + 逃生句）、评测 base/错改列、channel-check。verify 613/0/1。PAT 仍失效。

- 续（2026-09-29 深夜）：解决副模型直接编译（v4d3）超长熔断与误判问题
  1. 诊断：副模型在 `sse-truncated` (1842字) 和 `perf-regression` (1717字) 超过默认 1600 字阈值报错 `v4d-too-long`；且 `sse-truncated` 分支中「改为在 grep 结果里看」被 `isFixBranch` 当作改法分支，导致落点绑定插入冗余可用句膨胀至 1968 字且破坏语法片段。
  2. 修复：
     - `src/compile-v4.js`：`WEAK_FIX_RE` 扩充增加「改为」，当后接取证动词时正确判定为取证分支而非改法分支，消除错误落点绑定。
     - `src/prompts.js`：修改 V4D_HEAD 第 7 条，由宽泛建议「700~1300 字符」强化为严格硬约束「严格控制字数在 1000~1400 字符（上限绝不能超过 1500 字符）：主体分析务求紧凑精炼，不要铺陈过多代码行与繁琐推论；判读分支各一两句话说清核心逻辑与落点即可，严防冗长注水」。
  3. 验证：`node manifest.mjs` && `node verify.mjs` 613 通过 / 0 失败 / 1 跳过；提交 `2ce14b3`。
