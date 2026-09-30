# HANDOFF-V12.8 —— 迁移交接手册（v12.8.8，2026-09-29 第四会话重写）

> 这份文件在 `798f291` 里只提交了哈希、没提交正文（上一个沙盒随之丢失）。本版按 MEMORY.md / CHANGELOG / git 历史重写，并加入第四会话的审计与实测。
> 旧版 `transfer/HANDOFF.md`（第二 / 三会话写的）保留不动，作历史；**以本文件为准**，数字冲突处以 CHANGELOG 最新条目为准。

## 0. 三十秒接手

```bash
# 1 密钥（用户口头给 4 个值；API key 是 51 字的 sk-…，粘贴时容易重复两遍 ⇒ 401，先 `echo ${#DEEPSEEK_API_KEY}` 看长度）
mkdir -p /home/user/.secrets && chmod 700 /home/user/.secrets   # keys.env 0600，永不入库、永不打印
# 2 代码：工作分支 arena/01a0eba2-cfb（以远端最新为准）；main 只接 fast-forward / PR
git clone https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git /home/user/cfb && cd /home/user/cfb && git checkout arena/01a0eba2-cfb
git config user.name cfb-cleanup && git config user.email cleanup@local
# 3 离线自检（零网络）：清单必须「缺失 0」，自测必须「0 失败」
node manifest.mjs --check && node verify.mjs
# 4 数据放回工具期望的路径
mkdir -p /home/user/live-all /home/user/oracle && cp transfer/recordings.json /home/user/live-all/ && cp transfer/direct-*.json /home/user/ && cp transfer/oracle/* /home/user/oracle/ && cp -r transfer/effect-* /home/user/
# 5 通道体检（6 次 ≤60 token 的调用）：必须命中 TRUSTED_FP（fp_dspure_app_v1）且「拼接=是」；混合池占比决定评测费用倍数
set -a && source /home/user/.secrets/keys.env && set +a && node tools/channel-check.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL
```

## 1. 项目一句话

CFB（dsh-cot-form-b）：给 DeepSeek 宿主做**思维链压缩**——上一轮的 reasoning_content 被同一模型当作自己上一轮的思考续读，压缩稿的职责是让主模型下一步**判断更好、更专注**（直接改对、不回头 read、不死路、不错改），不是省 token。
副模型 = 主模型关思考（`deepseek-v4.1-flash`，经中转 `https://api.a6api.com/v1`）。**永不再问这是谁。**

## 2. 铁规矩（用户明说）

- 密钥在 `/home/user/.secrets/keys.env`（0600）；不打印、不入库。
- 改任何文件后 `node manifest.mjs`；提交前 `node verify.mjs` 必须 0 失败。CI（`.github/workflows/ci.yml`）跑同样两步 + `tsc --strict index.d.ts`。
- git 作者 `cfb-cleanup <cleanup@local>`；只 fast-forward，不 force；推 `arena/01a0eba2-cfb`，回 main 走 PR 或 `git push … arena/01a0eba2-cfb:main`（ff-only）。
- 省钱：每轮只测 raw + 1 个变体、每题 2 样本；改门 / 渲染规则用 `--recompile`（零成本），只有提示词改了才重压；评测一律 `--require-fp`。
- 流程：理论 → 实现 → 实测 → 归因（理论问题先改理论，实现问题直接修）。归因先读 `results.jsonl` 的 `reasoning` 字段，不要只看分数。
- 不要小碎步、不要参数磨分；**不为零点几分反复测**；提示词最多两轮付费迭代。
- 抽取式路线已否；不要末尾保留原文；不要 hybrid。
- 用户长期不在：自主迭代，工作留痕（产物进 `transfer/`），记忆写 `transfer/MEMORY.md`。

## 3. 本阶段目标（理论 S9 阶段 1，用户校准）

自动稿（副模型直写 `compressV4Direct`，无人工）在 5 基题 + 3 反驳题上：**基题综合 ≥ 8.0**（oracle oI 8.9）、**反驳题错改 0 且综合 ≥ raw**、死路 ≤ 10%、回头 read ≤ 10%、flaky ≥ 7；真机 `v4-live` 到位率 ≥ 80%；换宿主工具名 / 换中转不失效。
达标 ⇒ `compressV4Direct` 缺省 true，本基准退役，进阶段 2（多轮台账基准）。达不到 ⇒ 换方案（副模型两步：先写稿、再对清单自检），不磨参数。

## 4. 第四会话审计（2026-09-29；详见 CHANGELOG v12.8.8）

| # | 发现 | 处置 |
|---|---|---|
| 1 | `798f291` 只提交了 HANDOFF-V12.8.md 的哈希，文件没提交 ⇒ 分支 manifest 缺失 1、CI 红 | 本文件重写；manifest 重生成 |
| 2 | v12.8.3–12.8.7 改了五处判定逻辑：**零自测、零 CHANGELOG**；提示词三次改动 `promptVersion` 未换 | §5t1–5t4 四条自测（617/0/1）；CHANGELOG 补记五条；版本号 → `compress-v4d4` |
| 3 | v12.8.2–12.8.6 的实测产物当时**没入库**；用户随后抢救入库（`4ece275`：oracle/M、effect-21、effect-sub-eval、direct-subv4d3-live3）。抢救数据显示首轮 v4d3 稿 **5.1 / 错改 14% / perf~refute 0.0（2/2 错改）**；纪律注入后那批稿的主模型评测仍无产物 | 写进 CHANGELOG v12.8.8 审计 3；effect-20 是第一份全 8 题、0 错改的自动稿评测 |
| 4 | `draft-lint` 形态分不区分好稿坏稿：oH 12–13 分（wrong-model 0/2）vs oI 11–14 分；oI perf 7 分却 2/2 | 形态分只作写稿时的检查表，不作达标依据 |
| 5 | `tools/_dbg.mjs` 调试脚本入库；index.d.ts / README 熔断缺省写 1600（代码 1800）；长度约束三处不一致；API key 粘贴两遍 | 删 / 改 / 对齐 L13 上限 1650 / 修 keys.env |

**审视性结论**：上一会话把「形态分对齐 oracle」当成了目标，真正的目标（effect-eval 上自动稿 ≥ 8.0 且反驳错改 0）从未成套测过——尤其 v12.8.6 注入「绝对行动纪律」（看到结果就必须 edit_file、严禁再 read_file / sed）之后，**3 道反驳题没有复测**。这条纪律恰好是理论 S9 列的第四类弊端「言过其实」的形态：如果副模型把它写成全局命令而不是只挂在坐实分支上，反驳题就会出现错改。这是本会话唯一值得花钱回答的问题。

## 5. 第四会话实测（v4d4 首次成套；结果见 §5 末与 EFFECT-EVAL §16）

计划（一次性、不迭代）：
1. `compile-direct` 用 v4d4 重压 5 基题（5 次副调用）→ `transfer/direct-d4.json`（看 `accept=` 与 gate 统计）。
2. `effect-eval` raw 复用 effect-19，只补 `d4` 8 题 × 2 样本（16 行；混合池按命中率放大）→ `transfer/effect-20/`。
3. `v4-live --replay` 直写模式量真机到位率（6 次副调用）→ `transfer/live-direct/`。
4. `effect-pairs` + 读 `reasoning` 归因；按 §3 判达标与否；只写结论，不再重压。

**结果（2026-09-29；详见 CHANGELOG v12.8.8、EFFECT-EVAL §16）**

| 项 | 门槛 | 实测 | 判 |
|---|---|---|---|
| 基题综合（5 题 × 2） | ≥ 8.0 | **8.5**（eacces 6.0 / flaky 9.0 / wrong-model 9.0 / sse 8.5 / perf 10.0；raw 5.0） | ✓（边上） |
| 反驳题 | 错改 0 且 ≥ raw | **0 错改**；6.5 vs raw 5.0（9.5 / 6.0 / 4.0，逐题 ≥ raw） | ✓ |
| 死路 / 回头 read | ≤ 10% / ≤ 10% | 0% / 6% | ✓ |
| flaky | ≥ 7 | 9.0 | ✓ |
| 真机到位率（v4-live 直写） | ≥ 80% | 4/5 = 80%，finish 多扣 p50 6.0 s（11 k 字录音超时） | ✓（边上） |
| 换宿主工具名 / 换中转 | 不失效 | 自测 5s5 / channel-check | ✓ |

先写的预测（综合 < 8.0、反驳错改 > 0）**被证伪**：「绝对行动纪律」没有吞掉反驳路。真机首压抓到一个门 bug（分句切在反引号内，sse 稿整份会被原文放行），已修 + 自测。
⇒ **按既定规则转正**：`compressV4Direct` 缺省 true（只影响显式 `compressPrompt:'v4'` 的部署；全局缺省仍 v3）。**本基准退役**。

## 5c. 第五会话（2026-09-29 晚）：v4d5 回退 → v4d6「选择题化」进入 oracle 带（CHANGELOG v12.8.9、理论 S8-R11、EFFECT-EVAL §17）

**用户校准**：手写 oracle I 的 8.9 是理论值；要的是自动稿**稳定**到手写水平，不是提示词写全。「别去测 oracle」。

**结论一句话**：把落点选择从「在 10k 字原文里回忆」变成「在程序算好的 ≤ 8 行【在手的代码行】里挑」+ 正文落定句 + new_text 必写，两份独立自动稿 **8.5 / 8.6**（raw 5.0、v4d4 7.8），死路 / 错改 / 回头 read 全 0。

| 版本 | 主落点命中 | 主模型评测 | 备注 |
|---|---|---|---|
| v4d4（d4b） | 4/5 | 7.8 | 上会话 |
| v4d5（d5c/d5d） | 5/10 | 6.5 / 7.0 | 回退：样例第二分支改成命令 ⇒ perf 第二个三元组变取证；「逻辑改动只写意图」⇒ sse 不落定 |
| v4d6 + 在手清单 + 行类别（d8a–c / d9a） | **14/14、8/8** | **8.6 / 8.5** | `transfer/effect-23` |

**别再犯**：flash 抄样例不读规则——改样例前先想它会被抄成什么；R10.3「逻辑改动只写意图」对主模型对、对副模型错；出处时效句会被泛化成「等输出带回那一行」，规则里已封死。

**方法**：`tools/compile-direct.mjs` 每版压 2–3 遍（便宜）→ `tools/closure-check.mjs`（主落点 / 三元组 / 落定句 / 门缺陷 / 长度）→ 只对闭合率高的版本花钱 `effect-eval`。闭合率预测了评测结果。

**产物**：`transfer/direct-d5c/d5d/d6a–c/d7a–c/d8a–c/d9a/d9b.json`、`transfer/effect-23`（累计 results：含 v4d5 的 d5c/d5d 与 v4d6 的 d9a/d8a，以及此前全部变体）。

**未解**：稿长均值 ≈ 1630（1–2/15 超 1800，熔断 2000）；中转抖动（副模型单次 5–90 s，两次 150 s 超时）⇒ 真机到位率待复测（未跑 v4-live）；n 小（两份稿 × 1 样本）；
再压方差的下一杠杆 = 并行压两份按门缺陷选一份（零延迟、副模型 ×2，未做）。wrong-model~refute 6.0 是忠实压缩的边界，不要再在它上面花钱。

## 5d. 第五会话末段（2026-09-29 深夜 → 09-30）：阶段 2 开工——理论 S10、台账、v4d7、多轮评测（详见 CHANGELOG v12.9.0、EFFECT-EVAL §18、理论 S10.1–S10.11、`transfer/LIVE-MEMORY.md`）

用户给的流程：理论 → 实现 → 出问题先归因（理论 / 实现）→ 修 → 继续；测试少一点；留痕不堆垃圾；**实时记忆**在 `transfer/LIVE-MEMORY.md`（压缩后先读）。

**做了**
- 2a：v4-live 复测 v4d6 —— 6 s 窗口 0/5 到位、12 s 3/5（中转慢一倍；昨天 4/5）。窗口缺省没改（用户决定）。
- 理论 S10：多轮台账（四个弊端 ↔ 台账缺哪一栏；第 t 轮稿四段；不变量 I-A…I-E；度量；基准设计；预注册预测）。
- 实现：`buildLedger / ledgerBlock`（src/messages.js）自动进 `compressCtx`；`compress-v4d7`（台账在手时四段规则 + 第 2 轮样例；验收命令只能取自【本轮已发出的调用】）；样例整句抄写剥离；工具 effect-mr / compile-mr / traj-fixtures / traj-run / closure-check。
- 2b（第 3 轮，`transfer/mr`）：红题 raw 5.8 / 手写 oracle **8.6–9.5** / 自动 v4d7 6.9；绿题都 9+。三次归因：推翻路必须单命令；sse 红题基准写错（rawFinish）；ASK 与调用协议冲突。**手写稿含预见 ≠ 忠实压缩**（层 A / 层 B）。
- 2c（全轨迹，`transfer/traj1–3`）：循环里每轮思考中位数 ≈ 600–1000 字 ⇒ 生产门槛 3100 下压缩几乎不触发；无门槛两批合并：auto-all 修好 5/5、3.4 轮、13.2 k tokens vs raw 5/6、4.0 轮、16.8 k；ledger（程序台账不压）5/6、4.0 轮、19.1 k ⇒ **H-ledger 不成立**，压稿价值 = 效率；言过其实三变体都出现 ⇒ 宿主策略层强制验收（理论 S10.12）。

**结论与建议（给用户决定）**
1. 产品形态：编码 Agent 多轮循环里，**程序台账**（已改 / 已走过的路 / 状态，零副模型成本）应成为一等特性；副模型稿只在长思考轮（≥ 门槛）有意义。是否把台账独立于压缩注入，需要用户拍板（改的是 plugin 出站消息的形状）。
2. 真机窗口：6 s 在中转慢时段到位 0/5；要么自适应，要么抬缺省（用户体感代价）。
3. 中转：可信后端按内容黏住，作废重发要打散（零宽空格）+ 探针（max_tokens 1 只花 prefill）——已在 traj-run / effect-mr 里做，effect-eval 未改。

**别再犯**：写 canned 观察前先把语义跑一遍；问法要与模型的调用协议兼容；手写 oracle 别把自己的预见当压缩的上限。

## 5e. 第六会话（2026-09-30）：多轮稿 v4d8「可推导的预见」——红题自动稿追平手写 oracle（CHANGELOG v12.9.1、EFFECT-EVAL §19、理论 S10.13–S10.18、`transfer/LIVE-MEMORY.md` §6）

用户裁定：多轮没到上限 ⇒ **实现层去修、理论层去搜文献补**；给主模型它自己没有的东西，但必须「无论什么情况下都是优化」。

**做了**
- 渠道：用户先后换了两条新渠道，简单测（6–7 次调用）都不可用作主模型（fp=null、历史 reasoning 被丢、`deepseek-v4-1-flash` 甚至没有 reasoning 字段）；回到原渠道后继续。可用主渠道的三个硬指标写在 LIVE-MEMORY §3。
- 理论：层 B+ = 从 ctx **推导**的观察谓词 + 不含任务事实的通用调试知识，六条 K（K1 新鲜 / K2 条件 / K3 参数跟随 ⇒ 取证 / K4 新出现者 / K5 收工三问 / K6 零效应 ⇒ 消费点），每条带不变性论证；评委修订（记忆、3 票、动作类）；预注册 P5–P9 与对账。
- 实现：`verifyHints`（程序算提示，副模型只转述）、四段体 + 收工三问、提示片段进核真集合、多轮熔断 2600、片段级抄样例剥离；effect-mr `--rejudge` / `--judge-votes` / 动作类；compile-mr `--recompile` / 形态检查。
- 数字（每格 n = 2，只看方向）：红 raw 4.9 / v4d7 6.5 / 手写 oracle 7.8 / **v4d8 8.0**；绿 raw 9.2 / oracle 9.6 / **v4d8 9.8**；假完成 0/20。两次归因都落在理论（K3 措辞、K6 缺失），修完各自 2/2 走对。

**给下一位的判断**
1. 稿这条线上，自动稿在红题已到手写水平；再往上要么更大 n（每格 ≥ 5，≈ 100 主调用），要么新任务（现有 5 题已被理论「看过」，泛化未证）。
2. 真正的杠杆仍在宿主：birthMinChars 3100 使循环里几乎不触发压缩（2c 0/9 轮）；6 s 窗口到位 0/5；「收工前强制验收」是宿主策略（S10.12）。这些都是用户的产品决定。
3. 评委：只发调用的回答看不到意图（flaky #0 票 8/2/1）；若要更稳，让评委同时看 reasoning 的末 300 字——未做。

**别再犯**：`--rejudge` 多个文件时先到先得，规范改过的题（sse）只能用改后那批；重评前把 `--only` 按规范版本分开。

## 5b. 下一步（阶段 2：多轮台账基准）——8 题基准只剩「更大 n 复核 v4d6」一件事值得花钱

1. 先零成本设计：≥ 10 道**多轮、可执行、带隐藏验收**的任务（每道 3–6 轮：探针 → 改 → 验证 → 再改），任务放 `tools/effect-specs-v2.json`；度量按理论 S9 表（一致性违规、重复取证、假完成、循环、到修好的步数）。
2. 台账形态规格从阶段 1 的三条缺口起草（理论 S9「阶段 1 收官」）：第二分支命令级；落点行跨轮携带并标注观察时刻；长度靠门（熔断 / 分段）不靠字数指令。
3. 副模型评测只在多轮 harness 成型后做；先用 oracle（手写台账）找上界，再固化。每轮仍是 raw + 1 变体。
4. 全局缺省 v3 → v4 直写是产品决定（每回合多 ≈ 6 s 收网 + 一次副调用），留给用户；代码里只需 `compressPrompt:'v4'`。
5. 若中转可信后端占比 < 30%，别跑主模型评测（费用 ×3 以上）。

## 6. 工具速查

```bash
source /home/user/.secrets/keys.env
# 付费重压（改了提示词才做）
node tools/compile-direct.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --modes v4 \
  --cfg '{"compressV4Direct":true,"distillStream":true}' --recordings /home/user/live-all/recordings.json \
  --only eacces-config,flaky-timeout,wrong-model,sse-truncated,perf-regression --out /home/user/direct-XX.json
# 零成本重编译（改了门 / 渲染）
node tools/compile-direct.mjs --recompile /home/user/direct-XX.json --recordings /home/user/live-all/recordings.json --out /home/user/direct-XX2.json
# 评测（raw 复用；只补新变体；每题 2 样本）
rm -rf /home/user/effect-N && cp -r /home/user/effect-19 /home/user/effect-N
node tools/effect-eval.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --recordings /home/user/live-all/recordings.json \
  --report XX:v4=/home/user/direct-XX.json --variants raw,XX --samples 2 --concurrency 3 --require-fp --out /home/user/effect-N
# 归因（零调用）
node tools/effect-pairs.mjs --results /home/user/effect-N --variants raw,XX --report XX=/home/user/direct-XX.json
node tools/draft-lint.mjs --recordings /home/user/live-all/recordings.json --results /home/user/effect-N --report XX:v4=/home/user/direct-XX.json
# 真机到位率（副模型调用 × 录音数；看每行 hold= 与 why 分布）
node tools/v4-live.mjs --replay /home/user/live-all/recordings.json --modes v4 --cfg '{"compressV4Direct":true,"distillStream":true}' \
  --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --out /home/user/live-direct
```

## 7. 测量须知

- 中转是混合池：只有 `fp_dspure_app_v1` 拼接上一轮 reasoning_content；claude 形 usage / fp=null 的后端丢思考 ⇒ 对它们 CFB 不可见。`--require-fp` 会作废重发，费用 ≈ 1/命中率（第四会话 33% ⇒ ×3）。
- 分数两极（直接 edit ≈ 9–10 / 回头 read ≈ 2）；每题 2 样本 SE ≈ 1 分，Δ < 1.5 不可判；但「错改」是二值，一次错改就足以证伪「错改 0」。
- 非流式副调用偶发 60 s socket hang up ⇒ `distillStream:true`。
- 直写真机：整块编译 3.6–10.9 s / 块，收网窗口自动抬到 6000 ms（`compressV4DirectMinWaitMs`）；评测分是离线编译的，转正前必须看 `v4-live` 的 hold / 到位率。

## 8. 文件地图

- 代码：`src/compile-v4.js`（compileV4Direct / bindFixBranches / isFixBranch / fileVerbatim）、`src/fidelity.js`（发明标识符闸 / new_text 段）、`src/prompts.js`（V4D_HEAD = v4d4）、`src/birth.js`（birthAccept 生产闸）、`src/messages.js`（buildCompressCtx / editToolOf）。
- 工具：`tools/compile-direct.mjs`、`tools/effect-eval.mjs`（+ `effect-specs.json` 8 题）、`tools/effect-pairs.mjs`、`tools/draft-lint.mjs`、`tools/v4-live.mjs`、`tools/channel-check.mjs`。
- 理论：`docs/theory/CFB-THEORY-COMPLETE.md` S8（R1–R10）、S9（终局与阶段）。评测记录：`docs/analysis/EFFECT-EVAL-2026-09-28.md` §11–§16。
- 数据：`transfer/recordings.json`（6 条录音）、`transfer/direct-*.json`（各轮稿；带 `side` 的可重编译）、`transfer/oracle/*.json`（手写稿）、`transfer/effect-1…20/`（评测行，effect-19 含 raw 全集）。
