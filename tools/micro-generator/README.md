# Family-isolated generative compression pipeline

This folder contains corpus preparation, review contracts, evaluation, local inference runners, and a fail-closed Kaggle QLoRA template for `raw + ctx -> draft`.

## Review policy: one AI reviewer

The project policy is **AI single reviewer**. The authorized reviewer identity is `arena-agent-mode` (Arena.ai Agent Mode session identity; not a human identity and not a claim about the underlying model name). A complete annotation records:

```json
{
  "mode": "ai-single-reviewer",
  "reviewerType": "ai",
  "reviewerId": "arena-agent-mode",
  "reviewerCount": 1,
  "humanReviewerCount": 0,
  "independentSecondReview": false
}
```

There is no second-reviewer requirement. Do not describe an AI-only review as human-reviewed or independently adjudicated. The schema, exporter, prediction validator, evaluator, workbook, and trainer preflight all preserve this distinction. A single reviewer does **not** waive complete source-fact coverage, exact evidence spans, unsupported-claim review, family isolation, or provenance.

## Safety rules

- A clean apparatus audit, accepted capture, lexical anchor, or hand-written draft is **not** proof of complete factual coverage.
- A row enters train/dev only after full raw/context review, complete atomic source facts, exact source spans, and a reference whose must-preserve facts are all retained and whose factual claims have zero unsupported assertions.
- Split by whole family. A family may appear in exactly one of `train`, `dev`, or `blind`; never random-split rows from a family or move previously used development/holdout material into train.
- Existing holdout families are not a newly registered blind family. Blind examples must come from genuinely new families, be registered before generation, and remain private until predictions are frozen.
- Blind annotations are never written into the Kaggle upload directory; an optional `--private-out` path must be outside it.
- When the intended target is model-specific (here, DeepSeek-V4.1-Flash), traces from another teacher model are not target-model supervision. They may be used only as exploratory, model-agnostic material unless transfer is demonstrated on a held-out set of target-model traces generated with the intended harness and output channel.
- The evaluator consumes explicit reviewer labels. It does not infer semantic equivalence from string overlap. Its scores must be described as **AI single-reviewer** scores, not independent or human scores.
- Gate thresholds start null and unfrozen. No checkpoint can be called passing until thresholds, blind-family registration, and annotation completeness are frozen before the blind run.
- Character ratio uses `draft.length / raw.length` only. `ctx` is task context, not source text for the compression denominator. This is a character proxy, not tokenizer-token compression.

## Current commands

From the repository root:

```sh
node tools/micro-generator/prepare-review-queue.mjs --write
node tools/micro-generator/build-fact-draft-suggestions.mjs --write
python3 tools/micro-generator/build-ai-review-workbook.py
node tools/micro-generator/export-reviewed-corpus.mjs --queue transfer/models/micro-generator-review-queue.jsonl --out-dir transfer/models/micro-generator-corpus
node tools/micro-generator/evaluate.mjs --cases path/to/ai-reviewed-cases.jsonl --predictions path/to/ai-reviewed-predictions.jsonl --gates path/to/frozen-gates.json --out path/to/report.json
node tools/micro-generator/select-smallest-passing.mjs --report path/to/report-q8.json --report path/to/report-q4.json --out path/to/selection.json
python3 tools/micro-generator/run_gguf.py --model /safe/path/model.gguf --input transfer/models/micro-generator-review-queue.jsonl --out /tmp/dev-pending-review.jsonl --revision "$MODEL_COMMIT_SHA" --quantization Q8_0 --split dev
node tools/micro-generator/freeze-gates.mjs --in tools/micro-generator/evaluation-gates.template.json --out path/to/frozen-gates.json --blind-family BRAND_NEW_FAMILY --min-blind-families N --min-cases-per-blind-family N --weighted-fact-recall-overall-min X --weighted-fact-recall-per-blind-family-min X --critical-omissions-per-blind-family-max N --uncertain-must-preserve-per-blind-family-max N --contradictory-claims-per-blind-family-max N --unsupported-claims-per100-max X --uncertain-claims-per100-max X --median-draft-to-raw-char-ratio-max X --confirm-before-blind-generation
node --test test/micro-generator.selftest.mjs
```

