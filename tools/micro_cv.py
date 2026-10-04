"""cfb 微模型三折家族交叉验证判定（v2 闸门口径）。

背景（2026-10-04 实测）：同一模型、同一把尺子，三折 matched 桶极差 22.9pp
（flaky 77.1 / perf 100 / sse 84.7）；n=30/12 的绝对 90% 闸门实为抽签。
因此 v2 把「绝对 90%」降为报告项，阻塞判据改为：
  · 三折齐全；
  · 每折 matched >= 同折生产 matched + 0.20；
  · 三折 matched 均值 >= 0.75 且最差折 >= 0.70；
  · 相对上一候选每折不回退超过 0.03；
  · draft 三折合计 >= 0.85 且每折不低于同折生产。
本模块不依赖 torch，便于本地单测与评审。
"""

SCHEMA = "cfb.micro-cv/1"

DEFAULTS = {
    "matchedProductionMargin": 0.20,
    "matchedMeanFloor": 0.75,
    "matchedWorstFloor": 0.70,
    "noRegressionTolerance": 0.03,
    "draftAggregateFloor": 0.85,
    "requiredFoldCount": 3,
}


def _num(value):
    return value if isinstance(value, (int, float)) else None


def matched_of(unit_block):
    """从 rulerReading 的 unit 块里取长度匹配桶（承重读数）。"""
    matched = ((unit_block or {}).get("lengthStratified") or {}).get("matched") or {}
    return {
        "accuracy": _num(matched.get("accuracy")),
        "correct": matched.get("correct") or 0,
        "total": matched.get("total") or 0,
        "wilsonLower95": _num(matched.get("wilsonLower95")),
    }


def fold_metrics_from_report(report):
    """把一份逐折报告压成判定所需的读数（candidate / production 各一组）。"""
    ruler = (report or {}).get("rulerReading") or {}
    cand_unit = ruler.get("candidateUnitValidation") or {}
    prod_unit = ruler.get("productionUnitValidation") or {}
    cand_draft = ruler.get("candidateDraftValidation") or {}
    prod_draft = ruler.get("productionDraftValidation") or {}
    return {
        "candidate": {
            "matched": matched_of(cand_unit),
            "accuracy": _num(cand_unit.get("accuracy")),
            "total": cand_unit.get("total") or 0,
            "wilsonLower95": _num(cand_unit.get("wilsonLower95")),
            "draftAccuracy": _num(cand_draft.get("accuracy")),
            "draftTotal": cand_draft.get("total") or 0,
        },
        "production": {
            "matched": matched_of(prod_unit),
            "accuracy": _num(prod_unit.get("accuracy")),
            "total": prod_unit.get("total") or 0,
            "draftAccuracy": _num(prod_draft.get("accuracy")),
            "draftTotal": prod_draft.get("total") or 0,
        },
    }


def _mean(values):
    usable = [v for v in values if v is not None]
    return sum(usable) / len(usable) if usable else None


def summarize(families, per_fold, baseline=None, thresholds=None):
    """计算三折总表与 v2 闸门。families 必须正好是三个 dev 家族。"""
    th = {**DEFAULTS, **(thresholds or {})}
    families = list(families)
    folds = {}
    missing = []
    for family in families:
        entry = (per_fold or {}).get(family)
        if not entry or entry.get("candidate", {}).get("matched", {}).get("accuracy") is None:
            missing.append(family)
            continue
        folds[family] = entry

    complete = len(folds) == len(families) and len(families) == int(th["requiredFoldCount"])

    matched_candidate = {f: folds[f]["candidate"]["matched"]["accuracy"] for f in folds}
    matched_production = {f: folds[f]["production"]["matched"]["accuracy"] for f in folds}
    margins = {
        f: (None if matched_candidate[f] is None or matched_production[f] is None
            else round(matched_candidate[f] - matched_production[f], 4))
        for f in folds
    }
    baseline_matched = ((baseline or {}).get("matched") or {})
    regressions = {}
    for f in folds:
        base = _num(baseline_matched.get(f))
        regressions[f] = None if base is None else round(matched_candidate[f] - base, 4)

    draft_correct = sum(folds[f]["candidate"]["matched"]["correct"] for f in folds)  # 仅占位，下面用 draft 字段
    draft_total = 0
    draft_correct = 0
    for f in folds:
        c = folds[f]["candidate"]
        if c.get("draftAccuracy") is not None and c.get("draftTotal"):
            draft_correct += int(round(c["draftAccuracy"] * c["draftTotal"]))
            draft_total += int(c["draftTotal"])
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
        f"folds present={sorted(folds)} missing={missing} required={th['requiredFoldCount']}",
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
    if not baseline_matched:
        gate("noRegressionVsPreviousCandidateFold", True, "no baseline recorded; regression guard inactive")
    else:
        reg_ok = complete and all(
            r is not None and r >= -float(th["noRegressionTolerance"]) - 1e-9 for r in regressions.values()
        )
        gate(
            "noRegressionVsPreviousCandidateFold", reg_ok,
            f"delta_vs_baseline={regressions} tolerance>=-{th['noRegressionTolerance']}",
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

    return {
        "schema": SCHEMA,
        "policy": (
            "v2: absolute 90% lines are reported-only; blocking judgement is three-fold family CV on the "
            "length-matched bucket against the production weights, plus a no-regression guard and draft parity."
        ),
        "families": families,
        "complete": complete,
        "missingFolds": missing,
        "thresholds": {k: th[k] for k in DEFAULTS},
        "perFold": {
            f: {
                "candidateMatched": matched_candidate[f],
                "productionMatched": matched_production[f],
                "marginOverProduction": margins[f],
                "matchedCorrect": folds[f]["candidate"]["matched"]["correct"],
                "matchedTotal": folds[f]["candidate"]["matched"]["total"],
                "candidateAllPairs": folds[f]["candidate"]["accuracy"],
                "candidateWilsonLower95": folds[f]["candidate"]["wilsonLower95"],
                "candidateDraft": folds[f]["candidate"].get("draftAccuracy"),
                "productionDraft": folds[f]["production"].get("draftAccuracy"),
                "baselineMatched": _num(baseline_matched.get(f)),
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
