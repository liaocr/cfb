# 生成计划 g6：compile p-56e56fcd9c（已冻结，未发任何请求）

- 请求：6（主 3 + 探针 3）；scope `cfb.generation.2026-10-02.g6`；上限 USD 0.3 / 8 请求
- 预占：USD 0.2491；预计实付：USD 0.1566

```
# 批准范围：scope cfb.generation.2026-10-02.g6，≤ 6 请求，预占 ≤ USD 0.2491，计划摘要 f73b6a24f47eeb15
node tools/effect-ready.mjs doctor --gen --round 6
node tools/effect-ready.mjs run --live --gen --round 6
node tools/cfb-cycle.mjs ingest-gen --gen 6
```
