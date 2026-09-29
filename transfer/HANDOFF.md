# 接手手册（新会话零记忆开工，2026-09-29 交接）

你是接手者。项目 = 本仓库 `dsh-cot-form-b`（cfb）：给 DeepSeek 宿主（DSH）做思维链压缩，目标是**主模型更好**（判断力/专注力），不是省钱、不是"不掉分"。用**中文**回复。

## 必读顺序（都在本仓库）
1. 本文件
2. `transfer/MEMORY.md`（上一会话的实时记忆，含全部迭代日志）
3. `docs/analysis/EFFECT-EVAL-2026-09-28.md` §11–§12（oracle 实验 + 自动稿三轮）
4. `CHANGELOG.md` v12.7.0 / v12.6.0；`docs/theory/CFB-THEORY-COMPLETE.md` 第二部分 S8（R1…R7，R7 是本次的归因与规则）；EFFECT-EVAL §13

## 环境恢复（把测试数据放回工具期望的路径）
```bash
mkdir -p /home/user/live-all /home/user/.secrets /home/user/oracle
cp transfer/recordings.json /home/user/live-all/recordings.json
# keys.env 不能进 GitHub（机密扫描拦截）⇒ 让用户在对话里粘贴 4 个值，写入 /home/user/.secrets/keys.env：
#   DEEPSEEK_API_KEY=...  DEEPSEEK_BASE_URL=https://api.a6api.com/v1  DEEPSEEK_MODEL=deepseek-v4.1-flash  GITHUB_PAT=...
cp transfer/direct-*.json /home/user/
cp transfer/oracle/* /home/user/oracle/
cp -r transfer/effect-* /home/user/
cd /home/user/cfb && node verify.mjs   # 应 607 通过 / 0 失败 / 1 跳过（v12.7.0）
```

## 铁规矩（用户明说的，别问、别违反）
- 副模型 = 主模型关思考（deepseek-v4.1-flash，经中转 https://api.a6api.com/v1）。**永不再问这是谁**。
- 省钱：每轮评测只测 **raw + 1 个变体**、每题 2 个样本；不要多变体并跑、不要反复重压。改渲染/编译规则一律 `--recompile`（零成本），重压（副模型调用）只在提示词改动后才做。
- 流程：理论规划 → 实现 → 实测失败 → 归因（理论问题先改理论；实现问题直接修）→ 继续。自主迭代，工作留痕，别停下问。
- 用户不要"修修改改"的小碎步，要系统性推进；理论要有真推进（他嫌过"皮毛"）。
- 抽取式路线已否；**不要末尾保留原文**；不要 hybrid"压缩前缀+原文尾巴"。
- git：作者 `cfb-cleanup <cleanup@local>`；**只 fast-forward，不 force push**；推送命令：
  `git push https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git HEAD:main`
- 改任何文件后 `node manifest.mjs` 再提交；自检 `node verify.mjs`。
- 中转域名主站 a6api.com 对沙盒 403，必须用 api.a6api.com（keys.env 里已是对的）。

## 测量须知（不照做会白烧钱）
- 中转后端混杂 ⇒ 评测一律 `--require-fp`；raw 基线必须和变体**同一次运行**复用（effect-eval 自动复用已有行，加 `--samples` 只补缺的）。
- 分数两极分布（直接 edit ≈9–10 / 回头 read ≈2）；每题 2 样本 SE≈1 分，Δ<1.5 不可判。
- 非流式副调用偶发 60s socket hang up（长输出必撞）⇒ compile-direct 用 `distillStream:true` 稳。
- thinking 必须显式开；Claude 形通道会丢历史 reasoning；502 波动；`--require-fp` 过滤混杂后端。

## 工具命令模板（tools/ 都在仓库里）
```bash
source /home/user/.secrets/keys.env
# 付费编译（副模型 5 次调用；改了提示词才做）：
node tools/compile-direct.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL \
  --modes v4 --cfg '{"compressV4Direct":true,"distillStream":true}' \
  --recordings /home/user/live-all/recordings.json --out /home/user/direct-xx.json
# 零成本重编译（改了渲染/门规则就用这个）：
node tools/compile-direct.mjs --recompile /home/user/direct-xx.json \
  --recordings /home/user/live-all/recordings.json --out /home/user/direct-xx2.json
# 评测（raw 复用，只补新变体；effect-16 是累计结果目录，--samples 2 继续往上加）：
node tools/effect-eval.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL \
  --recordings /home/user/live-all/recordings.json \
  --report v4t:v4=/home/user/direct-ops9p.json --report oE:v4=/home/user/direct-oe.json \
  --report 新变体:v4=/home/user/direct-xx.json --variants raw,v4t,oE,新变体 \
  --samples 2 --concurrency 3 --require-fp --out /home/user/effect-17
```

