# 评审稿 t117（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -100) ; bash(cat test/hedge.selftest.mjs 2>/dev/null) → r2 bash(cat src/distill.js; echo ===; cat test/helpers.mjs; echo ===) → r3 bash(cd /tmp 2>/dev/null; cd - >/dev/null; for i in $(seq 1 20); ) ; bash(nproc; cat /proc/loadavg) → r4 bash(cd - >/dev/null; cat > /tmp/burn.mjs <<'EOF' // keep 2 cores)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __o_；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -100) ; bash(cat test/hedge.selftest.mjs 2>/dev/null) → r2 bash(cat src/distill.js; echo ===; cat test/helpers.mjs; echo ===) → r3 bash(cd /tmp 2>/dev/null; cd - >/dev/null; for i in $(seq 1 20); ) ; bash(nproc; cat /proc/loadavg) → r4 bash(which taskset; taskset -c 0 node test/hedge.selftest.mjs 2>&) ; bash(for i in 1 2; do (while :; do :; done) & done; sleep 0.2; fo)
- raw 在 r4 读到的是原文（5205 字）：
  > Let me analyze the bug. ⏎ The test: server primaryDelayMs = 1500, hedgeAfterMs = 1600. Expect primary responds at ~1500ms, before hedge timer at 1600ms. So hedgeStartedAt should be null. ⏎ But it fails with got ~1700. On 2-core CI, event loop lag / scheduling delay. ⏎ The core issue: race condition …
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1329/5205 字）：
  > 已走过的路：第 1 轮 bash `ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -100`；第 1 轮 bash `cat test/hedge.selftest.mjs`；第 2 轮 bash `cat src/distill.js; echo ===; cat test/helpers.mjs; echo ===; cat package.json; echo ===; ls -la…`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、`src/distill.js` 与 `test/hedge.selftest.mjs`：CI 2 核偶发 hedgeStartedAt=null, got 1712（及 `1698`），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 `src/distill.js` 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：改 `src/distill.js` 或在沙箱新建临时脚本跑 次循环复现的路线，因为产品代码逻辑自洽，且 `ci/last5.log` 已经有现成的 2 核失败记录，无需再复现。 ⏎ 改法只落一个：直接修改 `test/hedge.selftest.mjs`，old_text 是 { hedgeAfterMs: 1600 } 改成 …
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
