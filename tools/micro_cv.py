"""Torch-free CFB-Micro family-CV summaries and fail-closed lineage checks.

The v2 cut-offs were selected after the 2026-10-04 three-fold results were observed.
They are therefore descriptive/exploratory only. A positive v2 summary is not a
confirmatory result and cannot authorize promotion without a new prospective lock.
"""

import math

SCHEMA = "cfb.micro-cv/2"

DEFAULTS = {
    "matchedProductionMargin": 0.20,
    "matchedMeanFloor": 0.75,
    "matchedWorstFloor": 0.70,
    "noRegressionTolerance": 0.03,
    "draftAggregateFloor": 0.85,
    "requiredFoldCount": 3,
}


def _num(value):
    """Return a finite numeric value; bool is deliberately not accepted as a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _count(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def matched_of(unit_block):
    """Extract the length-matched bucket and reject empty/internally invalid counts."""
    matched = ((unit_block or {}).get("lengthStratified") or {}).get("matched") or {}
    correct = _count(matched.get("correct"))
    total = _count(matched.get("total"))
    accuracy = _num(matched.get("accuracy"))
    if total == 0 or correct > total or accuracy is None or not 0.0 <= accuracy <= 1.0:
        accuracy = None
    return {
        "accuracy": accuracy,
        "correct": correct,
        "total": total,
        "wilsonLower95": _num(matched.get("wilsonLower95")),
    }


def fold_metrics_from_report(report):
    """Compress one historical report into the candidate/production fold readings."""
    report = report or {}
    ruler = report.get("rulerReading") or {}
    cand_unit = ruler.get("candidateUnitValidation") or {}
    prod_unit = ruler.get("productionUnitValidation") or {}
    cand_draft = ruler.get("candidateDraftValidation") or {}
    prod_draft = ruler.get("productionDraftValidation") or {}
    return {
        "candidate": {
            "matched": matched_of(cand_unit),
            "accuracy": _num(cand_unit.get("accuracy")),
            "total": _count(cand_unit.get("total")),
            "wilsonLower95": _num(cand_unit.get("wilsonLower95")),
            "draftAccuracy": _num(cand_draft.get("accuracy")),
            "draftCorrect": _count(cand_draft.get("correct")),
            "draftTotal": _count(cand_draft.get("total")),
        },
        "production": {
            "matched": matched_of(prod_unit),
            "accuracy": _num(prod_unit.get("accuracy")),
            "total": _count(prod_unit.get("total")),
            "wilsonLower95": _num(prod_unit.get("wilsonLower95")),
            "draftAccuracy": _num(prod_draft.get("accuracy")),
            "draftCorrect": _count(prod_draft.get("correct")),
            "draftTotal": _count(prod_draft.get("total")),
        },
    }


def fold_report_compatibility(
    report,
    family,
    *,
    training_data_fingerprint,
    preregistration_sha256,
    source_sha256,
    expected_families=None,
):
    """Require identical training data, preregistration and measurement code across folds.

    Old reports intentionally fail this check: they predate the stable training-data
    fingerprint and the v2 lineage lock, so their metrics cannot be silently pooled with
    a freshly trained fold.
    """
    reasons = []
    if not isinstance(report, dict) or report.get("schema") != "cfb.micro-97m-training-report/3":
        reasons.append("unsupported-or-missing-report-schema")
        return {"compatible": False, "reasons": reasons}

    dataset = report.get("dataset") or {}
    freeze = dataset.get("finalEvaluationFreeze") or {}
    found_fingerprint = (dataset.get("trainingDataFingerprint")
                         or dataset.get("trainingDatasetSha256")
                         or freeze.get("trainingDataFingerprint")
                         or freeze.get("trainingDatasetSha256"))
    if found_fingerprint != training_data_fingerprint:
        reasons.append("training-data-fingerprint-mismatch-or-missing")
    if report.get("preregistration", {}).get("sha256") != preregistration_sha256:
        reasons.append("preregistration-sha256-mismatch-or-missing")
    if freeze.get("sourceSha256") != source_sha256:
        reasons.append("measurement-source-sha256-mismatch-or-missing")

    report_family = (
        freeze.get("validationFamily")
        or dataset.get("validationFamily")
        or (report.get("training") or {}).get("validationFamily")
    )
    if report_family != family:
        reasons.append("validation-family-does-not-match-report-name")

    if expected_families is not None:
        found = dataset.get("familyNames")
        if not isinstance(found, list) or sorted(found) != sorted(expected_families):
            reasons.append("development-family-set-mismatch-or-missing")

    metrics = fold_metrics_from_report(report)
    candidate = metrics["candidate"]
    production = metrics["production"]
    if candidate["matched"]["accuracy"] is None or production["matched"]["accuracy"] is None:
        reasons.append("matched-bucket-missing-or-invalid")
    if candidate["draftAccuracy"] is None or candidate["draftTotal"] <= 0:
        reasons.append("candidate-draft-metric-missing-or-invalid")
    if production["draftAccuracy"] is None or production["draftTotal"] <= 0:
        reasons.append("production-draft-metric-missing-or-invalid")

    return {"compatible": not reasons, "reasons": reasons}


def baseline_report_compatibility(
    baseline,
    *,
    training_data_fingerprint,
    preregistration_sha256,
    source_sha256,
    expected_families,
):
    """Require the baseline to be frozen against the exact data, code, preregistration and family set."""
    reasons = []
    if not isinstance(baseline, dict) or baseline.get("schema") != "cfb.micro-cv-baseline/2":
        reasons.append("baseline-schema-missing-or-legacy")
        return {"compatible": False, "reasons": reasons}
    if baseline.get("trainingDataFingerprint") != training_data_fingerprint:
        reasons.append("baseline-training-data-fingerprint-mismatch-or-missing")
    if baseline.get("preregistrationSha256") != preregistration_sha256:
        reasons.append("baseline-preregistration-sha256-mismatch-or-missing")
    if baseline.get("sourceSha256") != source_sha256:
        reasons.append("baseline-source-sha256-mismatch-or-missing")
    found_families = baseline.get("families")
    if not isinstance(found_families, list) or sorted(found_families) != sorted(expected_families):
        reasons.append("baseline-family-set-mismatch-or-missing")
    matched = baseline.get("matched")
    if not isinstance(matched, dict) or any(_num(matched.get(f)) is None or not 0 <= _num(matched.get(f)) <= 1 for f in expected_families):
        reasons.append("baseline-matched-values-missing-or-invalid")
    return {"compatible": not reasons, "reasons": reasons}


def _mean(values):
    usable = [v for v in values if v is not None]
    return sum(usable) / len(usable) if usable else None


def summarize(
    families,
    per_fold,
    baseline=None,
    thresholds=None,
    *,
    confirmatory_eligible=False,
    confirmatory_reason=None,
    baseline_status=None,
    fold_compatibility=None,
    expected_data_fingerprint=None,
    expected_source_sha256=None,
    expected_preregistration_sha256=None,
    expected_families=None,
):
    """Summarize three folds. Missing or incompatible provenance fails closed."""
    th = {**DEFAULTS, **(thresholds or {})}
    families = list(families)
    unique_families = len(set(families)) == len(families)
    folds = {}
    missing = []
    invalid = {}
    for family in families:
        entry = (per_fold or {}).get(family)
        if not isinstance(entry, dict):
            missing.append(family)
            continue
        cand = entry.get("candidate") or {}
        prod = entry.get("production") or {}
        cand_m = cand.get("matched") or {}
        prod_m = prod.get("matched") or {}
        bad = []
        for name, block in (("candidate", cand_m), ("production", prod_m)):
            acc = _num(block.get("accuracy"))
            total = _count(block.get("total"))
            correct = _count(block.get("correct"))
            if acc is None or not 0.0 <= acc <= 1.0 or total <= 0 or correct > total:
                bad.append(f"{name}-matched-metric")
        for name, block in (("candidate", cand), ("production", prod)):
            acc = _num(block.get("draftAccuracy"))
            total = _count(block.get("draftTotal"))
            correct = _count(block.get("draftCorrect"))
            if acc is None or not 0.0 <= acc <= 1.0 or total <= 0 or (correct and correct > total):
                bad.append(f"{name}-draft-metric")
        if bad:
            invalid[family] = bad
            missing.append(family)
            continue
        folds[family] = entry

    complete = (
        unique_families
        and len(folds) == len(families)
        and len(families) == int(th["requiredFoldCount"])
    )

    matched_candidate = {f: folds[f]["candidate"]["matched"]["accuracy"] for f in folds}
    matched_production = {f: folds[f]["production"]["matched"]["accuracy"] for f in folds}
    margins = {
        f: (None if matched_candidate[f] is None or matched_production[f] is None
            else round(matched_candidate[f] - matched_production[f], 4))
        for f in folds
    }

    lineage = fold_compatibility if isinstance(fold_compatibility, dict) else {}
    lineage_rows = lineage.get("families") if isinstance(lineage.get("families"), dict) else {}
    lineage_reasons = []
    if lineage.get("allCompatible") is not True:
        lineage_reasons.append("fold-lineage-not-fully-compatible")
    if set(lineage_rows) != set(families):
        lineage_reasons.append("fold-lineage-family-set-mismatch-or-missing")
    for family in families:
        row = lineage_rows.get(family)
        if not isinstance(row, dict) or row.get("compatible") is not True:
            lineage_reasons.append(f"fold-lineage-incompatible:{family}")

    baseline_matched = ((baseline or {}).get("matched") or {})
    baseline_reasons = []
    if baseline_status:
        baseline_reasons.append(str(baseline_status))
    if not baseline:
        baseline_reasons.append("baseline-missing")
    if expected_data_fingerprint is None or expected_source_sha256 is None or expected_preregistration_sha256 is None or expected_families is None:
        baseline_reasons.append("baseline-lineage-expectations-missing")
    else:
        if (baseline or {}).get("schema") != "cfb.micro-cv-baseline/2":
            baseline_reasons.append("baseline-schema-missing-or-legacy")
        if (baseline or {}).get("trainingDataFingerprint") != expected_data_fingerprint:
            baseline_reasons.append("baseline-training-data-fingerprint-mismatch-or-missing")
        if (baseline or {}).get("sourceSha256") != expected_source_sha256:
            baseline_reasons.append("baseline-source-sha256-mismatch-or-missing")
        if (baseline or {}).get("preregistrationSha256") != expected_preregistration_sha256:
            baseline_reasons.append("baseline-preregistration-sha256-mismatch-or-missing")
        found_baseline_families = (baseline or {}).get("families")
        if not isinstance(found_baseline_families, list) or sorted(found_baseline_families) != sorted(expected_families):
            baseline_reasons.append("baseline-family-set-mismatch-or-missing")
    if not baseline_matched:
        baseline_reasons.append("baseline-matched-values-missing")
    baseline_valid = not baseline_reasons

    regressions = {}
    for family in folds:
        base = _num(baseline_matched.get(family)) if baseline_valid else None
        regressions[family] = None if base is None else round(matched_candidate[family] - base, 4)

    draft_total = 0
    draft_correct = 0
    for family in folds:
        candidate = folds[family]["candidate"]
        total = _count(candidate.get("draftTotal"))
        correct = _count(candidate.get("draftCorrect"))
        if correct == 0 and candidate.get("draftAccuracy") is not None:
            correct = int(round(float(candidate["draftAccuracy"]) * total))
        if correct > total:
            continue
        draft_correct += correct
        draft_total += total
    draft_aggregate = round(draft_correct / draft_total, 4) if draft_total else None
    draft_le_production = {
        f: (None if folds[f]["candidate"].get("draftAccuracy") is None or folds[f]["production"].get("draftAccuracy") is None
            else round(folds[f]["candidate"]["draftAccuracy"] - folds[f]["production"]["draftAccuracy"], 4))
        for f in folds
    }

    mean_matched = _mean(list(matched_candidate.values())) if complete else None
    worst_matched = min(matched_candidate.values()) if complete and matched_candidate else None

    gates = {}

    def gate(name, passed, detail):
        gates[name] = {"passed": bool(passed), "detail": detail}

    gate(
        "threeFoldCvComplete", complete,
        f"folds present={sorted(folds)} missing={missing} invalid={invalid} uniqueFamilies={unique_families} required={th['requiredFoldCount']}",
    )
    gate(
        "foldLineageCompatible", not lineage_reasons,
        f"allCompatible={lineage.get('allCompatible')} reasons={lineage_reasons}",
    )
    margin_ok = complete and all(m is not None and m >= float(th["matchedProductionMargin"]) - 1e-9 for m in margins.values())
    gate(
        "threeFoldMatchedBeatsProductionPlus20", margin_ok,
        f"margins={margins} required>=+{th['matchedProductionMargin']}",
    )
    gate(
        "threeFoldMatchedMeanAtLeast75",
        complete and mean_matched is not None and mean_matched >= float(th["matchedMeanFloor"]) - 1e-9,
        f"mean={None if mean_matched is None else round(mean_matched, 4)} floor>={th['matchedMeanFloor']}",
    )
    gate(
        "threeFoldMatchedWorstAtLeast70",
        complete and worst_matched is not None and worst_matched >= float(th["matchedWorstFloor"]) - 1e-9,
        f"worst={None if worst_matched is None else round(worst_matched, 4)} floor>={th['matchedWorstFloor']}",
    )
    reg_ok = (
        complete and baseline_valid
        and all(r is not None and r >= -float(th["noRegressionTolerance"]) - 1e-9 for r in regressions.values())
    )
    gate(
        "noRegressionVsPreviousCandidateFold", reg_ok,
        f"delta_vs_baseline={regressions} tolerance>=-{th['noRegressionTolerance']} baselineValid={baseline_valid} reasons={baseline_reasons}",
    )
    gate(
        "draftThreeFoldAggregateAtLeast85",
        complete and draft_aggregate is not None and draft_aggregate >= float(th["draftAggregateFloor"]) - 1e-9,
        f"aggregate={draft_aggregate} floor>={th['draftAggregateFloor']} (n={draft_total})",
    )
    gate(
        "draftEachFoldAtLeastProduction",
        complete and all(d is not None and d >= -1e-9 for d in draft_le_production.values()),
        f"candidate-minus-production={draft_le_production}",
    )
    gate(
        "prospectivePreregistration",
        confirmatory_eligible,
        confirmatory_reason or ("prospective pre-registration verified" if confirmatory_eligible else "current v2 rule is retrospective/exploratory"),
    )

    return {
        "schema": SCHEMA,
        "policy": (
            "retrospective exploratory summary only: v2 thresholds were written after the 2026-10-04 fold results; "
            "a positive metric summary is not confirmatory and cannot authorize promotion"
        ),
        "confirmatoryEligible": bool(confirmatory_eligible),
        "confirmatoryReason": confirmatory_reason,
        "families": families,
        "complete": complete,
        "missingFolds": missing,
        "invalidFolds": invalid,
        "foldCompatibility": fold_compatibility or {},
        "thresholds": {k: th[k] for k in DEFAULTS},
        "baselineValidation": {"valid": baseline_valid, "reasons": baseline_reasons},
        "perFold": {
            f: {
                "candidateMatched": matched_candidate[f],
                "productionMatched": matched_production[f],
                "marginOverProduction": margins[f],
                "matchedCorrect": folds[f]["candidate"]["matched"]["correct"],
                "matchedTotal": folds[f]["candidate"]["matched"]["total"],
                "candidateAllPairs": folds[f]["candidate"].get("accuracy"),
                "candidateWilsonLower95": folds[f]["candidate"].get("wilsonLower95"),
                "candidateDraft": folds[f]["candidate"].get("draftAccuracy"),
                "productionDraft": folds[f]["production"].get("draftAccuracy"),
                "baselineMatched": _num(baseline_matched.get(f)) if baseline_valid else None,
                "deltaVsBaseline": regressions[f],
            }
            for f in folds
        },
        "summary": {
            "matchedMean": None if mean_matched is None else round(mean_matched, 4),
            "matchedWorst": None if worst_matched is None else round(worst_matched, 4),
            "matchedSpread": None if (mean_matched is None or worst_matched is None)
            else round(max(matched_candidate.values()) - min(matched_candidate.values()), 4),
            "draftAggregate": draft_aggregate,
        },
        "gates": gates,
    }
