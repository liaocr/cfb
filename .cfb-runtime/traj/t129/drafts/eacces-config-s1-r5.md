本轮增量：
- 报错原文是「EACCES: permission denied, open '/home/u/.dsh/storages/cot-form-b/trace.log'」（ctx 中的仓库报告）。
- test/birth.selftest.mjs 的写入目录取自 CFB_REAL_DSH_HOME（推理链读到，未在工具回显中逐字核对）。verify.mjs 为各套件分配临时 DSH_HOME 的做法，来自推理链读到的 verify.mjs 内容（待核）。
- 观测矛盾（未解）：推理链记载 ls 显示 cot-form-b 目录存在、且其中有 trace.log，而 /home/u/.dsh 的属主是 root（推理链推断，未用 stat 核实）。两者尚未对照。
- 闭合判读（读数 ⇒ 结论）：若 npm test 仍报出上面同一 EACCES 路径，则说明测试写入的是 CFB_REAL_DSH_HOME 指向的真实目录，而不是临时目录。若改用临时 DSH_HOME 后不再报错，则说明原因是绕过了隔离。
- 验收：修改后运行 `npm test`，看到 test/birth.selftest.mjs 不再报 EACCES，且通过的测试数不减，即算完。若同一路径的 EACCES 仍然出现，则说明修法未覆盖该调用，回到上一条判读。
