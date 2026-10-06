# 评审稿 t105（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿未生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(pwd && ls -la && echo "---" && ls ci/) ; read_file(test/hedge.selftest.mjs) → r2 bash(cat package.json && echo "=== src ===" && ls src test && ech) ; read_file(src/distill.js) ; bash(cat ci/last5.log) → r3 bash(cd /home/u/work/repo && node -e " import('node:http').then(a) ; bash(cd /home/u/work/repo && for i in $(seq 1 10); do node test/h) → r4 bash(cd /home/u/work/repo && find . -type f | sort && echo '---' ) ; bash(cd /home/u/work/repo && cat test/helpers.mjs && echo '=== lo)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 __x_；代理分 2
  r1 bash(pwd && ls -la && echo "---" && ls ci/) ; read_file(test/hedge.selftest.mjs) → r2 bash(cat package.json && echo "=== src ===" && ls src test && ech) ; read_file(src/distill.js) ; bash(cat ci/last5.log) → r3 bash(cd /home/u/work/repo && node -e " import('node:http').then(a) ; bash(cd /home/u/work/repo && for i in $(seq 1 10); do node test/h) → r4 bash(cd /home/u/work/repo && find . -type f | sort && echo '---' ) ; bash(cd /home/u/work/repo && cat test/helpers.mjs && echo '=== lo)
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
