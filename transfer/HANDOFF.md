# 接手手册（新会话零记忆开工，2026-09-29 交接）

你是接手者。项目 = 本仓库 `dsh-cot-form-b`（cfb）：给 DeepSeek 宿主（DSH）做思维链压缩，目标是**主模型更好**（判断力/专注力），不是省钱、不是"不掉分"。用**中文**回复。

## 必读顺序（都在本仓库）
1. 本文件
2. `transfer/MEMORY.md`（上一会话的实时记忆，含全部迭代日志）
3. `docs/analysis/EFFECT-EVAL-2026-09-28.md` §11–§12（oracle 实验 + 自动稿三轮）
4. `CHANGELOG.md` v12.6.0；`docs/theory/CFB-THEORY-COMPLETE.md` 第二部分 S8（R1…R6）

## 环境恢复（把测试数据放回工具期望的路径）
```bash
mkdir -p /home/user/live-all /home/user/.secrets /home/user/oracle
cp transfer/recordings.json /home/user/live-all/recordings.json
# keys.env 不能进 GitHub（机密扫描拦截）⇒ 让用户在对话里粘贴 4 个值，写入 /home/user/.secrets/keys.env：
#   DEEPSEEK_API_KEY=...  DEEPSEEK_BASE_URL=https://api.a6api.com/v1  DEEPSEEK_MODEL=deepseek-v4.1-flash  GITHUB_PAT=...
cp transfer/direct-*.json /home/user/
cp transfer/oracle/* /home/user/oracle/
cp -r transfer/effect-* /home/user/
cd /home/user/cfb && node verify.mjs   # 应 590 通过 / 0 失败 / 1 跳过
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

## 现状（截至交接）
同后端 n=10/组（原文 n=20）：raw 5.0｜v4t(ops 散文) 5.8｜oracle 上界 oC 6.4/直接改 70%｜
oD 4.8 → oE 5.5（**wrong-model 10.0** 首超原文 9.0）→ oF 6.0(3 任务，**perf 10.0**)。
- 已落地：`compress-v4-direct`（opt-in，cfg `compressV4Direct`）：副模型直写 DeepSeek 原生语域散文；
  提示词 `buildCompressPromptV4Direct`（样例驱动 + R5 直改落点 + 下一步仲裁 + 证据充分性标准）；
  程序门 `compileV4Direct`（锚点逐字硬校验、编造剥反引号、直改可用句条件补句、超长熔断）。
- **当前卡点**：flaky-timeout 只有 2.0–2.5（oracle 8.5）——副模型不肯在两个改法候选间落定，把"复现"排下一步（第 8 稿已承认证据充分仍如此）＝判断力边界。
- **下一步**（理论 S8-R6 已写）：①改法候选机械落定规则（取原文最后倾向/最小改动）或代码从 fixHints 写死"下一步=改法"句；②flaky 破了之后全 5 任务复测；③赢了才把 `compressV4Direct` 转正（现缺省关，完整 5 任务 5.5 vs 5.8 未全面胜出）。

## transfer/ 文件地图（都是 GitHub 主分支上没有的）
- `MEMORY.md` 上一会话记忆；（密钥不在库里，用户口头提供）`recordings.json` 6 条真机录音（5 评测题 + session-mixup）
- `direct-*.json` 各轮编译产物（ops5…9p、od/oe/of；带 `side` 字段的可 `--recompile`）
- `oracle/A.json B.json C.json` 手写稿行文件（源码在 `docs/analysis/oracle/*.py`）
- `effect-6 … effect-16` 评测结果目录（effect-16 是累计全集，含 raw/v4q…v4t/oA…oF 全部行，可复用）
- 临时物：以后删掉 `transfer/` 回 main 时记得 `node manifest.mjs` 重生成清单。
