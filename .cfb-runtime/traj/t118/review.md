# 评审稿 t118（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿未生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 1.25
  r1 bash(ls -la; echo ---; cat package.json 2>/dev/null; echo ---; ls) ; bash(cat ci/last5.log) → r2 bash(ls -la src test; echo ===; cat verify.mjs 2>/dev/null; echo ) ; bash(for f in test/*; do echo "--- $f"; cat "$f"; done) → r3 bash(ls -la src test) ; bash(cat verify.mjs) ; bash(ls -la src test; echo ===; cat verify.mjs 2>/dev/null) ; read_file(src/hedge.mjs) → r4 read_file(src/distill.js) ; read_file(test/hedge.selftest.mjs) ; read_file(test/helpers.mjs)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 ____；代理分 1.25
  r1 bash(ls -la; echo ---; cat package.json 2>/dev/null; echo ---; ls) ; bash(cat ci/last5.log) → r2 bash(ls -la src test; echo ===; cat verify.mjs 2>/dev/null; echo ) ; bash(for f in test/*; do echo "--- $f"; cat "$f"; done) → r3 bash(ls -la src test) ; bash(cat verify.mjs) ; bash(ls -la src test; echo ===; cat verify.mjs 2>/dev/null) ; read_file(src/hedge.mjs) → r4 read_file(src/distill.js) ; read_file(test/hedge.selftest.mjs) ; read_file(test/helpers.mjs)
- 逐轮代理旗标：raw: r1=2 r2=0 r3=1 r4=2 | policy:p-1490eefcdf: r1=2 r2=0 r3=1 r4=2
