import sys; sys.path.insert(0, '/home/user/oracle'); from mk import build
# oracle-I（2026-09-29，接手会话第 3 轮）：只写自动稿仍输的三题（wrong-model / perf / sse），检验理论 S8-R8/R9：
#   R8a 落点的逐字性是相对「文件」的（diff 的 + 号、grep 的行号前缀不是文件内容），出处链写成已完成的核对；
#   R8b READY 闭合 = (path, old_text, new_text) 三元组——改法不是换一个值时必须写出替换后的整行（wrong-model 的设计成本没被付掉 ⇒ 短思考后回头 read）；
#   R9  判读覆盖：分支 trigger 写成待回输出里会「字面出现」的特征，穷尽原文考虑过的假设，并点名「看到这个就够了，不用再查 X」。
# 纪律同 A/B/C：只看任务原文 + 原文思考（recordings.json），不看 effect-specs 的 followup / reference。
# 正文沿用 C 的原生语域与内容（C 已是形态上界），只改判读收尾。
T = {}
T['wrong-model'] = '''
我们需要找出为什么压缩用的是上一次会话的模型。先看代码，read_file src/host-follow.js 返回的原文（逐字）是：
`let lastModel = null`
`observe(options) { if (options && options.model) lastModel = options.model }`
`callConfig(options) { return { ...cfg, model: lastModel || cfg.model } }`
plugin.js 里是 `host.observe(options, n)`，然后 `const callCfg = host.callConfig(options)`，再把 callCfg 传给 birthTransform。

trace 显示 llm-stream n12、n13 都是 deepseek-v3.2，但中间的 compiler-transport-started 是 deepseek-v3.1，正好是上一次会话的模型。

看起来 lastModel 是模块级变量，跨会话保留。observe 只在 options.model 存在时更新，而 plugin 传了两个参数 (options, n)，observe 的签名只接受 options，第二参数 n 被忽略。如果当前会话的模型不在 options.model 上而在 n 上，lastModel 就一直是上一次会话的值，callConfig 再用 lastModel || cfg.model 把它覆盖进压缩配置——这就是 compiler-transport-started 显示旧模型的原因。调用顺序是先 observe 再 callConfig，顺序没问题；prewarm 用的是原始 cfg，解释不了「上一次会话的模型」，不是它。

所以下一步工具调用是 bash grep -n -C 10 "host.observe\\|callConfig" src/plugin.js，看 options 和 n 是怎么构造的、model 落在哪个字段。如果输出显示当前模型在 n 上（n 带 model 字段，或 options 里根本没有 model），那么根因坐实，看到这一点就够了，不用再展开 n 是怎么算出来的，也不用再读 host-follow.js：直接 edit_file src/host-follow.js，old_text 是 `observe(options) { if (options && options.model) lastModel = options.model }`（read_file 输出里原样复制的这一整行，不带行首缩进也能匹配），new_text 是 `observe(options, n) { const m = (n && n.model) || (options && options.model); if (m) lastModel = m }`——让 observe 读到 n 上的当前模型，options.model 仍作兜底，callConfig 和 plugin.js 一行都不用动。改 plugin.js 的调用点或改 callConfig 都不选：前者会丢掉 options，后者要改两处才能不依赖 lastModel。如果输出显示 options.model 就是当前模型，那么问题不在 observe 的参数，得查 observe 和 callConfig 之间还有谁改写了 lastModel，那时再取证。
'''
T['perf-regression'] = '''
我们需要分析为什么收网等待从 900ms 涨到 2400ms。总等待涨 1500ms；contentSpanMs p50 从 280 到 1650，涨 1370ms，占九成；ttfbMs 610 → 640 只多 30ms。吞吐 390/280≈1.39 和 1720/1650≈1.04 chars/ms 是同一量级，所以不是每个 token 变慢，而是生成的量变多了：outputChars 390 → 1720，约 4.4 倍。

config diff 有两处：maxOutputTokens 850 → 4096，compressTargetMax 450 → 1800。输出长度正好贴着 compressTargetMax：390≈450，1720≈1800，比例 4.4 对 4.0。README 说 compressTargetMax 只影响 v3 的长度目标，而这里走的正是 compress-v3h。maxOutputTokens 只是上限，不会让输出变长，除非升级前 850 一直在截断。promptVersion 升级前后都是 compress-v3h:250-450，没跟着配置变，看起来是硬编码的标签，不能用来证明配置没生效。所以主因更可能是 compressTargetMax 450 → 1800，maxOutputTokens 是陪跑。

所以下一步工具调用是 bash analyze-trace --compare v11.9 v11.10 --steps birth --fields finishReason,outputTokens,contentSpanMs，看升级前的生成是被 850 截断还是自然停下。如果升级前 finishReason 是 stop、outputTokens 明显低于 850，那么 850 从来没绑住，maxOutputTokens 无罪、不用回滚，主因就是 compressTargetMax 450 → 1800，看到这一行结果就直接 edit_file src/config.js：old_text 是 `compressTargetMax: 1800,`，new_text 是 `compressTargetMax: 450,`。注意 git diff 里显示的 `+  compressTargetMax: 1800,` 开头的加号是 diff 标记，文件里没有它，所以 old_text 不要带加号和行首缩进，只用 `compressTargetMax: 1800,` 这段就能匹配，不用先读 config.js 确认。如果升级前 finishReason 大量是 length、outputTokens 贴着 850，那么是 maxOutputTokens 放开解除了截断，主因在它，改回 850 或给 birth 单独设小值，compressTargetMax 不动。promptVersion 的 tag 不随配置变，顺手记一笔，不在这一步改。
'''
T['sse-truncated'] = '''
我们需要找出为什么截断的压缩结果被当成成功。trace 里 compiler-transport-settled 是 ok:true、finish:null、stream:true、outputChars:212、eventCount:9；birth-condensed 是 rawChars 8123 → outChars 212。只有 212 字、没有 finish_reason，却写进了会话。

assembleSseFrames 的关键两行（read_file src/transport.js 原文，逐字）：
`if (f === '[DONE]') { done = true; continue }`
`return { out, finish: finish || (done ? 'stop' : null) }`
finish 只在收到 finish_reason 时才赋值；没有 finish_reason 时，只要收到 [DONE] 就回退成 'stop'。网关文档说部分上游在连接被代理切断时只补发 data: [DONE]。所以被切断的流会拿到 stop，截断被当成正常结束——这就是 bug 本体：不管调用方怎么判 ok，都不该由 [DONE] 造出一个 stop。

有一点没对上：trace 里 finish 是 null，而按这段代码 done=true 时应返回 'stop'。可能 settle 记录的是上游原始的 finish_reason（那自然是 null），也可能 ok 的判定根本不看 finish。这只影响「要不要顺带改调用方」，不影响这一行必须改。调大 outputChars 阈值、改超时都是治症状，不选。

所以下一步工具调用是 bash grep -RIn --exclude-dir=node_modules -E "compiler-transport-settled|assembleSseFrames|birth-condensed" src，看调用方的 ok 是怎么算的。如果调用方的 ok 依赖 assembleSseFrames 返回的 finish（不管是 === 'stop' 还是 != null），那么只改这一处就够：edit_file src/transport.js，old_text 是 `return { out, finish: finish || (done ? 'stop' : null) }`（read_file 原文，逐字，不带行首缩进也能匹配），new_text 是 `return { out, finish: finish || null, done }`——没有真实 finish_reason 就不再冒充 stop，[DONE] 只作 done 标记；看到 grep 结果就改，不用再读 transport.js 的其它部分，trace 里 finish 是 null 而 ok 是 true 也不用再解释（settle 记的多半是原始值）。如果调用方的 ok 完全不看 finish、只看 out 非空或流正常结束，那么除了这一行，还要把调用方的 ok 改成要求 finish === 'stop'，那一处的落点等 grep 出来再定。
'''
build('I', T)
