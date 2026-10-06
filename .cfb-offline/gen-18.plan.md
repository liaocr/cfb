# 生成计划 g18：compile mint env-pin-drift side（已冻结，未发任何请求）

- 请求：4（主 1 + 探针 3）；scope `cfb.generation.2026-10-02.g18`；上限 USD 0.3 / 8 请求
- 预占：USD 0.1786；预计实付：USD 0.1001

```
# 批准范围：scope cfb.generation.2026-10-02.g18，≤ 4 请求，预占 ≤ USD 0.1786，计划摘要 be875249ad36fb18
node tools/effect-ready.mjs doctor --gen --round 18
node tools/effect-ready.mjs run --live --gen --round 18
node tools/cfb-cycle.mjs ingest-gen --gen 18
```
