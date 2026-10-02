# DSH 参考材料（只读，原样保存）

来源：用户 2026-10-02 从旧项目「DeepSeek Harness 智能体行为品质工程」（简称 DSH，基于 `@deepseek-ai/dsh` rc.6，Windows，deepseek-v4-flash @ openmodel.ai anthropic-messages 线）交来的文件。**一字未改**；合并分析见 `docs/design/DSH-MERGE.md`。

| 文件 | 是什么 | 在合并里的用处 |
|---|---|---|
| `router-rl-minimal.router-bootstrap-v1.mjs` | 现行预设（v4.6.1）：RL_PERSONA、RL_GUIDE 12 法则、DETAIL_GUIDE（solve/visual/exec/info）、PLAN_FIRST_INSTRUCTION、`agent/pre-step` 近场注入、**GATE_SMOKE / GATE_BATCH 动态门禁**、首调后工具晋升；注释里是 v2.x–v4.5 的全部实测史 | 门禁的触发条件 / 注入角色 / 幂等逻辑 → `tools/helpers/host-gates.mjs`；注入通道（user 角色、紧贴最新消息）→ gate 臂的注入位置 |
| `router-rl.router-bootstrap-v1.zero-guide.mjs` | 同结构、**零引导**版本（只有 RL 训练句 + shell/str_replace_editor 首轮工具面 + 晋升） | 「B 版」= 工具面臂 `--aci rl-native` 的依据 |
| `router-standard.router-bootstrap.mjs` | 上游 router-standard 预设（GUIDE_WEAK / GUIDE_DEEP 英文引导，spec/weak/react 分带） | 历史参照；GUIDE_WEAK ④「Fix by root cause」一段与 bugfix 场景同域 |
| `router-core.mjs` | 任务分类（classifyTaskTypes）、persona 分带、模式解析 | 只读 |
| `SESSION-NOTES.md` | 完整演进史 + 附录 A–D（会话复盘、GATE 触发记录、write 乱码事故） | 证据分级的原始出处 |
| `DESIGN-VS-IMPLEMENTED.md` | 设计过但未落地清单（A/B/C/D 类） | **自证**：B1 裸跑对照组从未跑、A8 多测取分布未做、C1 Boats! 回归未跑 ⇒ DSH 没有对照证据 |
| `HANDOVER-2026-08-20.md` | 交接文档与铁律（一版一变量、知识下沉到工具不进 Prompt、验证锚定外部事实） | 纪律 |
| `PRO-CHAIN-DISTILLED.md` | 9 组 V4 Pro 思维链的提纯（视觉域） | 方法参照（对比蒸馏），内容不用 |
| `task-pool.md` | 17 个 greenfield 基准任务 | 没有裁判，不进 cfb 题池 |
| `scripts/*.mjs` | 会话解压 / 提取 / 引导校验 / 格式扫描（stopReason、reasoning 漏到 text）/ 工具时间线 / 思维链搜索 | `scan-format` 的 stopReason 检查 → traj-run transcript 现在记 `finish` |

未保存：元会话的提取物（`user.txt` / `assistant.txt` / `toolCalls.txt` 等 1.2 MB，是构建 DSH 的助手会话，不是 flash 任务轨迹），留在工作区 `uploads/`。

## 证据分级（按 SESSION-NOTES 自己的记录）

- 🟢 工具面身份：25 工具全目录 91 分 → bash + str_replace_editor 双工具 98/99（纪元 I）；零引导 B 版 7457f 一遍过。
- 🟢 工具可靠性：截图工具修好前每轮 7–22 步被吞；82f74861 死锁源于旧帧暗图。
- 🟢 用户态指令 ≫ 注入引导：39139ce2 一句「先不要动手」→ 35.6K 推理 / 4852 字计划。
- 🟢 门禁触发且模型服从：dea48c68 GATE1×2 / GATE2×3 全部响应（败在 write 乱码，不败在门禁）。
- 🔴 12 法则相对零引导的增益：无同题同时对照（DESIGN-VS-IMPLEMENTED B1/A8/C1 自认）；全景表里 7457f（0 引导，43 步）与 abd9af3e（完全体，44 步、推理 +46%）步数持平。
- 🟡 规则量倒 U：6000 字清单 → 加灯风暴；200 字极简 → 61 步。方向可信，量未控。
- 🔴 神鬼二元 / 相变三带：上游作者已勘误（repo README 指向 statement.md / apology.md）；本地元会话也记「双吸引子理论作废」。
