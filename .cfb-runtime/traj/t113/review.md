# 评审稿 t113（6 行，3 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## perf-regression:long-horizon #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 5；编辑 —；压缩 ____；代理分 —
  r1 bash(pwd && ls -la && git log --oneline -20) ; bash(which analyze-trace; ls -la $(which analyze-trace) 2>/dev/nu) → r2 bash(cat README.md CHANGELOG.md; echo ---; ls -la src docs logs; ) ; bash(git show --stat HEAD; echo ===; git show HEAD) → r3 bash(echo "=== config.legacy.js ==="; cat src/config.legacy.js; e) ; bash(echo "=== incident-runbook.md ==="; cat docs/incident-runboo) → r4 bash(analyze-trace --compare v11.9 v11.10 --steps birth --fields ) ; bash(analyze-trace --help 2>&1; echo ===; analyze-trace --steps b)
- 逐轮代理旗标：hand: 

## flaky-timeout:long-horizon #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 4；编辑 —；压缩 ___；代理分 —
  r1 bash(ls -la && echo "---" && cat ci/last5.log && echo "---" && ls) ; read_file(test/hedge.selftest.mjs) → r2 read_file(src/distill.js) ; read_file(test/helpers.mjs) ; bash(ls -la src docs logs && echo "---" && cat README.md package.) → r3 bash(cat src/distill.legacy.js; echo "---"; cat src/distill.compa)
- 逐轮代理旗标：hand: 

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(cd /repo 2>/dev/null || pwd; ls -la) ; bash(cat test/hedge.selftest.mjs 2>/dev/null | head -200) → r2 bash(cd /repo; cat package.json; echo ===; cat src/distill.js; ec) ; bash(cd /repo; cat ci/last5.log) → r3 bash(cd /repo; find . -name '*.mjs' -o -name 'verify*' | sort; ec) ; bash(cd /repo; for i in 1 2 3; do /usr/bin/time -f "%e s" node te) → r4 bash(cd /repo; nproc; taskset -c 0,1 node -e 'console.log(require) ; bash(cd /repo; for i in 1 2 3 4 5 6 7 8; do taskset -c 0,1 node t)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __oo；代理分 2
  r1 bash(cd /repo 2>/dev/null || pwd; ls -la) ; bash(cat test/hedge.selftest.mjs 2>/dev/null | head -200) → r2 bash(cd /repo; cat package.json; echo ===; cat src/distill.js; ec) ; bash(cd /repo; cat ci/last5.log) → r3 bash(cd /repo; find . -name '*.mjs' -o -name 'verify*' | sort; ec) ; bash(cd /repo; for i in 1 2 3; do /usr/bin/time -f "%e s" node te) → r4 bash(cd /repo; git log --oneline -20 2>/dev/null; echo ===; git s) ; bash(cd /repo; cat .git/logs/HEAD 2>/dev/null | tail -20; echo ==)
- raw 在 r4 读到的是原文（13360 字）：
  > Let me analyze the bug. ⏎ The test: server primary delay 1500ms, hedgeAfterMs 1600. So the primary response arrives at ~1500ms, and the hedge timer fires at 1600ms. Expected hedgeStartedAt null. ⏎ In distill.js:  ⏎ - primary = fetch(url) ⏎ - timer = setTimeout(() => { if (!primarySettled) startHedge…
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1399/13360 字）：
  > 已走过的路：第 1 轮 bash `cd /repo 2>/dev/null || pwd; ls -la`；第 1 轮 bash `cat test/hedge.selftest.mjs 2>/dev/null | head -200`；第 2 轮 bash `cd /repo; cat package.json; echo ===; cat src/distill.js; echo ===; cat test/helpers.mjs; echo ===;…`；第 2 轮 bash `cd /repo; cat ci/last5.log`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、`src/distill.js` 与 `test/hedge.selftest.mjs`：CI 2 核偶发 hedgeStartedAt=null, 1712（及 `1698`），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 `src/distill.js` 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：改 `src/distill.js` 或在沙箱新建临时脚本跑 次循环复现的路线，因为产品代码逻辑自洽，且 `ci/last5.log` 已经有现成的 2 核失败记录，无需再复现。 ⏎ 改法只落一个：直接修改 `test/hedge.selftest.mj…
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
