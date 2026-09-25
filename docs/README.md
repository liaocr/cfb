# 文档索引

## 现行

| 文件 | 读者 | 内容 |
|---|---|---|
| [`../README.md`](../README.md) | 使用者 | 做什么、快速开始、模式与配置、回滚开关、观测、当前状态 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 改代码的人 | 模块地图、钩子与数据流、持久化位置、不变式、「改哪里」 |
| [`INSTALL.md`](INSTALL.md) | 部署的人 | 注册机制、两层 patch 形态铁律、改完源码如何生效、排错 |
| [`AUDIT-V11.5.md`](AUDIT-V11.5.md) | 做取舍的人 | 成本模型与收益判据（`birthMinChars` 3100 的来历）、缺陷 A–G、仍未落实的建议。行号指 `1134ed7` 的旧 `index.js` |
| [`ECONOMICS-V11.11.md`](ECONOMICS-V11.11.md) | 做取舍的人 | 按 Harness 官方默认参数重算的成本模型、单块收益天花板 `0.5·r`、五条压缩路线的裁决（含被推翻的跨轮批量）。**结论上取代 AUDIT-V11.5 的成本模型部分**，行号指 `669296b` |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 所有人 | 版本沿革（最新在上） |

## 历史（留在顶层的原因）

| 文件 | 说明 |
|---|---|
| [`CORRECTNESS-V11.md`](CORRECTNESS-V11.md) | v11 正确性修正报告。属于版本详报，但 `archive/COMPRESS-MEMORY-SPLIT.md` 以相对路径链接它，而 archive 只追加不回写，故保留在此 |

## 归档

[`archive/`](archive/README.md)：各版本详报（第一批 … v10）、设计稿、对外简报、作废状态卡，以及 `optimization-evidence*/` 原始证据目录。
规则：**只追加、不回写、不删除**。其中描述的开关、行号、套件计数都是当时的事实，不代表现状。
