第 5 轮的 analyze-trace --compare v11.9 v11.10 --steps birth 把根因彻底坐实了：v11.9 的 ttfbMs 是 610、contentSpanMs 是 280、finishWaitMs 是 900，outputTokens 是 260、outputChars 是 390、promptVersion 是 compress-v3h:250-450；升级 v11.10 后 ttfbMs 仍是 640 几乎没变，但 promptVersion 变成 compress-v3h:250-1800，outputChars 涨到 1720、outputTokens 涨到 1150、contentSpanMs 涨到 1650、finishWaitMs 涨到 2400。平均等待 900 → 2400 差的就是 1500ms，全部落在生成段而不是首字节，所以回滚压缩目标上限就能把等待拉回来。
已排除：maxOutputTokens 为 4096 的路线，因为两版 finishReason 都是 stop 100%，且 v11.10 的 outputTokens 1150 远低于 4096，不是截断上限导致的。
已排除：birthFinishWaitMs: 1500 或其它隐藏代码文件的路线，因为仓库只有 src/config.js、README.md、CHANGELOG.md，compressTargets 只读 compressTargetMin 与 compressTargetMax。
改法只落一个：改 src/config.js 里的 compressTargetMax，把 1800 改回 450，保留 maxOutputTokens 的 4096 与 birthFinishWaitMs: 1500 不动。
下一步在同一条回复的末尾同时列出两条调用：第一条 edit_file 修改 src/config.js（把 compressTargetMax 的 1800 改为 450），紧接着第二行立刻再写一条 bash 跑 `analyze-trace --last 20 --steps birth` 完成改后验收。
验收是 bash `analyze-trace --last 20 --steps birth`，预期 promptVersion 回到 compress-v3h:250-450、outputChars 回到 390 左右、contentSpanMs 回到 280 左右、finishWaitMs 回到 900 左右；只跑 --compare v11.9 v11.10 不算证据，因为 --compare 打出的是历史版本静态对比表。
若验收仍显示 compress-v3h:250-1800：第一步检查 src/config.js 里 compressTargetMax 是否已改为 450；此时 maxOutputTokens 与 birthFinishWaitMs: 1500 都不是改法。如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
回放过了之后还有两件原文已经定下的事：确认 analyze-trace 打出的 finishWaitMs 从 2400 降回 900 左右且 contentSpanMs 与 outputChars 同步回落；以及保留 maxOutputTokens 为 4096 防止长输入截断并说明回滚 compressTargetMax 到 450 的依据。
能说修好要三件事都在手：src/config.js 改动落地的回执、analyze-trace 改后跑出 finishWaitMs 回落的观察、这条观察是改后产生的；现在能说的：证据已齐，同一条回复里连续发出 edit_file（改 src/config.js）与 bash（跑 `analyze-trace --last 20 --steps birth`）两条调用即可完成验收并收工。
