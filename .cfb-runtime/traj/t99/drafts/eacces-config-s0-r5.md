原文已落定：「Fix: test should use the isolated home.」

隔离由 verify.mjs 提供，回退写在 trace.js，逃逸点是 birth.selftest.mjs 把 home 传成 CFB_REAL_DSH_HOME 这一处入参。改权限那条路原文已堵掉：「We can't fix #2 without sudo」。

未解，带到下一轮：「But should I also harden verify.mjs?」——grep 显示除测试与环境变量外无别处引用，先只落定测试这一处。

验收：跑 `verify.mjs` 拉起的这个套件。若不再报 EACCES ⇒ 说明写入回到临时目录，判已修好。若仍报 ⇒ 说明还有第二处逃逸，回到上面那句未解，不要改权限。
