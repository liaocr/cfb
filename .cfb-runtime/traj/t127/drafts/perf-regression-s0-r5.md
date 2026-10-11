已观察事实：
- 任务原文：v11.9 升级到 v11.10 之后，birth 收网的平均等待从 900ms 涨到 2400ms。
- analyze-trace 的比较（推理链所读的数字；ctx 中工具回显只摘录到表头，含 finishReason 与 outputTokens 等字段名，数值待核）：v11.9 的 outputTokens 约 260、contentSpanMs 约 280、ttfbMs 约 610、outputChars 约 390；v11.10 的 outputTokens 约 1150、contentSpanMs 约 1650、ttfbMs 约 640、outputChars 约 1720。
- promptVersion：v11.9 为 compress-v3h:250-450；v11.10 为 compress-v3h:250-1800（推理链所读）。
- src/config.js 的变更（ctx 中以「$ cat src/config.js」摘录）：推理链读到 compressTargetMax 从 450 改为 1800，maxOutputTokens 从 850 改为 4096。
未解：
- 输出变长的直接原因是否是 compressTargetMax（推理链的假设），还是 maxOutputTokens 也有贡献，尚未分开验证。
- 任务原文中的 900ms 与 2400ms 对应的是哪个字段（推理链算出 ttfbMs 加 contentSpanMs 约为 890 与 2290，接近但未核实）。
- 是否另有 finishWaitMs 的额外等待，未核。
下一步方向：用 analyze-trace --compare 逐字段比较 birth 步骤，核对 finishWaitMs 字段是否存在；分别检查 compressTargetMax 与 maxOutputTokens 各自的影响。
