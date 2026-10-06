# 评审稿 t111（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 1.75
  r1 bash(ls -la && echo "---" && cat package.json 2>/dev/null && echo) ; bash(cat test/hedge.selftest.mjs 2>/dev/null) → r2 bash(cat ci/last5.log; echo "===HELPERS==="; cat test/helpers.mjs) ; bash(cat src/distill.js; echo "===TESTS==="; ls -la test; ) → r3 bash(nproc; node -v; echo "--- run selftest once ---"; time node ) ; bash(for i in 1 2 3; do /usr/bin/time -f "run%$i wall=%e s" node ) → r4 bash(cat > /tmp/load.sh <<'EOF' #!/bin/bash # spawn N cpu hogs N=) ; bash(for i in $(seq 1 8); do (while :; do :; done) & done; HOGS=$)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __oo；代理分 2
  r1 bash(ls -la && echo "---" && cat package.json 2>/dev/null && echo) ; bash(cat test/hedge.selftest.mjs 2>/dev/null) → r2 bash(cat ci/last5.log; echo "===HELPERS==="; cat test/helpers.mjs) ; bash(cat src/distill.js; echo "===TESTS==="; ls -la test; ) → r3 bash(nproc; node -v; echo "--- run selftest once ---"; time node ) ; bash(for i in 1 2 3; do /usr/bin/time -f "run%$i wall=%e s" node ) → r4 bash(cd /tmp && cat > load.mjs <<'EOF' // 模拟 CI：持续占用 CPU，制造事件循环抖动) ; bash(cd /tmp && cat > probe.mjs <<'EOF' // 直接测量：主请求实际用时 vs hedge )
- raw 在 r4 读到的是原文（11104 字）：
  > Let me analyze. The test: primary request resolves after 1500ms, hedgeAfterMs 1600. So the hedge timer (1600ms) should be cleared before firing because primary settles at 1500ms. Got hedgeStartedAt 1712/1698 on CI — the hedge actually fired. ⏎ Why? The code: ⏎ ```js ⏎ const primary = fetch(url) ⏎ co…
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1284/11104 字）：
  > 已走过的路：第 1 轮 bash `ls -la && echo "---" && cat package.json 2>/dev/null && echo "---CI LOG---" && wc -l ci/last5.log`；第 1 轮 bash `cat test/hedge.selftest.mjs`；第 2 轮 bash `cat ci/last5.log; echo "===HELPERS==="; cat test/helpers.mjs; echo "===SRC LIST==="; ls -la src;…`；第 2 轮 bash `cat src/distill.js; echo "===TESTS==="; ls -la test;`（不再重跑）。 ⏎ 看清 `test/hedge.selftest.mjs` 与 `src/distill.js`：主请求 1500ms 返回 200，而 hedgeAfterMs: 1600 只留 100ms 余量；2 核调度抖动下竞态打出 hedgeStartedAt=null, 1712（及 `1698`），16 核不败。 ⏎ 已排除：清除 `timer` 或在 `primary` 回调里置位（同一 `timers` 阶段里定时器先跑，换挂钩点解决不了）；已排除：调大超时（治症状）或改 `src/distill.js` 的逻辑（不是逻辑错，是测试阈值太紧），不要再把 `hedgeAfterMs` 调到 ，不要再跑 50 次循环，不声称已修复。 ⏎ 改法只落一个：edit_file test/hedge.selftes…
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=1 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
