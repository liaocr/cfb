原文落定「The fix: revert compressTargetMax to 450」，且 compressTargetMax 与 birthFinishWaitMs 都写在 `config.js`。
这条线只有一处：先按原文把长度目标调回去，别去改别的文件。
验收：跑 `analyze-trace` 比对两版 birth 的 finishWaitMs——
若 p50 回到 900ms 量级 ⇒ 说明收网等待就是被长度目标顶上去的；若仍停在 2400 ⇒ 说明还有别处在拉长等待，先别声称修好。
