# 评审稿 t120（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(cd /repo 2>/dev/null || cd .; pwd; ls -la; echo ---; cat ci/) ; bash(cat test/hedge.selftest.mjs 2>/dev/null; echo ---; ls -R | h) → r2 bash(cat src/distill.js; echo =====; cat test/helpers.mjs; echo =) → r3 bash(node -v; nproc; echo '== plain =='; f=0; for i in $(seq 1 20) ; bash(echo '== under CPU load =='; for i in $(seq 1 4); do (while ) → r4 bash(f=0; for i in $(seq 1 20); do node test/hedge.selftest.mjs >) ; bash(for i in $(seq 1 4); do (while :; do :; done) & done; b=$(jo)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __o_；代理分 2
  r1 bash(cd /repo 2>/dev/null || cd .; pwd; ls -la; echo ---; cat ci/) ; bash(cat test/hedge.selftest.mjs 2>/dev/null; echo ---; ls -R | h) → r2 bash(cat src/distill.js; echo =====; cat test/helpers.mjs; echo =) → r3 bash(node -v; nproc; echo '== plain =='; f=0; for i in $(seq 1 20) ; bash(echo '== under CPU load =='; for i in $(seq 1 4); do (while ) → r4 bash(cd /home/u/work/repo; nproc; echo '== plain 20x =='; fail=0;) ; bash(cd /home/u/work/repo; echo '== loaded 20x =='; for i in $(se)
- raw 在 r4 读到的是原文（21509 字）：
  > Let me analyze the bug. ⏎ The test: server primary delay 1500ms, hedgeAfterMs 1600. Expected: hedge never starts (hedgeStartedAt = null). Because primary responds at 1500ms, before hedge timer at 1600ms. ⏎ The implementation: timer set at 1600ms, but `primary.then(() => primarySettled = true)`. Prob…
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1402/21509 字）：
  > 已走过的路：第 1 轮 bash `cd /repo 2>/dev/null || cd .; pwd; ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -200`；第 1 轮 bash `cat test/hedge.selftest.mjs 2>/dev/null; echo ---; ls -R | head -60`；第 2 轮 bash `cat src/distill.js; echo =====; cat test/helpers.mjs; echo =====; cat package.json`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、`src/distill.js` 与 `test/hedge.selftest.mjs`：CI 2 核偶发 expected hedgeStartedAt=null, 1712（及 ），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 `hedgeAfterMs: 1600` 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 `src/distill.js` 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：改 `src/distill.js` 或在沙箱新建临时脚本跑 20 次循环复现的路线，因为产品代码逻辑自洽，且 `ci/last5.log` 已经有现成的 2 核失败记录，无需再复现。 ⏎ 改法只落一个：直接修改…
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
