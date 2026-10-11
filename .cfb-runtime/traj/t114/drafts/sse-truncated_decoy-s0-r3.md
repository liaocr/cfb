本轮增量把机理坐实：`trace/last.log` 的 `eventCount` 9 与 `outputChars` 212 对应 `replay` 的 9 帧截断流——`assembleSseFrames` 里 `finish: finish || (done ? 'stop' : null)` 把只补 `[DONE]`、无 `finish_reason` 的截断流当成 `stop`，而 `settle` 里 `ok = r.finish != null || r.out.length > 0` 又把 `out.length > 0` 判为成功，导致截断流走 `condensed` 写进会话。



验收：跑 `verify.mjs` 看数值——若按上面这处改完它变绿 ⇒ 说明原因就在这处，可以收工；若它仍不绿 ⇒ 说明还有别处在起作用，先别声称修好。
