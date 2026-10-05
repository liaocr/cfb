# Quarantined Mode 1 gold

These immutable source copies are not active gold and must not enter training, evaluation, flywheel promotion, or candidate examples.
The machine-readable audit manifest is `audit.json`; it records source hashes, original paths, the user-directed sole approval, and static detector findings.
Static checks inspect only `draft` and `stored` target text. A clean regex result does not override the manual audit.
