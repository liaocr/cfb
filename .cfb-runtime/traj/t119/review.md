# 评审稿 t119（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 1.75
  r1 bash(ls -la; echo ---; cat ci/last5.log | head -100) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat package.json; echo ---; ls src test; echo ---; cat src/*) → r3 bash(nproc; node -v; ls; echo ---; time node test/hedge.selftest.) ; bash(cat ci/last5.log; echo ---; ls -la ci) → r4 bash(cd /tmp && cat > burn.js <<'EOF' // busy loop to create CPU ) ; bash(cd "$(pwd)"; for i in 1 2 3 4 5 6 7 8; do node -e ' const t0)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __oo；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log | head -100) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat package.json; echo ---; ls src test; echo ---; cat src/*) → r3 bash(nproc; node -v; ls; echo ---; time node test/hedge.selftest.) ; bash(cat ci/last5.log; echo ---; ls -la ci) → r4 bash(git log --oneline -20 2>/dev/null; echo ---; git status 2>/d) ; bash(cat > /tmp/hog.mjs <<'EOF' let x=0; const end=Date.now()+200)
- raw 在 r4 读到的是原文（4371 字）：
  > Let me analyze the bug. ⏎ Test: primary delay 1500ms, hedgeAfterMs 1600. Expect hedge never started, so hedgeStartedAt null. ⏎ The code:  ⏎ - primary = fetch(url) (takes ~1500ms) ⏎ - timer set at 1600ms; if primarySettled is false, startHedge. ⏎ - primary.then(() => primarySettled = true) ⏎ - await …
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1233/4371 字）：
  > 已走过的路：第 1 轮 bash `ls -la; echo ---; cat ci/last5.log | head -100`；第 1 轮 bash `cat test/hedge.selftest.mjs`；第 2 轮 bash `cat package.json; echo ---; ls src test; echo ---; cat src/*.js; echo ---; cat test/helpers.mjs`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、src/ 与 `test/hedge.selftest.mjs`：CI 2 核偶发 hedgeStartedAt=null, 1712（及 ），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 src/ 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：改 src/ 或在沙箱新建临时脚本跑 次循环复现的路线，因为产品代码逻辑自洽，且 `ci/last5.log` 已经有现成的 2 核失败记录，无需再复现。 ⏎ 改法只落一个：修改 `test/hedge.selftest.mjs`，将 const server = ({ primaryDelayMs: 1500, : 200 }) 与 const = await hedgedDistill(server url, { hedg…
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=1 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
