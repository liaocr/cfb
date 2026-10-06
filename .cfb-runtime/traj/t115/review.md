# 评审稿 t115（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿第 4 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -100) ; bash(find . -name "*.mjs" -o -name "package.json" | grep -v node_) → r2 bash(ls -la src test ci; echo ---; cat package.json) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat src/distill.js; echo ---; cat test/helpers.mjs; echo ---) → r4 bash(cd /workspace 2>/dev/null; node test/hedge.selftest.mjs; ech) ; bash(cd .; for i in 1 2 3; do node test/hedge.selftest.mjs; done)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 ___o；代理分 2
  r1 bash(ls -la; echo ---; cat ci/last5.log 2>/dev/null | head -100) ; bash(find . -name "*.mjs" -o -name "package.json" | grep -v node_) → r2 bash(ls -la src test ci; echo ---; cat package.json) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat src/distill.js; echo ---; cat test/helpers.mjs; echo ---) → r4 bash(cd /workspace 2>/dev/null; node test/hedge.selftest.mjs; ech) ; bash(cd .; for i in 1 2 3; do node test/hedge.selftest.mjs; done)
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
