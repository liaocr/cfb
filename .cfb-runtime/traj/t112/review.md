# 评审稿 t112（6 行，4 组；零 API）

读法：先看分歧轮 —— 两臂在那一轮之前读到的东西只差一份稿；稿里缺了什么 / 多定了什么，就是下一份候选该改的地方。留出家族的内容不要写进证据包。

## wrong-model:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：未修好；声明 none；轮 3；编辑 —；压缩 ___；代理分 1
  r1 bash(find . -type f -not -path "./node_modules/*" -not -path "./.) ; bash(cat trace/last.log 2>/dev/null | tail -50) → r2 bash(for f in README.md scripts/smoke-session.mjs src/*.js test/*) → r3 «无调用»
- 逐轮代理旗标：hand: r1=2 r2=0 r3=1

## eacces-config:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：修好@r7；声明 none；轮 8；编辑 test/birth.selftest.mjs；压缩 ________；代理分 1.667
  r1 bash(cd /repo 2>/dev/null || pwd; ls -la; cat package.json) ; bash(ls -la /home/u/.dsh/storages/cot-form-b/ 2>&1; id; whoami) → r2 bash(cd /repo; cat README.md; echo ---; cat verify.mjs; echo ---;) ; bash(cd /repo; grep -rn "trace.log\|dsh\|storages\|openSync\|appe) → r3 bash(cd /repo; cat README.md; echo ---; cat verify.mjs; echo ---;) ; read_file(src/trace.js) → r4 bash(cd /repo; cat src/trace.legacy.js; echo ---; cat test/birth.) ; bash(cd /repo; npm test 2>&1 | head -40) → r5 bash(cd /repo; env | grep -i -E "dsh|home|CFB" ; echo "--- exit $) ; bash(ls -la /home/u/ 2>&1; echo ---; ls -la /home/u/.dsh 2>&1; ec) → r6 bash(cd /repo; grep -rn "CFB_REAL_DSH_HOME" . -I) ; bash(cd /repo; DSH_HOME=/tmp/cfb-probe node -e "const fs=require() → r7 edit_file(test/birth.selftest.mjs) → r8 bash(cd /repo; cat test/birth.selftest.mjs; echo ===; npm test 2>) ; bash(cd /repo; node verify.mjs 2>&1 | tail -20; echo === ; cat te)
- 逐轮代理旗标：hand: r1=2 r2=1 r3=2 r4=2 r5=2 r6=1 r7=2 r8=2

## sse-truncated:decoy #0  臂：hand  分歧轮：无（动作全同）
- **hand**：修好@r6；声明 none；轮 8；编辑 src/transport.js,src/transport.js,test/transport.selftest.mjs,test/transport.selftest.mjs；压缩 ____o___；代理分 1.8
  r1 bash(find . -type f -not -path './node_modules/*' -not -path './.) ; read_file(docs/gateway.md) ; read_file(trace/last.log) → r2 read_file(src/transport.js) ; read_file(src/birth.js) ; read_file(scripts/replay-truncated.mjs) ; read_file(test/transport.selftest.mjs) → r3 bash(node scripts/replay-truncated.mjs; echo "--- exit $? ---"; e) ; bash(node scripts/replay-truncated.mjs; echo "--- exit $? ---"; l) ; bash(npm test 2>&1 | tail -20) → r4 bash(grep -rn "transport" src test scripts README.md docs 2>/dev/) → r5 bash(ls -la; echo '--- find all ---'; find . -type f -not -path ') ; bash(npm test; echo EXIT=$?) ; read_file(verify.mjs) → r6 edit_file({"path": "src/transport.js", "old_text": "export function as) ; edit_file(src/transport.js) → r7 read_file(src/transport.js) ; bash(node scripts/replay-truncated.mjs; echo '--- npm test ---'; ) → r8 edit_file({"path": "test/transport.selftest.mjs", "old_text": "// 4 ev) ; edit_file(test/transport.selftest.mjs)
- 逐轮代理旗标：hand: r1=2 r2=2 r3=2 r4=2 r5=1 r6=2 r7=2 r8=1

## flaky-timeout #0  臂：raw / policy:p-1490eefcdf  分歧轮：无（动作全同）  影子：policy:p-1490eefcdf:稿未生效
- **raw**：未修好；声明 none；轮 4；编辑 —；压缩 —；代理分 1.5
  r1 bash(ls -la && cat package.json 2>/dev/null) ; bash(cat ci/last5.log 2>/dev/null | head -200) → r2 bash(ls -la src test ci && echo "---" && for f in src/* test/*; d) → r3 bash(ls -la src test ci) ; read_file(test/hedge.selftest.mjs) → r4 read_file(test/helpers.mjs) ; read_file(src/distill.js) ; read_file(ci/last5.log)
- **policy:p-1490eefcdf**：未修好；声明 none；轮 4；编辑 —；压缩 ____；代理分 1.5
  r1 bash(ls -la && cat package.json 2>/dev/null) ; bash(cat ci/last5.log 2>/dev/null | head -200) → r2 bash(ls -la src test ci && echo "---" && for f in src/* test/*; d) → r3 bash(ls -la src test ci) ; read_file(test/hedge.selftest.mjs) → r4 read_file(test/helpers.mjs) ; read_file(src/distill.js) ; read_file(ci/last5.log)
- 逐轮代理旗标：raw: r1=2 r2=0 r3=2 r4=2 | policy:p-1490eefcdf: r1=2 r2=0 r3=2 r4=2
