# 评审稿 t124（2 行，1 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿第 4 轮生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 2
  r1 bash(ls -la && cat package.json 2>/dev/null && ls test/ && wc -l ) ; bash(cat ci/last5.log) → r2 bash(ls -la src/ && cat package.json && cat test/helpers.mjs) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat src/distill.js; echo ---; ls -la; find . -name 'verify.m) → r4 bash(nproc; node -v; cat > verify.mjs <<'EOF' import './test/hedg) ; bash(cat > /tmp/probe.mjs <<'EOF' import { fakeServer } from './t)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 ___o；代理分 2
  r1 bash(ls -la && cat package.json 2>/dev/null && ls test/ && wc -l ) ; bash(cat ci/last5.log) → r2 bash(ls -la src/ && cat package.json && cat test/helpers.mjs) ; bash(cat test/hedge.selftest.mjs) → r3 bash(cat src/distill.js; echo ---; ls -la; find . -name 'verify.m) → r4 bash(nproc; node -v; cat > verify.mjs <<'EOF' import './test/hedg) ; bash(cat > /tmp/probe.mjs <<'EOF' import { fakeServer } from './t)
- 逐轮代理旗标：raw: r1=2 r2=2 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=2 r3=2 r4=2
