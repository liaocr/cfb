# 评审稿 t114（5 行，4 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## wrong-model:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 5；编辑 —；压缩 ____；代理分 —
  r1 bash(cd /repo 2>/dev/null || cd .; ls -la; echo "---"; find . -pa) ; bash(cat trace/last.log 2>/dev/null | tail -60) → r2 bash(cd .; echo "=== README ==="; cat README.md; echo "=== packag) ; bash(cd .; for f in src/*.js scripts/*.mjs test/*.mjs; do echo "=) → r3 read_file(src/host-follow.legacy.js) → r4 read_file(src/host-follow.js) ; read_file(src/plugin.js) ; read_file(src/transport.js) ; read_file(src/birth.js) ; read_file(scripts/smoke-session.mjs) ; read_file(test/host-follow.selftest.mjs)
- 逐轮代理旗标：hand: 

## sse-truncated:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 3；编辑 —；压缩 __；代理分 —
  r1 bash(find . -type f -not -path './node_modules/*' -not -path './.) ; bash(cat trace/last.log; echo "=====GATEWAY====="; cat docs/gatew) → r2 read_file(src/transport.js) ; read_file(src/birth.js) ; read_file(src/transport.legacy.js) ; read_file(scripts/replay-truncated.mjs) ; read_file(test/transport.selftest.mjs) ; read_file(package.json) ; read_file(README.md)
- 逐轮代理旗标：hand: 

## eacces-config:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 5；编辑 —；压缩 ____；代理分 —
  r1 bash(ls -la; cat package.json) ; bash(cat test/birth.selftest.mjs) → r2 bash(cat verify.mjs; echo ---; ls -la src test; echo ---; cat src) ; bash(id; echo "HOME=$HOME"; echo "CFB_REAL_DSH_HOME=$CFB_REAL_DSH) → r3 bash(cd /home/u 2>/dev/null && pwd; ls -ldn / /home /home/u /home) ; bash(cd ~ && npm test 2>&1 | tail -20; echo "exit=$?") → r4 bash(cd /home/u/work/repo && pwd && ls -la && env | grep -i -E 'h) ; bash(ls -ld / /home /home/u /home/u/.dsh /home/u/.dsh/storages /h) ; bash(cat test/hedge.selftest.mjs; echo ---; ls -l /home/u; echo -)
- 逐轮代理旗标：hand: 

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：4  影子：policy:p-1490eefcdf:稿第 3 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat package.json; echo ---; ls -la src test ci; echo ---; ca) → r3 bash(find . -type f | sort; echo ---; ls -la; echo ---; cat verif) ; bash(cd "$(pwd)"; for i in 1 2 3; do node test/hedge.selftest.mjs) → r4 bash(cat > /tmp/load.mjs <<'EOF' // 占用 CPU 制造调度延迟 const end = Dat)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __oo；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat package.json; echo ---; ls -la src test ci; echo ---; ca) → r3 bash(find . -type f | sort; echo ---; ls -la; echo ---; cat verif) ; bash(cd "$(pwd)"; for i in 1 2 3; do node test/hedge.selftest.mjs) → r4 bash(cd "$(pwd)"; for i in $(seq 1 20); do taskset -c 0 node test) ; bash(cd "$(pwd)"; for c in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; d)
- raw 在 r4 读到的是原文（17996 字）：
  > Let me analyze. The bug: hedge timer fires at 1600ms but primary should settle at 1500ms. Race: on a loaded 2-core CI, the timer callback can fire... wait, timer is cleared after await primary. But the timer fires at 1600ms, primary response at 1500ms. The issue is the ordering: `primary.then(() => …
- policy:p-1490eefcdf 在 r4 读到的稿（r3 压缩，1504/17996 字）：
  > 已走过的路：第 1 轮 bash `ls -la; echo ---; cat ci/last5.log`；第 1 轮 bash `cat test/hedge.selftest.mjs`；第 2 轮 bash `cat package.json; echo ---; ls -la src test ci; echo ---; cat src/distill.js; echo ---; cat…`（不再重跑）。 ⏎ 第 1–2 轮看清 `ci/last5.log`、`src/distill.js` 与 `test/hedge.selftest.mjs`：CI 2 核偶发 expected hedgeStartedAt=null, got 1712（及 `1698`），根因是 `test/hedge.selftest.mjs` 里 primaryDelayMs: 1500 与 hedgeAfterMs: 1600 仅 `100ms` 裕量，在 2 核调度抖动下竞态越界，而 `src/distill.js` 在 `await primary` 后 `clearTimeout(timer)` 逻辑自洽。 ⏎ 已排除：server.listen(0) 后 server.address().port 为空的路线，因为若 失败 fetch 会立刻 、await primary.catch(() => {}) 随即 clearTimeout(timer)，hedgeStartedAt 仍为 null 不会打出 1712。 ⏎ 已排除：改 `src/distill.js` 或在沙箱新建临时脚本…
- policy:p-1490eefcdf r3 压缩闸：{"ok":true,"why":null,"path":"birth-offline","promptVersion":"compress-v5-local:v5-micro-2:a3ddacc67139","spliced":{"droppedContinuation":3,"continuation":1}}
- 双轨分歧语义归因（policy:p-1490eefcdf vs raw @ r4）：已生成评委归因提示词（6 语义维 + 4 类因果归因；加 --judge-prompts 导出 JSON）
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
