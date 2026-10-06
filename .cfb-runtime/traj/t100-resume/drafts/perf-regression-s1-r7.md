原文落定「So fix: revert compressTargetMax to 450 (or reduce it)」，且 birthFinishWaitMs: 1500 也在同一份 `config.js`。
这条线只有一处：改回长度目标即可，不必再翻仓库找别的文件。
验收：跑 `analyze-trace` 看 finishWaitMs——
若 p50 回落 ⇒ 说明长度目标是收网等待的直接原因；若不回落 ⇒ 说明还叠加了别处的改动。
