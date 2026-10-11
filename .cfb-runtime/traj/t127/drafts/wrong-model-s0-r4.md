已观察事实：
- 用户报告：插件压缩用的是上一次会话的模型。任务原文验收：压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model），旧宿主仍传 options.model 时也要对。
- 复现方式（任务原文）：node scripts/smoke-session.mjs，模拟两次会话，写 trace/trace.log 并打印最后几行。
- 第 3 轮对 src/host-follow.js 与 src/plugin.js 的读取，在 ctx 中只摘录到「$ cd /home/u/work/repo」，文件内容未在本段中逐字出现。
推理链所读、工具回显中未逐字核对的内容（待核）：
- src/plugin.js 以 (options, n) 调用 observe，而 observe 只接收 options；当 options.model 缺失时，记住的模型不会更新。
- 模型记在模块级变量里，跨会话、跨实例共享。
未解：
- 上面两点哪一个是真正的成因，尚未用 scripts/smoke-session.mjs 的输出确认。
- trace/last.log 中 compiler-transport-started 的 model 字段，尚未在工具回显里逐字看到。
- test/host-follow.selftest.mjs 的断言内容只摘录到「$ cd /home/u/work/repo」，未核实它是否覆盖 n.model 的情形。
下一步方向：运行 scripts/smoke-session.mjs，读取 trace/trace.log 中 compiler-transport-started 的 model 字段，与 n.model 对照；核对 observe 的调用参数顺序。
