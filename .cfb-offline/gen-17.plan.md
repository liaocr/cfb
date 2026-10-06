# 生成计划 g17：compile mint env-pin-drift r1（已冻结，未发任何请求）

- 请求：4（主 1 + 探针 3）；scope `cfb.generation.2026-10-02.g17`；上限 USD 0.3 / 8 请求
- 预占：USD 0.1532；预计实付：USD 0.0935

```
# 批准范围：scope cfb.generation.2026-10-02.g17，≤ 4 请求，预占 ≤ USD 0.1532，计划摘要 6fa35dd26b44885d
node tools/effect-ready.mjs doctor --gen --round 17
node tools/effect-ready.mjs run --live --gen --round 17
node tools/cfb-cycle.mjs ingest-gen --gen 17
```
