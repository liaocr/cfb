第 1–3 轮看清了 `ci/last5.log`、`src/distill.js`、`test/helpers.mjs` 与 `test/hedge.selftest.mjs`：CI 2 核偶发 `expected hedgeStartedAt=null, got 1712`（及 `1698`），根因是 `test/hedge.selftest.mjs` 里 `primaryDelayMs: 1500` 与 `hedgeAfterMs: 1600` 只有 `100ms` 裕量，两个独立 `setTimeout` 在 2 核事件循环调度抖动下竞态越界；而本轮（第 4 轮）跑的不带 `taskset` 的单次命令不会复现，本地 16 核本来就过。
已排除：修改 `src/distill.legacy.js`、`src/distill.compat.js` 或 `src/distill.js`，因为 `README.md`、`docs/incident-runbook.md` 与 `logs/stale-diagnostic.log` 指向的 `legacy` 和 `compat` 是诱饵文件，且 `src/distill.js` 逻辑自洽无需改动。
已排除：新建临时复现脚本或跑 shell 循环复现的路线，因为 `ci/last5.log` 已有现成的 2 核失败记录（run 2 与 run 5），本轮 `bash` 的回显也逐字写着「该沙箱不支持 shell 循环」，复现只靠绑核跑同一条自测。
改法只落一个：直接修改 `test/hedge.selftest.mjs`，将 `old_text` 为 `const server = fakeServer({ primaryDelayMs: 1500, status: 200 })
  const meta = await hedgedDistill(server.url, { hedgeAfterMs: 1600 })` 改为 `new_text` 为 `const server = fakeServer({ primaryDelayMs: 100, status: 200 })
  const meta = await hedgedDistill(server.url, { hedgeAfterMs: 2000 })`。
注意只改代码行，注释行留着不动；`hedgedDistill` 在主请求结算后立刻 `clearTimeout(timer)` 返回，把 `primaryDelayMs` 设为 `100`、`hedgeAfterMs` 设为 `2000` 既留出 `1900ms` 裕量又更快完成。
下一步在同一轮按顺序直接发出两条调用：第一条 `edit_file` 修改 `test/hedge.selftest.mjs`，第二条紧跟 `bash` 跑 `taskset -c 0 node test/hedge.selftest.mjs` 完成改后验收；若 `edit_file` 报 `old_text` 找不到，说明已改过，直接跑验收即可。
验收是 `bash` 跑 `taskset -c 0 node test/hedge.selftest.mjs`，预期打出 `hedge.selftest ok` 通过。
未解：确认 `edit_file` 修改 `test/hedge.selftest.mjs` 与 `taskset -c 0 node test/hedge.selftest.mjs` 改后打出 `hedge.selftest ok`；拿到这条观察后直接汇总根因与改法收工。
