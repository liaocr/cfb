# AI single-reviewer guide for birth-time compression

Authorized **AI single reviewer**: `arena-agent-mode`. No second-reviewer requirement. Every annotation records reviewerType=ai, reviewerCount=1, humanReviewerCount=0, independentSecondReview=false. Do not call this human review, independent adjudication, semantic gold certification or target-reader validation. Entire families stay within one split; exposed families never become train by relabelling.

## Read and annotate the entire retained source

1. Read complete `raw` and compressor-visible birth `ctx`; do not replace them with a task preamble or later context. State that retained text need not be the entire original session. Record ctx assembly/truncation and distinguish later acceptance ctx.
2. Split into atomic propositions, with precise `raw`/`ctx` quote spans using **JavaScript UTF-16 code-unit offsets**, not Python character counts. Include polarity, actors, material numbers, identifiers, temporal relations, modality, conditions and exceptions.
3. `mustPreserve=true` means omitting it can change the continuation's task/decision/constraints/causal evidence/safety/verification; classify critical/high/medium/low without treating anchor matches as semantic proof.
4. Distinguish reported historical observations, guesses, contradicted hypotheses, proposed changes, attempted actions and completed actions. Planned tests are not passing tests; historical output is not a post-change result. An uncertain source cannot become a confident conclusion in the reference.
5. `sourceCoverage=complete` means every relevant fact in the retained input was considered. Attach a `cfb.compression-review/1` sidecar with `sourceUnits.raw` and `.ctx` covering **every non-whitespace code unit** without gaps/overlap. Material units cite fact IDs; procedural/redundant/nonmaterial units explain their treatment. This prevents partial preamble review masquerading as complete.
6. Context provided unchanged to the receiver may remain in that prefix rather than be needlessly duplicated into the draft; the review still records its source facts. Never assume an unavailable prefix/tool state will be restored for free.

## Reference/output claims

For every must-preserve fact, adjudicate preserved/omitted/contradicted/uncertain. The complete `draftClaims` list covers every non-whitespace output unit with exact UTF-16 spans. Supported claims cite actual fact IDs; structural-only units explain their role. Count all unsupported/contradicted/uncertain claims, not just cherry-picked ones. Every new assertion of edits/tests/completion needs an actual source receipt, not an apparatus label. Rewrite or reject overclaiming drafts.

Bindings include raw/ctx/reference/input and full annotation-record hashes, reviewer provenance, source units and draft claim units. `validateCompleteReview` and the Python preflight independently recheck attachments. Hash/full-coverage checks do not prove the reviewer classified every sentence correctly or that the source world facts are true; labels remain single AI judgments.

Review model outputs separately: no copying reference labels as if a model was run. Exact same-source/family duplicate artifacts do not add independent n. Preserve all failures, refusals, out-of-window cases and fallback in the registered reader denominator.

## Development controls and reader utility

Equivalent good drafts, polished bad drafts and minimal actor/number/time/negation/condition counterfactuals test the apparatus. Current 30 labelled controls are synthetic/exposed, not blind/gold/training or an automatic semantics oracle. Original-reader value requires raw/raw A/A and raw/reference from the **same birth/environment state**, version/channel/tools/settings bindings, complete outcomes and cumulative usage/economics. Hashes, 400 syntax, fingerprint and token accounting are not semantic-use evidence.

## Admission and blind

Complete AI review alone cannot admit training. Source/model compatibility/license/privacy/birth boundary, whole-family/prior exposure, new preregistered valid ruler, real reader utility, real CPU capability and confirmed resource budget are required by `formal-sft.mjs`; old declaration-only admission is rejected by `train_rwkv7.py`.

No newly authorized blind has been run. Do not view predictions while choosing/annotating blind facts; register genuinely new private families and freeze thresholds before generation, freeze prediction hashes before unsealing labels. Old consumed v9 ledger stays closed; private blind labels never enter an uploaded train/dev bundle. Numerical thresholds remain unfrozen in the current development protocol.
