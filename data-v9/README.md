# data-v9 —— PREREG-v9 产物（判定：INVALID，不可训练）

| 文件 | 内容 |
|---|---|
| `hand-standard.jsonl` | hand 标准集 30 份（t133–t135 的原文、ctx、手写稿），含稿件哈希 |
| `thresholds.json` | hand 校准结果、软分下限、冻结哈希 |
| `validation.json` | 有效性判定（确定性、负对照、空稿/照抄、教师通过率）与 VALID/INVALID |
| `labelled-pool.jsonl` | 样本池标签 1233 行（只含标签，正文从源文件按行号取回并校验哈希）。每行 `trainable: false` |
| `labelled-pool.summary.json` | 样本池汇总与贡献文件列表 |

`train.jsonl` / `dev.jsonl` / `test.jsonl` **未生成**：尺子 INVALID 时 `build` 拒绝运行（按预注册）。

复现：`node tools/v9-pipeline.mjs hand && node tools/v9-pipeline.mjs calibrate && node tools/v9-pipeline.mjs validate && node tools/v9-label.mjs`
规范：`transfer/route-2026-10-11/PREREG-v9.md`，哈希 `transfer/route-2026-10-11/PREREG-v9.sha256`。
