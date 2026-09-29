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
| 3 | v12.8.2–12.8.6 的全部实测产物（oM、effect-sub-eval-round1、v4d3 重压稿）**没入库**，新沙盒里不可复核 | 数字降级为传闻；本会话重测一次并入库 |
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

## 5b. 下一步（阶段 2：多轮台账基准）——不要再在 8 题基准上花一分钱

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