## 现状（截至 2026-09-29 第二次交接；上一次交接的现状保留在 MEMORY.md）
同后端 n=10/组（原文 n=20）：raw 5.0｜v4t(ops 散文) 5.8｜oracle 上界 oC 6.4/直接改 70%｜
oD 4.8 → oE 5.5（**wrong-model 10.0**）→ oF 6.0(3 任务，**perf 10.0**)；flaky 自动稿 2.0–2.5 vs oracle 8.5。
- **本次归因（理论 S8-R7，CHANGELOG v12.7.0，EFFECT-EVAL §13）**：逐样本对读 effect-16——oracle 与自动稿的「下一步」都是复现，
  差别全在判读分支的动作项：oC 在分支句里写了「改测试 §4 的 `hedgeAfterMs: 1600`（原文就是这几个字，可直接当 old_text），不用再继续复现」
  ⇒ 主模型 2/2 直接 edit；自动稿写「拉开或改用 fake timers」+ 末尾游离的通用可用句 ⇒ 4/4 回头 read。perf 也是同一规律（oF 分支内绑定 10.0，oE 游离句 6.0）。
  这不是判断力边界，是形态规格缺口：**分支的 then 是 READY，必须闭合（文件 + 逐字落点 + 改法）并把可用句绑在落点上、写进分支句内**；
  「下一步工具调用是 X」必须是可见回答里那条（回溯一致），R6 的「下一步仲裁」撤回。
- **已落地（v12.7.0，未实测）**：程序门 `bindFixBranches`（`compressV4DirectBind`，缺省开）：分支切分 → 改法判定（含否定 / 换复现手段排除）→
  落点绑定（标识符 / 数字 / 文件名重叠；命令、日志、路径、diff `-` 行、import 行不作落点；「补 `X`」的 X 不是落点）→ 可用句写进分支句内。
  提示词 `compress-v4d2`（分支闭合 + 候选落定 + 回溯一致 + 闭合样例）；`compressCtx` 自动构造（生产前提）；发明标识符闸豁免模板接口词 + 出处含观察。自测 602/0/1。
  零成本重编译既有稿：flaky 6/6 绑到 `hedgeAfterMs: 1600`，perf 绑 `+  compressTargetMax: 1800,`，eacces 绑 env 行 / 测试行，oracle 稿已有可用句的分支不动。
- **本会话沙盒外网被切**（只放行 GitHub / npm / pypi；`api.a6api.com`、`api.deepseek.com` TLS 握手直接断），付费编译与评测一次都没跑成。
  下面两轮是接手者的第一件事（换一个能出网的环境）。

## 下一步（按顺序；每轮只测 raw + 1 个变体）
```bash
source /home/user/.secrets/keys.env
# 第 A 轮（零成本稿已备好：transfer/direct-og.json = oF 的 eacces/flaky/perf + oE 的 wrong-model/sse 的副模型输出 + R7 门）
rm -rf /home/user/effect-17 && cp -r /home/user/effect-16 /home/user/effect-17   # 复用 raw n=20
node tools/effect-eval.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL \
  --recordings /home/user/live-all/recordings.json --report oG:v4=/home/user/direct-og.json \
  --variants raw,oG --samples 2 --concurrency 3 --require-fp --out /home/user/effect-17
#   预测：flaky ≥ 7（主模型直接 edit_file old_text=hedgeAfterMs: 1600），perf/eacces 不降。
#   若 flaky 仍回头 read ⇒ 绑定不是症结，回到 R6 判断力假设（理论 S8-R7 第 6 条写了这个可证伪点）。
# 第 B 轮（提示词 v4d2 才需要重压，5 次副模型调用）
node tools/compile-direct.mjs --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --modes v4 \
  --cfg '{"compressV4Direct":true,"distillStream":true}' --recordings /home/user/live-all/recordings.json --out /home/user/direct-oh.json
#   先看 gate 统计：boundBy 是否全是 had（副模型自己闭合了）、disjunctiveFix 是否为 0、outChars ≤ 1300；再评 oH（同上命令换 --report oH:v4=... --variants raw,oH）。
# 两轮任一 综合 ≥ 6.4 且 flaky ≥ 7 ⇒ src/config.js 把 compressV4Direct 转正（缺省 true），CHANGELOG 记数字；否则按归因流程继续。
```
- 改门规则只 `--recompile`（`direct-og-src.json` 是 5 条 side 输出的合集，可反复重编译）；改提示词才重压。
- 归因用 `node tools/effect-pairs.mjs --results /home/user/effect-17 --variants raw,oG --report oG=/home/user/direct-og.json`（零调用）：
  成对列出压坏 / 压好的样本 + 压缩稿收尾 + 动作类别分布（看 reread-known 率，oracle C 是 20%，raw 35%）。
