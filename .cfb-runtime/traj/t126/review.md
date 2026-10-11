# 评审稿 t126（7 行，4 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:base  分歧轮：无（动作全同）  影子：policy:base:稿未生效
- **raw**：未修好；声明 none；轮 5；编辑 —；压缩 —；代理分 2
  r1 bash(find . -type f -not -path './.git/*' | head -50; echo "---";) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat -n src/distill.js) ; bash(cat -n test/helpers.mjs; echo ---; cat package.json) → r3 bash(ls -la; echo ---; ls -la test ci src; echo ---; git log --on) ; bash(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)";) → r4 bash(for i in $(seq 1 20); do node test/hedge.selftest.mjs 2>&1 |) → r5 bash(node test/hedge.selftest.mjs) ; bash(node -e "console.log(require('os').cpus().length)")
- **policy:base**：未修好；声明 none；轮 5；编辑 —；压缩 __x__；代理分 2
  r1 bash(find . -type f -not -path './.git/*' | head -50; echo "---";) ; bash(cat test/hedge.selftest.mjs) → r2 bash(cat -n src/distill.js) ; bash(cat -n test/helpers.mjs; echo ---; cat package.json) → r3 bash(ls -la; echo ---; ls -la test ci src; echo ---; git log --on) ; bash(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)";) → r4 bash(for i in $(seq 1 20); do node test/hedge.selftest.mjs 2>&1 |) → r5 bash(node test/hedge.selftest.mjs) ; bash(node -e "console.log(require('os').cpus().length)")
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 r5=2 | policy:base: r1=2 r2=2 r3=2 r4=2 r5=2

## wrong-model:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 5；编辑 —；压缩 ____；代理分 —
  r1 bash(cd /repo 2>/dev/null || cd .; ls -la; echo "---"; cat packag) ; bash(cd .; find . -path ./node_modules -prune -o -type f -name '*) → r2 bash(cd .; cat README.md; echo "=== last.log ==="; cat trace/last) ; bash(cd .; for f in src/*.js test/*.mjs; do echo "===== $f =====") → r3 read_file(src/plugin.js) → r4 read_file(src/host-follow.js) ; read_file(src/host-follow.legacy.js) ; read_file(src/transport.js) ; read_file(src/birth.js) ; read_file(test/host-follow.selftest.mjs)
- 逐轮代理旗标：hand: 

## eacces-config:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 5；编辑 —；压缩 ____；代理分 —
  r1 bash(ls -la; cat package.json) ; bash(ls -la test/ 2>/dev/null; cat test/birth.selftest.mjs 2>/dev) → r2 bash(cat verify.mjs; echo ---; ls -la src; echo ---; cat src/*.js) ; bash(id; echo "HOME=$HOME"; ls -la /home/u/.dsh 2>&1; ls -la /hom) → r3 bash(grep -rn "CFB_REAL_DSH_HOME\|DSH_HOME" . --include=* 2>/dev/) ; bash(stat -c '%n owner=%U:%G mode=%a' /home/u /home/u/.dsh /home/) → r4 bash(node -e "const fs=require('fs');for(const p of ['/home/u','/) ; bash(cd . && node verify.mjs 2>&1 | head -40; echo "exit=$?")
- 逐轮代理旗标：hand: 

## sse-truncated:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 —；轮 6；编辑 —；压缩 _____x；代理分 —
  r1 bash(cd / && ls -la && find . -maxdepth 2 -name "*.json" -path "*) ; bash(pwd; ls -la) → r2 bash(cd /home/u/work/repo && cat README.md package.json && ls -la) ; bash(cd /home/u/work/repo && cat docs/gateway.md) ; bash(cd /home/u/work/repo && cat trace/last.log) → r3 bash(cd /home/u/work/repo && cat src/transport.legacy.js src/tran) ; bash(cd /home/u/work/repo && cat scripts/replay-truncated.mjs tes) ; bash(cd /home/u/work/repo && cat src/transport.legacy.js src/tran) ; bash(cd /home/u/work/repo && cat scripts/replay-truncated.mjs tes) → r4 bash(cd /home/u/work/repo && node scripts/replay-truncated.mjs &&) ; bash(cd /home/u/work/repo && npm test 2>&1; echo '---'; cat verif) ; bash(cd /home/u/work/repo && npm test 2>&1; echo '---'; ls; echo ) → r5 bash(cd /home/u/work/repo && find / -name verify.mjs 2>/dev/null ) ; bash(cd /home/u/work/repo && cat .gitignore 2>/dev/null; git log ) ; bash(cd /home/u/work/repo && find / -name verify.mjs 2>/dev/null )
- 逐轮代理旗标：hand: 
