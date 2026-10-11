# Quarantined Mode 1 gold

These immutable source copies are not active gold and must not enter training, evaluation, flywheel promotion, or candidate examples.
The machine-readable audit manifest is `audit.json`; it records source hashes, original paths, the user-directed sole approval, and static detector findings.
Static checks inspect only `draft` and `stored` target text. A clean regex result does not override the manual audit.

Quarantine is a ledger, not a trash can. Re-audit with `node tools/cfb-gold-repair.mjs audit` under the v14.20.1 scope (author claims only; verbatim quotations of `raw`/`ctx` are exempt): entries whose draft was always clean go back byte-for-byte via `restore --id … --apply` (their digests stay valid, so frozen bench plans keep working), and entries with real apparatus sentences get revised and re-measured offline via `replay`/`stage` before a Mode 1 re-run re-earns `outcome`.
`audit-amendments.json` records this re-audit: the restored items (with digests), the staged revisions awaiting re-test, and two ledger discrepancies found while re-scanning (a quarantine file with no matching action, and 11 files against 10 quarantine actions).
