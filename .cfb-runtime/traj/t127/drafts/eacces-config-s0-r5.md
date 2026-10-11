已观察事实：
- npm test 失败的原始报错是「EACCES open '/home/u/.dsh/storages/cot-form-b/trace.log'」（ctx 中的仓库报告）。用户环境是普通用户 u（uid 1000），没有 sudo。
- test/birth.selftest.mjs 中 home 取值为「home: process.env.CFB_REAL_DSH_HOME」（第 4 轮稿中逐字引用的行，本段仍有效，出处未变）。
矛盾观测（未解）：
- 第 4 轮 ls -la /home/u/.dsh 列出了目录内容，但 find /home/u/.dsh 的思维链记载是「No such file or directory」。两者尚未核对，不能当作目录存在或不存在的结论。
- 思维链里对 verify.mjs 每套件用临时 DSH_HOME 的理解，未在工具回显中核实，只是作者推测。
未解点：CFB_REAL_DSH_HOME 指向的路径，与 DSH_HOME 是否相同，尚未对照；/home/u 与 .dsh 的属主和权限尚未检查，因此 EACCES 的成因未定。
下一步方向：用 ls -ld 核对 /home/u 与 .dsh 的属主和权限，并对照两个环境变量的实际取值（env 输出）。
