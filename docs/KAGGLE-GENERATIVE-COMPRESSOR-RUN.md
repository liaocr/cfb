# 旧生成式压缩器 Kaggle 记录（已退役，不是运行手册）

> **安全状态（2026-10-14）**：当前工作树里的旧 Qwen/QLoRA 入口 `deploy/kaggle/start.py` 与 `deploy/kaggle/train_gen.py` 均已替换为 inert tombstone。当前两个文件不再安装依赖、读凭据、联网、克隆仓库、推送 Kernel 或启动 GPU 训练，没有 `--execute` 兼容开关。
>
> 旧 `tools/micro-generator/kaggle-generative-compressor.ipynb` 的安装/训练 code cells 已移除；本文中的可复制远端执行单元也已删除，避免再次触发历史脚本。**不可变历史 Git commit 中的旧脚本仍可能被直接下载并执行**；本地整改无法撤回那些远端历史 blob，请勿从旧 commit/raw URL 获取或运行。本文仅保留背景索引，不提供启动步骤。当前 RWKV7 入口的 `--prepare-only` 只做离线准备；任何真实训练、Kaggle 操作或远端 push 都需要另外授权并经过项目准入门。

## 历史背景（不是当前准入或质量结论）

旧路线描述过 Qwen3-0.6B/QLoRA、教师语料 v3/v5、Kaggle GPU 运行及输出打包。旧文档中的样本数、速度、指标与运行参数均为历史记录，**本次整改没有重跑或重新认可这些结果**。可追溯讨论见 `docs/MICRO-GENERATOR-TRAINING-SYNTHESIS.md` 与 `transfer/notes/GENERATIVE-ROUTE-HANDOFF.md`。

项目当前准入和质量状态仍以 `PROJECT.json`、`tools/micro-generator/dataset-policy.json` 及权威项目计划为准；本次整改没有改变模型准入、候选晋级、教师质量或原读回结论。

## 退役路径行为

- `python3 deploy/kaggle/start.py`：只打印退役提示；`--execute` 明确失败。
- `python3 deploy/kaggle/train_gen.py`：只打印退役提示并以非零状态退出。
- 两个入口不读取 Kaggle/API 凭据，不安装包，不访问网络，不写训练包，不启动模型。

需要查看当前本地离线准备说明时，从 `deploy/kaggle/start-rwkv7.py --prepare-only` 的代码与当前项目准入文档开始；不要把“文件可运行”误读为“训练获准”。
