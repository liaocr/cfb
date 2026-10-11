我在手的代码行：
- `test/birth.selftest.mjs`：`opts.home = process.env.CFB_REAL_DSH_HOME`
- `src/trace.js`：`opts.home || process.env.DSH_HOME`
核心定位：`verify.mjs` 为每个测试套件设置独立临时目录 `DSH_HOME=tmp`，但 `test/birth.selftest.mjs` 使用了 `process.env.CFB_REAL_DSH_HOME` 而不是 `DSH_HOME`，绕过了临时目录隔离并直接去写 `root:root` 拥有的 `/home/u/.dsh/storages/cot-form-b/trace.log`，导致普通用户 `u`（`uid 1000`）触发 `EACCES: permission denied`。
改法只落一个：直接用 `edit_file` 修改 `test/birth.selftest.mjs`，把 `process.env.CFB_REAL_DSH_HOME` 改为使用隔离的 `process.env.DSH_HOME`（即 `home: process.env.DSH_HOME`）。
已排除：修改 `src/trace.legacy.js`、`src/trace.compat.js` 或 `src/trace.js`，因为 `README.md` 与 `docs/incident-runbook.md` 指向的 `src/trace.legacy.js` 和 `src/trace.compat.js` 均不在调用链中，且 `src/trace.js` 本身已支持 `opts.home || process.env.DSH_HOME`。
已排除：尝试修改 `/home/u/.dsh` 目录权限，因为普通用户 `uid 1000` 没有 `sudo` 权限，且测试本应在 `verify.mjs` 提供的隔离 `DSH_HOME` 中运行。
未解：确认第 5 轮 `npm test` 与 `grep -rn "CFB_REAL_DSH_HOME"` 输出后，第 6 轮一步完成 `test/birth.selftest.mjs` 修改并同轮跑 `npm test` 验收。
下一步在第 6 轮直接用 `edit_file` 修改 `test/birth.selftest.mjs`（将 `process.env.CFB_REAL_DSH_HOME` 改为 `process.env.DSH_HOME`），并在同一轮运行 `npm test` 验收通过，第 7 轮不再调用任何工具，直接输出最终修复说明。