The exporter refuses train/dev output until the included rows pass the complete AI single-review contract, every queued case has an explicit family-level split, at least two train families and one dev family are represented, and duplicate `raw+ctx` inputs do not have conflicting targets. It reports the reviewer policy in its manifest. The training preflight repeats those checks independently.

`build-fact-draft-suggestions.mjs` is still only a reviewer aid: it proposes facts from explicit task/context preamble snippets, so those 17 records remain `sourceCoverage=partial`, `annotationStatus=draft`, and `trainingEligible=false`. Its suggestions are not gold labels. The Excel workbook is an optional review surface, not an import source or training artifact; it does not create a second-review requirement.

## External data sourcing decision

- **QMSum**: train/validation portions were downloaded from a fixed repository commit for screening, including meeting transcripts, query summaries, and relevant-turn spans. It is a query-based meeting-summary dataset, not CFB coding-agent progress-state data. Sampled answer/span pairs need additional claim-level verification, so it is not admitted to the CFB training corpus. No test split is used.
- **etri/QMSum_SummaryEvidence**: a pinned MIT-licensed variant supplies sentence-level CES/PES evidence labels, but its checked JSON stores target-conditioned evidence snippets rather than the full transcript. It is a useful auxiliary audit candidate, not full-raw CFB data; not imported.
- **SWE-agent-trajectories**: coding-agent trajectories are a closer domain match, but they provide trajectories and patches/evaluation logs rather than ready-made `raw + ctx -> draft` summaries. Use would require source-family and repository-license review plus AI-authored target creation; it was not imported.
- **SWE-chat**: it contains real coding-agent sessions, but access to its files requires accepting a contact-information condition. It was not accessed or used.

Acquisition and rejection reasons are recorded in `docs/MICRO-GENERATOR-DATA-SOURCING-2026-10-07.md`. Do not treat auxiliary meeting summaries, generated targets, or trajectory text as CFB gold without a complete review.

## Local inference and training

`run_gguf.py` needs `llama-cpp-python` and a local GGUF file; both inference runners require a pinned lowercase 40-hex model commit. They are inference-only smoke runners; they do not train or certify quality. They record weight and prompt hashes, runtime settings, per-case latency, and a pending review with no reviewer identity until a review is actually performed. CPU throughput/fit is not verified in this 2-vCPU / ~1.9-GiB environment.

**Security stop:** the Qwen3-0.6B-GGUF repository's Q8_0 artifact had a `PAIT-GGUF-100` scan warning during the earlier check. That file was not downloaded or loaded. Do not bypass the warning; inspect the exact embedded template/artifact with safe tooling first. Runner tests use a mock backend only.

`kaggle_qwen3_qlora.ipynb` is a GPU-side template, not evidence of training. It fails closed on incomplete AI single-reviewer records, missing facts, duplicate targets, or family leakage. It uses only train/dev artifacts; a genuinely blind set stays private and outside Kaggle. Eval loss is an optimization diagnostic, not factual-quality evidence.

## Current readiness

The designated CFB target is DeepSeek-V4.1-Flash. A public-source survey (`docs/MICRO-GENERATOR-TARGET-MODEL-SOURCE-SURVEY-2026-10-07.md`) found no public corpus of that model's reasoning traces: the only confirmed archive of real V4.1-Flash rollouts is unlicensed for reuse, held out from a benchmark, and stores reasoning as encrypted/empty text, while the nearest licensed auxiliary (Open-SWE-Traces v1.1 `openhands/deepseek_v4_flash`, 21,208 rows with full reasoning) was generated by the predecessor DeepSeek-V4-Flash. Genuine target-model traces require running the target model itself; see `targetModel` in `dataset-policy.json`.

The 17 CFB queue rows are from already-known development families. Several original drafts make unsupported claims that edits or verification happened; two `perf-regression` rows have identical `raw+ctx` but different targets. Those originals are not accepted as training gold. Six rows from pinned NVIDIA Open-SWE-Traces v1.2 have been curated, source-hash checked, and reviewed by one AI reviewer, but their traces were generated by Qwen3.8-27B with mini-swe-agent—not the target DeepSeek-V4.1-Flash. They are retained only for annotation-pipeline exploration: `finalSplit=null`, `trainingEligible=false`, and no target-model transfer has been demonstrated. No target-model traces have been admitted, no train/dev split is registered for them, and no new-family blind set exists. The exporter and trainer are **review/preflight only**; fine-tuning was not run.
