# 压缩器基准计划 b16（digest 7ec40be432dbba2c，未发请求）

目的：模式 2：压缩器（生产 birthOffline 同构体，关思考、temperature 0）在金标原文上出稿，与手写金标按 dd/2 比对；量的是 g(稿 | 策略, 原文) 到手写标准的召回，不量结局

策略：base vs p-56e56fcd9c；金标 2 项（dev；sse-truncated）；指标 dd/2（冻结）
请求：压缩调用 4（主模型 0 次）；**期望实付 ≈ $0.03，上界 ≈ $0.046**

选择规则：dev 项：每个金标上候选 vs base 按层级键配对 → e 值（≥2 家族、e ≥ 阈 ⇒ promote）；holdout 项只报告，不参与选择；promote 的策略进 plan-traj（模式 3）验收，基准分本身不采纳 champion

先零 API 核对（金标摘要 / 两条基线）：
```
node tools/bench-run.mjs --plan .cfb-runtime/bench/b16/plan.json --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/bench/b16 --dry-run
```
批准后执行：
```
node tools/bench-run.mjs --plan .cfb-runtime/bench/b16/plan.json --base-url <url> --model deepseek-v4.1-flash --out .cfb-runtime/bench/b16
```

回看：node tools/cfb-cycle.mjs bench-report --plan 16
