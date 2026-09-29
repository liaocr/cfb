import sys; sys.path.insert(0, '/home/user/oracle'); from mk import build
# oracle-A：理论全部修订的手写实现。只用任务原文 + 原文思考（不看 followup / reference）。
T = {}
T['wrong-model'] = '''
先把代码摆清楚。host-follow.js：
let lastModel = null
observe(options) { if (options && options.model) lastModel = options.model }
callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }
plugin.js 里调用的是 host.observe(options, n)，接着 const callCfg = host.callConfig(options)，callCfg 传进 birthTransform。

trace 里 llm-stream 的 n12、n13 都是 deepseek-v3.2，夹在中间的 compiler-transport-started 却是 deepseek-v3.1，正是上一次会话的模型。

我的判断：lastModel 是模块级单例，跨会话保留；observe 只认第一个参数的 options.model，plugin 传进来的第二个参数 n 被整个忽略。只要当前会话的模型不在 options.model 上，lastModel 就一直停在上一次会话的值，callConfig 再用 lastModel || cfg.model 把它盖到压缩配置上。调用顺序没问题（先 observe 后 callConfig）。prewarm 我想过，它用的是原始 cfg，解释不了“上一次会话的模型”，不追。

刚发出的调用是看 plugin.js 里 options 和 n 怎么构造。如果结果显示当前模型在 n（或 options 的别的字段）里、options.model 为空，根因就坐实了，要改的就是 observe(options) { if (options && options.model) lastModel = options.model } 这一行：让它读到当前会话的模型，而不是只看 options.model。如果 options.model 确实带着当前模型，那就回头查 observe 与 callConfig 之间有没有别处改写 lastModel。
'''
T['eacces-config'] = '''
失败是 EACCES：open '/home/u/.dsh/storages/cot-form-b/trace.log'。这个文件和它的目录都属 root（-rw-r--r-- / drwxr-xr-x），我是 uid=1000(u)，只能读，改不了也删不掉。

但测试本来就不该碰真实 home。verify.mjs 里是
const env = { ...process.env, DSH_HOME: tmp }
每个套件本应在临时 DSH_HOME 里跑；而 test/birth.selftest.mjs 写的是
const w = makeTraceWriter({ home: process.env.CFB_REAL_DSH_HOME })
它根本不看 DSH_HOME，用的是 CFB_REAL_DSH_HOME，于是绕过了隔离，写到了 /home/u/.dsh。所以根因是隔离变量没对齐，root 属主只是把问题暴露出来。去 chown / sudo 修权限不对：那是在改真实 home，不是修测试。

刚发出的调用是 grep CFB_REAL_DSH_HOME 的所有引用、并看它是否被设置。如果 verify.mjs 里完全没有这个变量，测试就是从父进程继承到了真实路径。我准备的改法有两个，都只动一行：把测试里那行改成 makeTraceWriter({ home: process.env.DSH_HOME })，或者在 verify.mjs 的 env 里加上 CFB_REAL_DSH_HOME: tmp。改测试更干净，因为隔离约定本来就是 DSH_HOME。
'''
T['flaky-timeout'] = '''
§4 的时间设置：主请求 1500ms 后回 200，hedgeAfterMs 是 1600，断言 hedgeStartedAt 为 null。只留了 100ms 余量。hedgedDistill 里是
const timer = setTimeout(() => { if (!primarySettled) startHedge() }, cfg.hedgeAfterMs)
primary.then(() => { primarySettled = true })
CI 失败时 got 1712、1698，都比 1600 晚一百来毫秒；CI nproc=2，本地 16。

我的判断：这是时序竞态，不是业务逻辑错。2 核 CI 上事件循环被拖慢，server 的 1500ms 回调和对冲的 1600ms 定时器积压到同一轮 timers 阶段，先执行 server 回调发出 200，紧接着执行对冲定时器；而主请求的 HTTP 响应要到后面的 poll 阶段才 resolve，primary.then 还没把 primarySettled 置 true，对冲就启动了。清掉 timer、改 primary.finally 都解决不了“同一轮 timers 里定时器先跑”，不走这条。

修法我已经想好：拉大主请求延迟和 hedgeAfterMs 之间的余量，或者改用假定时器，让测试不再依赖真实定时器的精度。

刚发出的调用是 taskset -c 0,1 限到 2 核循环跑 test/hedge.selftest.mjs。如果失败复现、且失败值同样落在 1700 左右，时序竞态就坐实了，下一步直接改测试 §4 的 hedgeAfterMs: 1600 这一处，不再继续复现。如果 2 核下 50 次都不失败，再怀疑别的负载来源。
'''
T['sse-truncated'] = '''
trace：compiler-transport-settled 是 ok:true、finish:null、stream:true、outputChars:212、eventCount:9；birth-condensed 是 rawChars 8123 → outChars 212。只有 212 字、没有 finish_reason，却被当成功写进了会话。

assembleSseFrames 的关键两行：
if (f === '[DONE]') { done = true; continue }
return { out, finish: finish || (done ? 'stop' : null) }
finish 只在真的收到 finish_reason 时才赋值；没有 finish_reason 时，光凭 [DONE] 就回退成 'stop'。网关文档说部分上游在连接被代理切断时只补发 data: [DONE]。所以被切断的流会拿到“stop”，截断被当成正常结束。

还有一处我没对上：trace 里 finish 是 null，而按这段代码 done=true 时应该返回 'stop'。要么 settle 记的是原始 finish_reason，要么 ok 的判定根本不看 finish（比如只看 out 非空）。两种情况下 bug 都在“没有真实 finish_reason 也算成功”。

修法方向已经清楚：区分“finish_reason 缺失”和“收到 [DONE]”，只有 [DONE] 没有 finish_reason 时返回 incomplete，不再回退成 stop；调用方的 ok 必须要求真实 finish_reason。

刚发出的调用是 grep compiler-transport-settled / assembleSseFrames 的调用处。如果看到 ok 只由 out 长度或 done 决定，就直接改那一处判定，同时改掉 finish: finish || (done ? 'stop' : null) 这一行的回退。
'''
T['perf-regression'] = '''
等待变长几乎全在解码：总等待 900 → 2400，涨 1500ms；contentSpanMs p50 280 → 1650，涨 1370ms，占九成；ttfbMs 610 → 640 只多 30ms。吞吐 390/280≈1.39 与 1720/1650≈1.04 chars/ms 同一量级，所以不是每个 token 变慢，是要生成的量变多了：outputChars 390 → 1720，约 4.4 倍。

config diff 里两处变化：maxOutputTokens 850 → 4096，compressTargetMax 450 → 1800。输出长度正好贴着 compressTargetMax 走：390≈450、1720≈1800，比例 4.4 对 4.0。README 也写了 compressTargetMax 只影响 v3 的长度目标，而这里走的正是 compress-v3h。maxOutputTokens 只是上限，不会让输出变长，除非升级前 850 一直在截断。promptVersion 升级前后都写着 compress-v3h:250-450，没跟着配置变，这个标签多半是硬编码的，不能拿它证明配置没生效。

所以我倾向主因是 compressTargetMax 450 → 1800，maxOutputTokens 是陪跑。

刚发出的调用是看升级前后的 finishReason 和 outputTokens。如果升级前是 stop（没碰到 850 上限），maxOutputTokens 就无罪，直接把 src/config.js 里 compressTargetMax: 1800 改回 450。如果升级前大量是 length，才说明 850 在截断，那就是 maxOutputTokens 放开导致变长，另行处理。
'''
build('A', T)
