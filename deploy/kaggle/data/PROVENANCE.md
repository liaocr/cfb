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
- 当前只有 **57 条**（来自 100 个单元的冒烟批次），用途是**验证 Kaggle 环境**，不是最终训练集

## 每行结构

```json
{"id": "...", "repo": "...", "system": "压缩提示词", "user": "[题面] ctx\n\n[思考过程] raw", "assistant": "压缩稿", "meta": {...}}
```

`system`/`user`/`assistant` 三段是**结构化**的，不写死分隔符 —— 由训练脚本调用底座原生
`apply_chat_template` 渲染。RWKV7 的模板是 `<|rwkv_tokenizer_end_of_text|>System: …\n\nUser: …\n\nAssistant: …\n\n`。
