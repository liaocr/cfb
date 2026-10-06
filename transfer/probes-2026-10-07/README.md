# 通用压缩器探针资产（2026-10-07 入库）

来源：沙箱 `/home/user/probes/`（原样拷贝，未改一行）。用途：为「通用压缩器 + 稳定金标」轮提供**可复跑**的读数。
**这批文件不被 `verify.mjs` 调用、不改生产路径、不耗 API**；只有 `fetch_corpus.py` 需要外网。

## 0. 结论速览（每条都有 §2 的表支撑）

- 生产编译路径对**任意文本不优雅降级**：92 篇平均只选出 0.3 单元、锚点覆盖 0.5%（math-cot 域 0 个）。
- 通用选择器（`src/universal-select.js`，提交 `8c918cc`）同预算锚点覆盖 **50.3% vs 生产 27.4%**；长文域 6.5%→48.8%。
- 但「必需事实保留」（oracle 金标）暴露缺口：multihop 生产 **0.0%** vs 通用 57.9%；**math 上通用 57.3% 输给 random 65.4%**（答案集中在末句 ⇒ 需加结论位项）。
- 幻觉已核实 **0%**（旧「70% 幻觉」是正则伪影，见 §4）。

## 1. 依赖顺序与命令（Node ≥20 / Python3，零第三方依赖）

```bash
python3 fetch_corpus.py          # ① 拉语料（HF datasets-server，需外网+UA 头；免鉴权）
python3 gold_source_check.py     # ② 派生标注金标 → corpus/*_labelled.json（GSM8K 链式中间量 / HotpotQA supporting_facts）
node    dump_units.mjs           # ③ 92 篇 / 2593 单元 → units.jsonl（注意 §4 的「数组非 JSONL」陷阱）
node    ground_check.mjs         # ④ 覆盖/幻觉读数（仓库 extractAnchorsV5 口径）
node    universal_bench.mjs      # ⑤ 92 篇对打：生产 vs 通用选择器 vs random/lead-k（同 30% 预算）
node    oracle_bench.mjs && python3 oracle_eval.py   # ⑥ 90 篇必需事实保留（生产/通用/random/lead-k）
python3 bench.py                 # ⑦ 旧表：任意文本选择器对打
python3 transfer_test.py         # ⑧ 跨域迁移探针（学到的打分器 vs 计数特征）
python3 e2e_eval.py              # ⑨ 旧 e2e 分域表（有 ID 映射问题，§4）
node    compression_quality.mjs && node compression_quality2.mjs   # ⑩ 旧 recall 读数
node    regress.mjs              # ⑪ 0c556b6 修复后的三折回归（24/33 · 20/39 · 27/97）
```

## 2. 关键读数（全部实测，2026-10-07 沙箱）

### 2.1 `ground_check.mjs` —— 覆盖 / 幻觉（仓库 `extractAnchorsV5` 口径）

| 域 | 源锚点均值 | 输出锚点均值 | 锚点覆盖 | 幻觉率 |
|---|---:|---:|---:|---:|
| math-cot | 36.1 | 15.7 | 45.0% | 0.0% |
| multihop | 402.1 | 24.1 | 6.5% | 0.0% |
| repo-handoff | 392.0 | 23.0 | 5.9% | 0.0% |
| repo-runbook | 421.0 | 20.0 | 4.8% | 0.0% |

⇒ 真问题 = **长文覆盖崩塌**（输出锚点数恒定在 ~16–24，源越长丢得越多），不是幻觉。

### 2.2 `universal_bench.mjs` —— 92 篇对打（同 30% 预算）

| 选择器 | 锚点覆盖 | 内容词覆盖 | 冗余 | 压缩比 |
|---|---:|---:|---:|---:|
| 生产路径（deployment） | 27.4% | 24.3% | 0.0% | 0.278 |
| **通用选择器 v1** | **50.3%** | **52.9%** | 0.1% | 0.284 |
| 通用选择器 @半预算 | 29.6% | 31.7% | 0.1% | 0.144 |
| random | 42.3% | 42.9% | 1.1–1.4% | 0.29 |
| lead-k | 43.0% | 47.1% | 0.9% | 0.29 |

分域锚点覆盖（生产 → 通用）：math 45.0→51.6 · multihop 6.5→**48.8** · handoff 5.9→44.9 · runbook 4.8→49.2。

### 2.3 oracle 必需事实保留（90 篇；GSM8K 链式中间量 / HotpotQA 官方支撑句）

| 域 | 生产 | 通用 | random | lead-k |
|---|---:|---:|---:|---:|
| math-cot（链式中间量全在，n=49） | **92.5%** | 57.3% | 65.4% | 28.7% |
| multihop（支撑句 ≥60% 复现，n=40） | **0.0%** | **57.9%** | 41.5% | 36.2% |
| 全体（n=89） | 50.9% | 57.6% | 54.7% | 32.1% |

