# 评审稿 t102（4 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(ls -la; echo ---; cat package.json 2>/dev/null; echo ---; ls) ; bash(cat ci/last5.log 2>/dev/null | head -200) → r2 bash(ls -la src test; echo ---; cat src/* | head -300) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat test/helpers.mjs; echo ---; cat verify.mjs 2>/dev/null; ) ; bash(nproc; node -v; cd . && time node test/hedge.selftest.mjs) → r4 bash(for i in $(seq 1 8); do node -e 'const t=Date.now();while(Da) ; bash(cat ci/last5.log)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __oo；代理分 2
  r1 bash(ls -la; echo ---; cat package.json 2>/dev/null; echo ---; ls) ; bash(cat ci/last5.log 2>/dev/null | head -200) → r2 bash(ls -la src test; echo ---; cat src/* | head -300) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat test/helpers.mjs; echo ---; cat verify.mjs 2>/dev/null; ) ; bash(nproc; node -v; cd . && time node test/hedge.selftest.mjs) → r4 bash(ls -la; git -C . log --oneline -20 2>&1 | head; echo ---; gi) ; bash(cat -n src/distill.js; echo ===; cat -n test/hedge.selftest.)
- raw 在 r4 读到的是原文（2739 字）：
  > Let's read helpers.mjs and think. ⏎ The bug: `primary.then(() => { primarySettled = true })` — the promise chain runs in microtask, but `await primary.catch(...)` resolves... Actually the issue: `primarySettled` is set in a `.then` attached before. Hmm, timing. ⏎ Actually the real bug: the timer fir…
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1173/2739 字）：
  > 已走过的路：第 1 轮 bash `ls -la; echo ---; cat package.json 2>/dev/null; echo ---; ls ci/ test/`；第 1 轮 bash `cat ci/last5.log 2>/dev/null | head -200`；第 2 轮 bash `ls -la src test; echo ---; cat src/* | head -300`；第 2 轮 bash `cat test/hedge.selftest.mjs`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、src/ 与 `test/hedge.selftest.mjs`：CI 2 核偶发 =null, 1712（及 ），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 src/ 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：改 src/ 或在沙箱新建临时脚本跑 次循环复现的路线，因为产品代码逻辑自洽，且 `ci/last5.log` 已经有现成的 2 核失败记录，无需再复现。 ⏎ 改法只落一个：修改 `test/hedge.selftest.mjs`，将 const server = ({ primaryDelayMs: 1500, : 200 }) 与 const = await (server url, { …
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
