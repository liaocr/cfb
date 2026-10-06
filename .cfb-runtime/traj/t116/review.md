# 评审稿 t116（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿未生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 1.75
  r1 bash(pwd && ls -la && cat package.json 2>/dev/null) ; bash(ls -la ci/ test/ 2>/dev/null) → r2 bash(cd /home/u/work/repo && cat ci/last5.log && echo "=== verify) ; bash(cd /home/u/work/repo && for f in src/*; do echo "=== $f ===") → r3 bash(cd /home/u/work/repo && ls src && cat src/*.mjs 2>/dev/null;) ; bash(cd /home/u/work/repo && ls -la && find . -name 'verify*' -o ) → r4 bash(cd /home/u/work/repo && echo "=== hedge.selftest.mjs ===" &&) ; bash(cd /home/u/work/repo && echo "=== helpers.mjs ===" && cat te) ; bash(cd /home/u/work/repo && ls -la && find . -type f | sort && e)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 ____；代理分 1.75
  r1 bash(pwd && ls -la && cat package.json 2>/dev/null) ; bash(ls -la ci/ test/ 2>/dev/null) → r2 bash(cd /home/u/work/repo && cat ci/last5.log && echo "=== verify) ; bash(cd /home/u/work/repo && for f in src/*; do echo "=== $f ===") → r3 bash(cd /home/u/work/repo && ls src && cat src/*.mjs 2>/dev/null;) ; bash(cd /home/u/work/repo && ls -la && find . -name 'verify*' -o ) → r4 bash(cd /home/u/work/repo && echo "=== hedge.selftest.mjs ===" &&) ; bash(cd /home/u/work/repo && echo "=== helpers.mjs ===" && cat te) ; bash(cd /home/u/work/repo && ls -la && find . -type f | sort && e)
- 逐轮代理旗标：raw: r1=2 r2=1 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=1 r3=2 r4=2
