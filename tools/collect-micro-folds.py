#!/usr/bin/env python3
"""离线并读三折 Kaggle 报告，重放冻结的 CV v2 判定（无 torch、无 GPU、零训练成本）。

为什么需要它：训练脚本在每一折里把「其余两折」当作外部报告读取，一旦上一折写回的
transfer/models/cfb-micro-97m-report.fold-*.json 被 git pull/checkout 还原成旧提交，
该折就被判血统不符并从聚合中剔除 —— 三折永远凑不齐。本脚本只做同一套判定，但把
每条报告自带的血统原样打印出来，于是「谁被剔除、为什么」是一次读得懂的证据，而不是
需要再花一次 GPU 训练才能看到的副作用。

它复用训练脚本用的同一份判据模块 tools/micro_cv.py（fold_report_compatibility /
baseline_report_compatibility / summarize），不重新实现任何闸门算术；唯一自己算的是
数据内容指纹与 13 个血统文件哈希，两处都逐字取自 tools/kaggle-train-micro.py。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import micro_cv  # noqa: E402  (torch-free judging module, shared with the trainer)

TRAIN_SCRIPT = ROOT / "tools" / "kaggle-train-micro.py"


def compute_training_data_fingerprint(dataset: dict) -> str:
    """逐字镜像 tools/kaggle-train-micro.py 的同名函数：只忽略非语义的构建时间戳。"""
    canonical = dict(dataset)
    canonical.pop("createdAt", None)
    encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def frozen_source_paths() -> list[Path]:
    """从训练脚本里读出 source_paths 常量本身，避免两处清单漂移。"""
    text = TRAIN_SCRIPT.read_text(encoding="utf-8")
    block = re.search(r"source_paths = \[(.*?)\n    \]", text, re.S)
    if not block:
        raise RuntimeError("cannot locate source_paths in the training script; refusing to guess lineage")
    resolved = []
    for chunk in re.findall(r'ROOT((?: / "[^"]+")+)', block.group(1)):
        resolved.append(ROOT.joinpath(*re.findall(r'"([^"]+)"', chunk)))
    if not resolved:
        raise RuntimeError("parsed an empty source_paths list; refusing to guess lineage")
    return resolved


def recompute_source_sha256() -> dict:
    return {str(item.relative_to(ROOT)): hashlib.sha256(item.read_bytes()).hexdigest() for item in frozen_source_paths()}


def short(value, size=12):
    text = str(value)
    return text if len(text) <= size else text[:size]


def load_prereg(path: Path) -> dict:
    raw = path.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    if data.get("schema") != "cfb.micro-preregistration/2" or data.get("status") != "locked":
        raise RuntimeError(f"{path.name} is not a locked cfb.micro-preregistration/2 file")
    if data.get("decisionRuleChangedAt") or data.get("decisionRuleChangeNote"):
        raise RuntimeError("decision rule was changed after results; the lock is exploratory, not confirmatory")
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "trainingDataFingerprint": data.get("trainingDataFingerprint"),
        "folds": data.get("folds") or [],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--preregistration", default="transfer/micro-preregistration-2026-10-06c.json")
    ap.add_argument("--dataset", default="transfer/models/micro-dev-dataset.json")
    ap.add_argument("--models-dir", default="transfer/models")
    ap.add_argument("--baseline", default="transfer/micro-cv-baseline.json")
    ap.add_argument("--source-sha-from-report", action="store_true",
                    help="数据指纹与锁 sha 仍按冻结锁校验，只把 13 个血统文件的哈希取自第一份报告："
                         "Kaggle 检出相对提交有未跟踪差异（缓存、临时产物）时用这个，避免假阴性。")
    ap.add_argument("--lineage-from-first-report", action="store_true",
                    help="自检/旧纪元并读：期望血统取自第一份可读报告，而不是本地检出（Kaggle 与本地"
                         "检出可能有未跟踪差异时用这个模式复现训练脚本的算术）。")
    args = ap.parse_args()

    models_dir = Path(args.models_dir)
    if not models_dir.is_absolute():
        models_dir = ROOT / models_dir
    dataset_path = Path(args.dataset)
    if not dataset_path.is_absolute():
        dataset_path = ROOT / dataset_path
    prereg_path = Path(args.preregistration)
    if not prereg_path.is_absolute():
        prereg_path = ROOT / prereg_path

    lock = load_prereg(prereg_path)
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    fp = compute_training_data_fingerprint(dataset)
    families = list(dataset["stats"]["devFamilyNames"])
    print("=" * 70)
    print("CFB-Micro 三折离线并读（CV v2，冻结判据复用 tools/micro_cv.py）")
    print("=" * 70)
    print(f"   lock {prereg_path.name}: sha256 {short(lock['sha256'])}…  pinned fp {short(lock['trainingDataFingerprint'])}…")
    print(f"   本地检出 {dataset_path.name}: fp {short(fp)}…  match_lock={fp == lock['trainingDataFingerprint']}")
    local_source_sha = recompute_source_sha256()
    print(f"   血统文件 {len(local_source_sha)} 个（本地检出重算），kaggle-train-micro.py = "
          f"{short(local_source_sha.get('tools/kaggle-train-micro.py'))}…")

    reports = {}
    for family in families:
        path = models_dir / f"cfb-micro-97m-report.fold-{family}.json"
        if not path.is_file():
            print(f"   [{family:<16}] 缺文件: {path.relative_to(ROOT)}")
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        reports[family] = report
        ds = report.get("dataset") or {}
        freeze = ds.get("finalEvaluationFreeze") or {}
        src = freeze.get("sourceSha256")
        print(f"   [{family:<16}] fp={short(ds.get('trainingDataFingerprint'))}… "
              f"prereg={short((report.get('preregistration') or {}).get('sha256'))}… "
              f"srcSha={'dict/' + short(src.get('tools/kaggle-train-micro.py')) if isinstance(src, dict) else src}"
              f" valFam={ds.get('validationFamily') or freeze.get('validationFamily')}")
    if not reports:
        print("\n❌ 一条逐折报告都读不到：这次并读无从谈起。先在 Kaggle 上确认 "
              "cfb-micro-97m-report.fold-*.json 是否被 git 操作还原/删除。")
        return 1

    if args.lineage_from_first_report:
        sample = next(iter(reports.values()))
        expected_fp = (sample.get("dataset") or {}).get("trainingDataFingerprint")
        expected_prereg = (sample.get("preregistration") or {}).get("sha256")
        expected_source = ((sample.get("dataset") or {}).get("finalEvaluationFreeze") or {}).get("sourceSha256")
        print(f"   ⚠ --lineage-from-first-report：三折只互相比较，不校验本地检出（自检模式）")
    else:
        expected_fp, expected_prereg, expected_source = fp, lock["sha256"], local_source_sha
        if args.source_sha_from_report:
            sample = next(iter(reports.values()))
            expected_source = ((sample.get("dataset") or {}).get("finalEvaluationFreeze") or {}).get("sourceSha256")
            print("   ⚠ --source-sha-from-report：血统文件哈希取自报告（本地检出仅用于对账）")

    per_fold = {}
    rows = {}
    for family in families:
        report = reports.get(family)
        if report is None:
            rows[family] = {"compatible": False, "reasons": ["fold-report-missing"]}
            continue
        compat = micro_cv.fold_report_compatibility(
            report, family,
            training_data_fingerprint=expected_fp,
            preregistration_sha256=expected_prereg,
            source_sha256=expected_source,
            expected_families=families,
        )
        rows[family] = compat
        if compat["compatible"]:
            per_fold[family] = micro_cv.fold_metrics_from_report(report)
        else:
            print(f"   [CV] excluding incompatible fold {family}: {', '.join(compat['reasons'])}")
    fold_lineage = {
        "allCompatible": set(rows) == set(families) and all(r.get("compatible") is True for r in rows.values()),
        "families": rows,
    }

    baseline_path = Path(args.baseline)
    if not baseline_path.is_absolute():
        baseline_path = ROOT / baseline_path
    baseline_raw = json.loads(baseline_path.read_text(encoding="utf-8")) if baseline_path.is_file() else None
    baseline_compat = micro_cv.baseline_report_compatibility(
        baseline_raw,
        training_data_fingerprint=expected_fp,
        preregistration_sha256=expected_prereg,
        source_sha256=expected_source,
        expected_families=families,
    )
    cv_baseline = baseline_raw if baseline_compat["compatible"] else None
    baseline_status = None if baseline_compat["compatible"] else \
        "baseline-lineage-incompatible:" + ",".join(baseline_compat["reasons"])
    confirmatory = bool(lock.get("sha256") and fold_lineage["allCompatible"] and baseline_compat["compatible"])
    confirmatory_reason = ("prospective lock plus exact fold/baseline lineage verified" if confirmatory else
                           "fold-lineage-incompatible-or-missing; " + str(baseline_status or "baseline-invalid"))

    summary = micro_cv.summarize(
        families, per_fold,
        baseline=cv_baseline,
        confirmatory_eligible=confirmatory,
        confirmatory_reason=confirmatory_reason,
        baseline_status=baseline_status,
        fold_compatibility=fold_lineage,
        expected_data_fingerprint=expected_fp,
        expected_source_sha256=expected_source,
        expected_preregistration_sha256=expected_prereg,
        expected_families=families,
    )

    print("\n[CV v2] 三折家族交叉验证（matched 桶，承重读数）:")
    for family, row in summary["perFold"].items():
        print(f"   {family:<16} matched={row['candidateMatched']} (prod={row['productionMatched']}, "
              f"margin={row['marginOverProduction']}, vs_prev={row['deltaVsBaseline']}) "
              f"all={row['candidateAllPairs']} draft={row['candidateDraft']}")
    s = summary["summary"]
    print(f"   mean={s['matchedMean']} worst={s['matchedWorst']} spread={s['matchedSpread']} complete={summary['complete']}")
    for name, gate in summary["gates"].items():
        print(f"   [v2] {name}: {'PASS' if gate['passed'] else 'FAIL'} ({gate['detail']})")
    print(f"\n   folds pooled: {len(per_fold)}/3  confirmatory_eligible={confirmatory}")
    print("   注：本脚本不写任何权重，只读报告；判定算术与训练脚本 Stage 6 完全同源。")
    return 0 if summary["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
