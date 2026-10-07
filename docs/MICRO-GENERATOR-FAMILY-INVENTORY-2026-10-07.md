# Micro-generator source-family inventory — 2026-10-07

## Scope and method

A read-only inventory scan was run across structured records under `transfer/`, including JSON/JSONL records with `raw + ctx + draft` or `raw + ctx + referenceDraft`, existing gold/rejected/repair records, trajectory outputs, live compression logs, micro blind fixtures, and probe corpora. Input pairs were hashed to detect duplicates. This is a workspace-availability scan; it does not certify the semantic quality of any reference. No model API or training run was used.

## Sources already in the micro-generator queue

| Source | Records | Input pairs | Families | Split / status |
|---|---:|---:|---|---|
| `transfer/models/micro-generator-review-queue.jsonl` | 17 | 16 | `flaky-timeout`, `perf-regression`, `sse-truncated` | All are already-known development families; original drafts were rejected or require rewrite. One `perf-regression` input has two different original targets. |
| `transfer/models/micro-dev-dataset.json#handSamples` | 32 total hand samples | 20 | Same three development families | 18 eligible capture rows yield 15 distinct input-target triples and 14 input pairs. These are development captures, not train families; apparatus/quality audits do not establish semantic gold. |
| `transfer/gold/` | 13 | 13 | `eacces-config`, `perf-regression`, `sse-truncated`, `wrong-model` | 6 development and 7 holdout entries. All families are already known; holdout families remain excluded from train. |
| `transfer/gold-rejected/` | 11 | 11 | `eacces-config`, `flaky-timeout`, `perf-regression`, `sse-truncated`, `wrong-model` | Previously rejected/known-family material, not new independent families. |

The current micro-generator exporter still reports `train=0`, `dev=0`, `blindPrivate=0`, `excluded=17` for the original queue. A separate conservative rewrite artifact now contains 16 unique-input candidates, one per raw+ctx pair; an export check reports `train=0`, `dev=0`, and all 16 excluded because coverage is partial and `trainingEligible=false`. Neither exporter promotes proposals or capture records automatically.

## Other local candidate material

- `transfer/traj1/`, `traj2/`, and `traj3/` contain 29 experimental agent runs across `eacces-config`, `flaky-timeout`, and `perf-regression`. The artifacts are raw/ledger/auto trajectories and final-patch outcomes, not reviewed `raw + ctx -> draft` targets. They repeat known families.
- `transfer/live-direct/report.json` contains six compression runs: five known tasks plus `session-mixup`. `session-mixup` is a single `below-floor` input whose output was unchanged; it has no accepted reference summary, no independent source family set, and is not enough to create the required train split. It is a development-only candidate for future target annotation, not training data.
- `transfer/models/micro-blindtest-encoding-mojibake-v1.json` and `micro-blindtest-lock-contention-v1.json` are explicitly `finalBlind=true` unit-label fixtures. They have no full-summary `raw + ctx -> draft` targets. Keep them blind; do not relabel them as train.
- `transfer/probes-2026-10-07/corpus/` is math-CoT and multihop-QA material, not coding-agent progress-summary data.
- Gold-repair, direct-run, and effect-study artifacts found in the scan are historical/experimental outputs tied to the same known families or have no reviewed summary target; none supplies a clean new train family.

## Source-search decision

No already-present local source provides the minimum `raw + ctx -> draft` training set from at least two genuinely new families. The only new local family-like item (`session-mixup`) has no reviewed target and is a single below-floor model input. Two other new family names occur only in an existing blind **unit-label** benchmark, not this summary task.

External-source screening is documented in `docs/MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md`. QMSum and its evidence-only variant were not admitted. AutoCompact is a close task match but its dataset is still an upcoming release with usage terms pending. Six Open-SWE-Traces rows are now pinned, hash-checked, curated, and AI-single-reviewed; their six repository families are distinct from the existing CFB families, but all traces are Qwen3.8-27B/mini-swe-agent rather than the target DeepSeek-V4.1-Flash. They are exploratory only (`finalSplit=null`, `trainingEligible=false`) and are not counted as target-compatible train/dev families. A bounded benchmark-overlap and repository-license review is recorded in `docs/MICRO-GENERATOR-OPEN-SWE-SEED-2026-10-07.md`. SWE-MIMIC-Bench is excluded under CC BY-NC-ND 4.0; SWE-chat remains gated. No target-model-compatible external rows have been admitted. Any future AI-authored targets must be checked against the actual trajectory and repository-specific license and kept distinct from independent human gold claims.

## Decision

Keep the three existing development families in development; keep `eacces-config` and `wrong-model` holdouts out of train; keep existing blind fixtures blind. Do not manufacture training readiness from old runs, previous model outputs, or task-name novelty. Until new-family trajectory data is properly screened and annotated, `fineTuneNow=false` remains the correct result.
