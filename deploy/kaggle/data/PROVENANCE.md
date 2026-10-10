# SFT 数据来源与许可

## 上游

- 语料：`nvidia/Open-SWE-Traces` v1.1，split `openhands`
- 教师模型：DeepSeek-V4-Flash（reasoningEffort `max`，生成压缩稿时关思考）
- 压缩提示词：`transfer/prompts/teacher2-zh.txt`（v4）—— 与本目录数据**逐字对应**，改提示词必须重产数据

## 许可

筛选后的 4687 个候选单元全部来自宽松许可仓库：

| 许可 | 单元数 |
| --- | --- |
| MIT | 2490 |
| Apache-2.0 | 1272 |
| BSD-3-Clause | 791 |
| BSD-2-Clause | 134 |

## 本目录文件

- `sft-train.jsonl` / `sft-dev.jsonl` —— `tools/build-sft.mjs` 的产出，按**仓库**切分（FNV-1a），无泄漏

### ⚠ 当前这一版是**部分数据**，不是全量

| | 值 |
| --- | --- |
| 教师稿已产 | **722 / 4687**（15.4%，0 失败） |
| 可用（过 raw/draft 长度闸） | 722 |
| 训练集 | **313**（按尺子过滤后留存 43.3%） |
| 验证集 | **89**（**不按尺子过滤**，见下） |
| 教师基线 | 验证集 **40/89 = 44.9%** 通过 |

**验证集故意不过滤。** 若先过滤再切分，dev 里只剩"教师本来就过尺子"的那部分，
学生哪怕只会照抄，通过率也天然接近 100%，跟教师 44.9% 的基线没法比 ——
那是一个只会报喜的指标。所以切分在过滤之前，`report.json` 里另记
`devTeacherPass` 当基线。**学生分数要跟 44.9% 比，不是跟 100% 比。**

这一版用于**端到端打通 + 拿第一个真实配对数字**，不是最终训练集。
教师生成可续跑（`batch.py` 按 id 去重），补齐后再重新产一遍数据。

训练集被拒的主因：G7 compressed ×254、G1 quote-grounded ×60、
G3 anchors-kept ×45、G4 actionable ×28、G6 not-copy ×7、G2 locus-grounded ×6。

## 每行结构

```json
{"id": "...", "repo": "...", "system": "压缩提示词", "user": "[题面] ctx\n\n[思考过程] raw", "assistant": "压缩稿", "meta": {...}}
```

`system`/`user`/`assistant` 三段是**结构化**的，不写死分隔符 —— 由训练脚本调用底座原生
`apply_chat_template` 渲染。RWKV7 的模板是 `<|rwkv_tokenizer_end_of_text|>System: …\n\nUser: …\n\nAssistant: …\n\n`。
