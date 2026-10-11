本轮增量把机理坐实：`verify.mjs` 已为每个套件创建独立 `temp` 目录并注入 `DSH_HOME`，但 `test/birth.selftest.mjs` 调 `makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 覆盖了隔离的 `DSH_HOME`，直接逃逸去写宿主 `/home/u/.dsh/storages/cot-form-b/trace.log`；而该目录与 `trace.log` 属主为 `root`（权限 `755` / `644`），普通用户 `u`（uid `1000`、无 `sudo`）追加写入必报 `EACCES: permission denied`。
已排除：尝试删除或修改 `/home/u/.dsh/storages/cot-form-b/trace.log` 权限的路线，因为目录与文件均属 `root` 且无 `sudo`；已排除：修改 `src/trace.js` 或诱饵文件 `src/trace.legacy.js` 的路线，因为 `src/trace.js` 缺省读取 `DSH_HOME` 的逻辑正常，越界根因在于 `test/birth.selftest.mjs` 显式传入了 `process.env.CFB_REAL_DSH_HOME`。
改法只落一个：edit_file `test/birth.selftest.mjs`，old_text 是 `makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`，new_text 是 `makeTraceWriter()`，让测试直接沿用 `verify.mjs` 提供的隔离 `DSH_HOME`（`src/trace.js` 与 `src/trace.legacy.js` 不动）。
验收是 bash `npm test`（或 `node verify.mjs`），预期 `test/birth.selftest.mjs` 打出 PASS（0 失败）；改动前不算证据。
若仍报 `EACCES`：第一步只有一条，先检查 `test/birth.selftest.mjs` 改动落地并与上轮 `EACCES` 输出比差抓新信号，此时不要去改 `src/trace.js` 或 `src/trace.legacy.js`、不要回滚。
如果输出跟这两种都不像，先别改，把不一样的地方看清再说。
回放过了之后还有两件原文已经定下的事：确认 `npm test` 跑 `verify.mjs` 全部通过且不再访问 `/home/u/.dsh/storages/cot-form-b/trace.log`；以及保持 `src/trace.js` 与 `src/trace.legacy.js` 不动并汇总依据收工。
