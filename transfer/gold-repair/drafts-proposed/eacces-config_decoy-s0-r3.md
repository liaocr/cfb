根因：`verify.mjs` 把测试隔离到临时 `DSH_HOME`，但 `birth.selftest.mjs` 用 `makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })` 显式绕开这份隔离，于是 `trace.log` 落到 root 持有的 `/home/u/.dsh/storages/cot-form-b/trace.log`（`-rw-r--r-- 1 root root`）⇒ 普通用户 append 就是 `EACCES: permission denied`。

已排除：改文件或目录权限——`ls` 显示目录也是 `root root` 且环境无提权，u 在该目录里连创建文件都做不到；已排除：`trace.legacy.js`——它与这条写入路径无关，读过即可放下。

改法只落一个：`birth.selftest.mjs` 里 `old_text` 取 `makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })`，把 home 改指 `verify.mjs` 已经设好的那个 `DSH_HOME`；只改这一处入参，`verify.mjs` 与 `src/trace.js` 都不动（隔离是 `verify.mjs` 已经建好的，改它反而把别的测试拖进来）。

验收（闭合判读）：改完跑 `node test/birth.selftest.mjs`。若仍报 `EACCES: permission denied` ⇒ 说明还有别处把 home 指回真实目录，要顺着 `CFB_REAL_DSH_HOME` 继续查而不是改权限；若通过，且 `/home/u/.dsh/storages/cot-form-b/trace.log` 没有新增行 ⇒ 说明测试回到了临时目录，判这条修好，可写结论。
