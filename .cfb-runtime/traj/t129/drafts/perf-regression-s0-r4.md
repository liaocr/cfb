本轮增量：
- 读数（延续段已引用）：contentSpanMs p50 为 1650（v11.10）。推理链读到 contentSpanMs 从 280 涨到 1650，outputChars 从 390 涨到 1720（推理链的阅读，未在工具回显中逐字核对）。
- 推理链读到的改动：compressTargetMax 从 450 涨到 1800，maxOutputTokens 从 850 涨到 4096。两者同时变化，尚未单独验证。
- 未解：finishWaitMs p50 为 2400，而 config 中 birthFinishWaitMs 上限为 1500，两者尚未对照；ttfbMs 基本未变（610 到 640），说明首字延迟不是来源。
- 闭合判读（读数 ⇒ 结论）：若 contentSpanMs 随 compressTargetMax 上调而同步增长，则说明 birth 等待主要来自输出长度。若 contentSpanMs 不变而 finishWaitMs 仍高，则说明等待在收网阶段，不在生成长度。
- 验收：运行 `analyze-trace --compare v11.9 v11.10 --steps birth --last 50`，看到 contentSpanMs 与 finishWaitMs 的 p50 同时回落到接近 900ms 的水平，即算完。若 finishWaitMs 仍高于 1500 且 contentSpanMs 未降，则说明修法没有覆盖真正的来源，回到上一条判读。
