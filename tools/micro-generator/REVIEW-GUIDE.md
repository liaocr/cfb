# AI single-reviewer guide for micro-generator facts

This is the review contract for the authorized **AI single reviewer** (`arena-agent-mode`). It does not require a second reviewer. It is not an automated gold-labeling tool. Every completed annotation must record `reviewProvenance` with `reviewerType=ai`, `reviewerCount=1`, `humanReviewerCount=0`, and `independentSecondReview=false`; never describe this process as human or independent review. Keep each source example within one family split.

## Source facts

1. Read the entire `raw` and `ctx` before annotating. Mark whether source-fact coverage is complete, partial, or still unreviewed.
2. Split content into atomic, independently checkable propositions. Record the exact source span in `raw` or `ctx`; offsets are JavaScript UTF-16 code-unit offsets and must reproduce `quote` exactly.
3. Record polarity, modality, conditions, entities, and material numbers/thresholds. Keep exception and negated propositions separate when dropping one could change behavior.
4. Set `mustPreserve=true` only when omission could change the task, decision, causal explanation, safety, verification, or required output. Importance is `critical/high/medium/low`; do not infer importance from lexical cues alone.
5. `sourceCoverage=complete` means all task-relevant facts, including constraints and unresolved items, have been considered. It is not merely “I found several facts.”
6. Distinguish user-reported claims, tool observations, assistant hypotheses, proposals, and completed actions. A proposed edit is not an edit receipt; a planned test is not a test result; a historical output is not a fresh post-change observation.

## Reference draft review

For every must-preserve fact, mark the reference as preserved, omitted, contradicted, or uncertain. Review all draft claims for support in raw/context and record unsupported assertions separately. A clean apparatus audit, prior success label, hand-written target, or exact anchor overlap does not substitute for this review. A reference that claims a code change or validation happened must be supported by an actual action/output in the source record; otherwise reject or rewrite it.

## Model output review

Review every must-preserve fact and every factual claim in the generated draft. `factCoverage=complete` and `claimCoverage=complete` mean no relevant fact/claim was skipped. Use `uncertain` rather than guessing. A supported claim should identify one or more source fact ids where possible. Record that the labels are from a single AI reviewer; do not imply independent confirmation.

## Blind evaluation

Do not show model outputs or compare checkpoints while selecting/annotating the blind facts. Register new blind families and freeze thresholds before generation. Keep blind gold annotations in a private artifact; upload only train/dev material to Kaggle. Freeze prediction hashes before unsealing the blind labels.
