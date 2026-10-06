# 生成计划 g13：mint-b env-pin-drift（已冻结，未发任何请求）

- 请求：4（主 1 + 探针 3）；scope `cfb.generation.2026-10-02.g13`；上限 USD 0.3 / 8 请求
- 预占：USD 0.1473；预计实付：USD 0.092

```
# 批准范围：scope cfb.generation.2026-10-02.g13，≤ 4 请求，预占 ≤ USD 0.1473，计划摘要 badc7a9950cb46fa
node tools/effect-ready.mjs doctor --gen --round 13
node tools/effect-ready.mjs run --live --gen --round 13
node tools/cfb-cycle.mjs ingest-gen --gen 13
```
