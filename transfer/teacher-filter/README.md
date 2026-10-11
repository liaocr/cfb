# 教师 v4-full 只读过滤（2026-10-11，$0）

- 脚本：`filter.mjs`（只读；cwd = cfb/；`node transfer/teacher-filter/filter.mjs`）。
- 输入：`.cfb-offline/teacher/v4-full.jsonl`（2484 行；过滤前后 sha256 均为 `ec05a72b84d9c6b0…`，未修改）。
- 输出：`candidates.tsv`（每行一个教师条目：id、家族、raw/draft 字数、是否过 3100 地板、C1/C2/C3 闸门标志、是否全部通过、失败原因）。**不含稿文本**。
- 结果：2484 行；过地板 685；过 C1–C3 闸门 41。
- 闸门口径：`tools/helpers/three-mode.mjs` 的 `goldCeiling`（与金标入库同一套）。
- 重要限制：教师条目没有真机结局标签（`outcome`），通过闸门只说明"格式合格"，不等于"真机好"。它**不是训练数据**，D6 仍暂停；要进训练，必须先由尺子在 dev 上通过，并经过真机抽样。