⇒ 通用选择器赢长文、**math 输 random**（纯覆盖目标不够，须加结论位项）。

### 2.4 语料与单元统计

- `corpus/math_cot.jsonl` 50 篇，3.2 个链式中间量/篇（1 篇空链剔除）；`math_cot_labelled.json` 为带标注副本。
- `corpus/multihop_qa.jsonl` 40 篇，2.4 条官方支撑句/篇；`multihop_qa_labelled.json` 为带标注副本。
- `units.jsonl`：92 篇 / 2593 单元（每篇 min/中位/max = 5/12/145）。

### 2.5 旧读数（作为对照保留）

- `compression_quality{,2}.mjs`：`selectOpsV5` recall **8.8–9.8%** vs v 排序 27.5–30.4% vs random 33.4–35.4%；生产槽位上限使 ≥71% 负载单元结构不可选。
- `bench.py`：部署路径 0.5% 锚点覆盖（0.3 单元；math 0 个）；random 48.0 / lead 34.2 / TextRank 52.8 / greedy 上界 69.3 / v 排序 56.8。
- `transfer_test.py`：学到的打分器**不跨域**（未见域全输 random：21.8 vs 33.4；46.4 vs 72.0；12.6 vs 26.2）；可迁移的是**计数特征**（锚点新颖度/字符：77.8/76.3/32.2）。
- `e2e_eval.py` / `e2e_out.jsonl`：92 篇 e2e 分域表；ID 映射不一致 ⇒ repo-runbook 未评分（91/92）。
- `regress.mjs`：0c556b6 修复后 24/33 · 20/39 · 27/97。

## 3. 文件说明

| 文件 | 作用 |
|---|---|
| `fetch_corpus.py` | 从 HF datasets-server rows API 拉 GSM8K 思维链 50 篇 + HotpotQA 40 篇 |
| `gold_source_check.py` | 从原文派生**稳定金标**（`<<a op b = c>>` 链式中间量；`supporting_facts`=`title`+`sent_id`），出 `*_labelled.json` 与统计 |
| `dump_units.mjs` | 92 篇切话语单元 → `units.jsonl`（含每篇单元数与字符统计） |
| `ground_check.mjs` | 用仓库 `extractAnchorsV5` 口径量「压缩输出 vs 源」的锚点覆盖与幻觉 |
| `universal_bench.mjs` | 同预算对打表（生产 / 通用 / random / lead-k），含半预算档 |
| `oracle_bench.mjs` + `oracle_eval.py` | 生成 `oracle_out.json`（90 篇四路输出+标注）并统计必需事实保留 |
| `bench.py` | 任意文本选择器对打（random/lead/TextRank/贪心上界/v 排序/部署路径） |
| `transfer_test.py` | 跨域迁移探针（拟合打分器 vs 计数特征） |
| `e2e_dump.mjs` + `e2e_eval.py` + `e2e_out.jsonl` | 端到端 92 篇输出与分域评测（ID 映射有瑕疵） |
| `compression_quality{,2}.mjs` | 旧 recall 读数（`selectOpsV5` vs 随机/lead-k） |
| `regress.mjs` | `0c556b6` 两处修复后的三折回归 |
| `corpus/` | 语料与带标注金标副本（4 文件） |
| `withdrawn/` | 弃用探针（见 §5），仅存档追溯 |

## 4. 陷阱（数字必读）

1. **幻觉 0% 是修正后的真值**：`ground_check.mjs` 初版含一行 Python 伪代码 ⇒ 无法解析；旧「70% 幻觉」是正则伪影（已删该行后跑通）。
2. **`corpus/*.jsonl` 是单个 JSON 数组**（不是逐行 JSONL）⇒ 按行解析会静默只出 2 篇。
3. HotpotQA 支撑句字段是 **`sent_id`**（不是 `sent_idx`）。
4. `e2e_eval.py` 的 ID 映射不一致 ⇒ repo-runbook 未被评分（91/92）。
5. `bench.py` 单文档域 IDF 长度 1 ⇒ 该域「内容词覆盖」恒 0.0%（此列不可读）。
6. 生产路径的 0.3 单元 / 0.5% 覆盖是**真实部署行为**（12+24 采样、尾部-only `targetAnchors`、槽位上限），不是探针 bug。
7. 本地 `transfer/models/v5-micro-weights.candidate.json` 与 `fold-*.json` 是**旧件**（06c 期），勿当 06g 产物；`/tmp` 探针已作废。

## 5. `withdrawn/`

`gold_quality_gates.py` —— 简化三闸版「金标质量」探针：**运行被用户中止、判为「糊弄」**。仅存档追溯，**勿运行、勿引用**。金标质量必须按 `cfb.gold-standard/1` 的 12 轴与记录在案的量化难题来读（见 `docs/GOLD-STANDARD.md` 与 `docs/STATUS-2026-10-07.md`）。
