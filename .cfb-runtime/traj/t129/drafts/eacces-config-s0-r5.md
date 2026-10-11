本轮增量：
- 报错原文是「EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'」（ctx 中的仓库报告）。
- test/birth.selftest.mjs 的写入目录来自 CFB_REAL_DSH_HOME（推理链读到，已在延续段引用）。DSH_HOME 与 CFB_REAL_DSH_HOME 在本沙箱的实际取值，尚未用 env 输出逐字核实。
- 闭合判读（读数 ⇒ 结论）：若读到 CFB_REAL_DSH_HOME 指向 /home/u/.dsh，则说明测试写的是真实目录，而不是 verify 为各套件分配的临时目录。若 DSH_HOME 指向临时目录，则说明测试绕过了隔离。
- 未解：这两个变量是否真的不同，尚未核对；/home/u 的属主与权限也未用 node -e 检查，EACCES 的成因未定。
- 验收：修改后运行 `npm test`，看到 test/birth.selftest.mjs 不再报 EACCES、通过计数不减，即算完。若仍看到同一路径的 EACCES，则说明修法没有覆盖该调用，回到上一条判读重新核对。
