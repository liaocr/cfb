已观察事实：
- 用户报告：插件压缩用的是上一次会话的模型。任务原文验收：「压缩那一跳（trace 里 compiler-transport-started 的 model）必须等于当前会话的模型（n.model）」，旧宿主仍传 options.model 时也要对。
- src/host-follow.js 的注释逐字为「// 跟随宿主：记住宿主最近一次用的模型，压缩那一跳沿用它（避免副模型与会话模型不一致）」（ctx 已摘录）。
- 第 3 轮读到 src/plugin.js 的首行「import { makeHostFollow } from './host-follow.js'」（ctx 已摘录）。
- 第 4 轮读到 src/birth.js 含「export function birthTransform(n, { cfg, trace }) {」（ctx 已摘录）。
推理链所读、工具回显中未逐字核对的内容（待核）：
- plugin.js 以 (options, n) 调用 observe，而 host-follow.js 的 observe 只接收 options；当 options.model 缺失时，记住的模型不会更新。
- 模型记在模块级变量里，跨会话、跨实例共享。
- smoke 脚本模拟两次会话：第一次 options.model 有值，第二次只有 n.model；推理链据此推断记住的仍是第一次的模型（未经运行确认）。
未解：
- 上面几点哪一个是真正的成因，尚未用 scripts/smoke-session.mjs 的输出确认。
- trace 中 seq 12、13 的模型字段，尚未在工具回显中逐字看到。
- test 目录内容只摘录到「$ cat scripts/smoke-session.mjs」「ls test」，断言未核。
下一步方向：运行 scripts/smoke-session.mjs，读取 trace/trace.log 中 compiler-transport-started 的 model 字段，与 n.model 对照；再核对 birthTransform 与 observe 的调用参数。