- 外部佐证已写进理论 S8 末「外部佐证与定位」（DeepSeek 官方：带 tools 时所有前轮 reasoning_content 都拼进上下文；JetBrains Complexity Trap；ACON）。
  以后遇到新问题先查文档 / 论文再动手（用户明确要求）。
- 同会话补的生产前提：`compressCtx` 自动构造（plugin `compressCtxFor` → `messages.js buildCompressCtx`），v4 时把本回合任务 + 工具结果带给压缩器；
  评测工具本来就注入 TASKS，所以对评测数字没影响，对真机上线是必需的（否则观察里的行被当编造剥掉、分支没落点）。
- 同会话修的生产 bug：birth.js 的发明标识符闸只对着原文查，R5 可用句里的 `edit_file` / `old_text` 会让整份稿被 `invented-identifier` 放行
  （v12.5 起就有，评测绕过 birth.js 所以没暴露；hook-wiring §6 端到端测试抓到）。现在模板接口词豁免、出处含 compressCtx。
  ⇒ 真机上线前务必看 trace 的 `birth-passthrough.why` 分布，别只看评测分。同类第二个：反引号配对（长片段让正则把散文当代码）——已改 split 配对。
  现在 `compile-direct` 每行打印 `accept=ok|why`（birth.js 同一份 `birthAccept`），编译时就能看到真机会不会放行；oG 五份现在全 ok。
- 直写上线的真实代价（同会话发现并接好线）：直写不走增量分段（此前分段器会接管、直写提示词在生产里跑不到），整块编译 3.6–10.9 s / 块
  （13 份样本：≤6 s 9 份、≤8 s 10 份），收网窗口现在随 compressV4Direct 自动抬到 6000（`compressV4DirectMinWaitMs`）。
  注意窗口不是每次都付：编译与主模型生成可见回答**并行**，只有可见回答结束时还没编好才等（hold）。评测分是离线编译的，转正前量真实 hold：
  `node tools/v4-live.mjs --replay /home/user/live-all/recordings.json --modes v4 --cfg '{"compressV4Direct":true,"distillStream":true}' --base-url $DEEPSEEK_BASE_URL --model $DEEPSEEK_MODEL --out /home/user/live-direct`
  （v4-live 现在会把任务原文当 compressCtx，与生产 buildCompressCtx 同口径；看每行 `hold=` 与 why 分布）。
- R7 已同样用到 ops 路（生产 v4 缺省）：`transfer/direct-ops9u.json` = ops9p 零成本重编译（flaky 尾段多了「改法是增大时间差…；逐字原文是 `hedgeAfterMs: 1600`」）。
  第 C 轮（在 A/B 之后，仍是 raw + 1 变体）：`--report v4u:v4=/home/user/direct-ops9u.json --variants raw,v4u`，与 v4t（5.8 / flaky 2.5）比。
  注意混杂：direct-ops9p.json 里存的 v4t 文本是 v12.5 渲染器的产物，v4u = 同一批 side 输出 + v12.6 原生语域模板 + R7 绑定；
  要单独归因 R7，再零成本出一份 `--cfg '{"compressV4DirectBind":false}'` 的重编译作对照（只在 v4u 赢了、需要归因时做）。
- sse 的失败形态是「分支没覆盖观察的实际取值 + 改法跨两处」（EFFECT-EVAL §13），是 R7 之后的下一个规格缺口（判读覆盖），未做。
- 推送：本会话受平台约束只能推 `arena/01a0eba2-cfb` 分支（已推）；回 main 需要有权限的一方 fast-forward 合并（`git push … arena/01a0eba2-cfb:main`），不要 force。

## transfer/ 文件地图（都是 GitHub 主分支上没有的）
- `MEMORY.md` 上一会话记忆；（密钥不在库里，用户口头提供）`recordings.json` 6 条真机录音（5 评测题 + session-mixup）
- `direct-*.json` 各轮编译产物（ops5…9p、od/oe/of；带 `side` 字段的可 `--recompile`）；`direct-og-src.json`（oF/oE 五条 side 合集）→ `direct-og.json`（R7 门重编译，待评 oG）；`direct-ops9u.json`（ops9p + R7 ops 路，待评 v4u）
- `oracle/A.json B.json C.json` 手写稿行文件（源码在 `docs/analysis/oracle/*.py`）
- `effect-6 … effect-16` 评测结果目录（effect-16 是累计全集，含 raw/v4q…v4t/oA…oF 全部行，可复用）
- 临时物：以后删掉 `transfer/` 回 main 时记得 `node manifest.mjs` 重生成清单。
