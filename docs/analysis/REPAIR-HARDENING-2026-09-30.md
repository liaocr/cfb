# 修复控制链增量优化（2026-09-30，零 API）

## 实现前固定范围

基线：`564de03`，763/0/1，25套件，manifest291，N1–N7全零。用户继续授权完善优化；仍不允许模型/评委/API费用、生产自动接管、重用已消费盲测。完整外部 DSH/Cordis 依赖缺失不再重复探测。

归因是实现层，不是重新调整理论/目标：
1. runtime只有内部计时器，host/episode没有外部AbortSignal通道，搜索取消不能及时到工作负载。
2. episode的终止分支仍执行诊断；任何unknown已经禁止路由，却继续探测，浪费检查。
3. 诊断固定顺序保留调用方数组引用；认证回调目前按truthy接受，而契约要求同步boolean。

改动限定生产原生SDK与其离线回归，不改变旧提示词/正文/chunks/验收判据/编辑权限：
- 可选signal贯穿episode→host→runtime→verifier/观察器/子进程；预取消不消耗轮次/修复/检查。执行中取消关闭新动作与诊断，等待显式managed文件+JSON恢复/清理；不声称撤销网络/计时器副作用，不承诺抢占忽略signal的回调或同步IO。
- 可选冻结`diagnosticMode:'before-retry'`：无下一次批准修复机会时不诊断，unknown首个即停。默认仍为原every-failure行为，旧冻结policy摘要不变。
- 复制固定诊断顺序，认证必须同步true，拒绝truthy或异步结果，不改HMAC/角色绑定。

验收预测（尚未实测）：
- 预取消预算0，检查中/动作后取消恢复完成且不授迟到绿灯，无第二分支；监听器finally清理。
- 固定开发回归仅使用`plain-json`/`chunked-json`6个已知开发任务，不做选择/盲测/入库：active-only完成仍4/6，诊断预计8→6；static-safe完成仍4/6，诊断预计12→8；active-routing完成仍6/6、诊断6→6。省的是无用末轮诊断，不宣称完成或模型增益。
- 缺失诊断同类回归预计2次unknown→1次、后验不更新、仍不路由。
- 验收前先跑267稿audit，新增取消/负例自测，然后manifest、全量真断网verify/audit、旧回放；N1–N7全零，小中文提交及普通推送固定分支。

原18任务报告/留出与消费日志保留历史；源码变化后旧报告拒绝重搜，不删库、不换cycle。原始新工程回归输出只写ignored运行目录。实际结果完成后追加。


## 实测结果（完成后追加）

| 已知开发回归策略 | 完成（默认→可选模式） | 诊断（默认→可选模式） | 前置/验收（各模式） |
|---|---|---|---|
| static-safe | 4/6→4/6 | 12→8（−33.3%） | 各10次，未减少 |
| active-only | 4/6→4/6 | 8→6（−25%） | 各10次，未减少 |
| active-routing | 6/6→6/6 | 6→6 | 各10次，未减少 |

- 缺失诊断控制：unknown2→1，后验未因缺失更新，仍拒绝路由/第二次修复；预取消0轮/0检查/0子进程。减少的是无重试机会的末轮诊断和已否决后的探测，不是弱化前置或验收，不承诺完成率进一步提升。
- 36配对开发episode +2个unknown控制 +1个预取消 =39。真实工作负载/独立oracle/loopback HTTP各108；合法发布/落地/恢复/双观察器全部一致。未执行selection/test，未写技能库；旧18盲测记录/消费日志完全保留。新产物仅ignored `.cfb-runtime/repair-iterations/control-regression.json`。
- 新13自测：runtime预取消/非法信号/前置取消/真实Node进程终止/忽略信号的迟到pass/同步动作后取消/episode贯穿与无第二分支/存档故障收口/默认policy旧摘要/末轮跳过；固定顺序快照、严格同步true认证、unknown首个停止。专项59/0/0。
- 取消信号贯穿episode→host→runtime→verifier/observer；Node子进程实测退出、文件+JSON恢复、监听器清理。同步动作取消仍保留已落地动作回执，不把未验收动作当成不存在。存档异常返回host-unavailable，不复制异常故事；取消/未知或缺目标回执输出不伪造已知false。
- 默认mode与冻结policy摘要保持旧格式；只有显式`diagnosticMode:'before-retry'`才跳末轮/首个unknown停止。默认模型可见稿/chunks/提示词与判据、权限、3轮/2修复均不变。
- 全量真断网 **776通过/0失败/1原依赖跳过、26/26套件、16.9秒**；manifest **294** 无漂移/新增/缺失，diff-check通过；267稿N1–N7全零，旧编译回放逐字33/33。DT仅Node语法检查，不是tsc语义验收。
- 模型/评委/外部API **0**，费用 **0**，未读取密钥。P1/独立泛化/完整外部DSH与生产接管仍未证明；付费调用仍需另批。上述结果符合预注册，下一步完成率收益仍须新未消费任务或另批模型验证，不能把旧开发回归当新留出。

## 使用与回退

- 新工程回归：`npm run evidence:repair:regression`，经only-loopback网络命名空间，隔离失败即停。
- 调度：冻结policy时显式设`diagnosticMode:'before-retry'`；调用`controller.run({signal})`。底层支持`host.runLatest(index,{signal})`/`runtime.runRound(program,{signal})`。未传signal保留内部截止；未选新诊断模式完全保留原策略。
- 预取消不消耗episode启动/轮次/检查，允许宿主随后明确重新调用；执行中取消消耗已经发生的动作预算，不撤已发生网络副作用。仅恢复显式managed文件/JSON到最近通过峰值；忽略信号的观察可返回但迟到结果丢弃，同步I/O无法抢占，清理/持久化耗时不承诺即时中止。
- 原18任务报告为旧源码历史证据，当前`evidence:repair:iterations`会因源码指纹变化拒绝重搜。不要删除库/换cycle/复制旧族规避；本次只用train固定工程回归，不扩新搜索框架。
