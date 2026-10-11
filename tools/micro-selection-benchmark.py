#!/usr/bin/env python3
"""微模型「选材基准」：产品需要的是「该留 vs 该丢」的判别，而不是自造的配对胜率。

标准答案 = 独立复核标签（transfer/models/unit-label-review.json，已并入数据集 labelAudit.review）。
K（该留）= 槽位 ∈ {MECHANISM, DECIDED, ACCEPT, OPEN, EXCLUDED} 且 yVal ≥ 0.6
D（该丢）= 槽位 NOISE 或 yVal ≤ 0.2
指标 = 逐条用例内的 K×D 配对准确率（同一条用例内排序即可，不跨用例比较），
       外加 top-10 选材的精确率/召回（产品当前 k=10 的上限）。
对照组 = 生产权重（19 维先验）/ 位置基线（越靠后越重要）/ 短文本基线 / 随机（0.5）。
用法：python3 tools/micro-selection-benchmark.py [--json out.json]
"""
import argparse, collections, json, math, sys

KEEP = {"MECHANISM", "DECIDED", "ACCEPT", "OPEN", "EXCLUDED"}


def gelu(z):
    return 0.5 * z * (1 + math.tanh(0.79788456 * (z + 0.044715 * z * z * z)))


def load_weights(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def score(vec, tok, w):
    """与 src/compile-v5-local.js:scoreUnitWithWeights 同式（已按 20×2 逐条对拍验证）。"""
    vw = w["valueWeights"]
    total = sum(vw[i] * vec[i] for i in range(min(len(vw), len(vec))))
    head = w.get("mlpHead")
    if head:
        W1, b1, WVal = head["W1"], head.get("b1", []), head.get("WVal", [])
        scale = head.get("scale", 0.25)
        h = [
            gelu(sum(row[j] * vec[j] for j in range(min(len(row), len(vec))))
                 + (b1[i] if i < len(b1) else 0))
            for i, row in enumerate(W1)
        ]
        total += scale * sum(WVal[i] * h[i] for i in range(min(len(WVal), len(h))))
    return total - w.get("lambda", 0.0038) * tok


def reviewed(unit):
    return bool((unit.get("labelAudit") or {}).get("review", {}).get("applied"))


def run(dataset_path, candidate_path, production_path, strict, topk):
    with open(dataset_path, encoding="utf-8") as fh:
        units = json.load(fh)["unitSamples"]
    cand, prod = load_weights(candidate_path), load_weights(production_path)
    by_src = collections.defaultdict(list)
    for u in units:
        by_src[u["sourceId"]].append(u)

    rows = []
    for src, us in sorted(by_src.items()):
        K = [u for u in us if u["slot"] in KEEP and u["yVal"] >= 0.6 and (reviewed(u) or not strict)]
        D = [u for u in us if (u["slot"] == "NOISE" or u["yVal"] <= 0.2) and (reviewed(u) or not strict)]
        if len(K) < 2 or len(D) < 2:
            continue

        def pair_acc(fn):
            good = tot = 0
            for k in K:
                for dd in D:
                    tot += 1
                    good += 1 if fn(k) > fn(dd) else 0
            return good / tot, tot

        s_cand = lambda u: score(u["features"], u["tokenCount"], cand)
        s_prod = lambda u: score(u["features"], u["tokenCount"], prod)
        a_cand, pairs = pair_acc(s_cand)
        a_prod, _ = pair_acc(s_prod)
        a_pos, _ = pair_acc(lambda u: u["unitIdx"])
        a_short, _ = pair_acc(lambda u: -u["tokenCount"])
        ranked = sorted(us, key=s_cand, reverse=True)[:topk]
        ranked_p = sorted(us, key=s_prod, reverse=True)[:topk]
        kset = {id(u) for u in K}
        rows.append({
            "source": src, "keepUnits": len(K), "dropUnits": len(D), "pairs": pairs,
            "candidatePairAcc": round(a_cand, 4), "productionPairAcc": round(a_prod, 4),
            "positionBaseline": round(a_pos, 4), "shortTextBaseline": round(a_short, 4),
            "candidateTopK": {"k": topk,
                              "precision": round(sum(1 for u in ranked if id(u) in kset) / len(ranked), 4),
                              "recall": round(sum(1 for u in ranked if id(u) in kset) / len(K), 4)},
            "productionTopK": {"k": topk,
                               "precision": round(sum(1 for u in ranked_p if id(u) in kset) / len(ranked_p), 4),
                               "recall": round(sum(1 for u in ranked_p if id(u) in kset) / len(K), 4)},
        })
    total_pairs = sum(r["pairs"] for r in rows) or 1
    agg = {
        "candidatePairAcc": round(sum(r["candidatePairAcc"] * r["pairs"] for r in rows) / total_pairs, 4),
        "productionPairAcc": round(sum(r["productionPairAcc"] * r["pairs"] for r in rows) / total_pairs, 4),
        "positionBaseline": round(sum(r["positionBaseline"] * r["pairs"] for r in rows) / total_pairs, 4),
        "shortTextBaseline": round(sum(r["shortTextBaseline"] * r["pairs"] for r in rows) / total_pairs, 4),
        "sources": len(rows), "pairs": total_pairs,
        "sourcesWhereCandidateBeatsProduction": sum(1 for r in rows if r["candidatePairAcc"] > r["productionPairAcc"]),
    }
    return {"schema": "cfb.micro-selection-benchmark/1", "labelsStrictlyReviewed": strict,
            "topK": topk, "aggregate": agg, "perSource": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="transfer/models/micro-dev-dataset.json")
    ap.add_argument("--candidate", default="transfer/models/v5-micro-weights.candidate.json")
    ap.add_argument("--production", default="transfer/models/v5-micro-weights.json")
    ap.add_argument("--topk", type=int, default=10)
    ap.add_argument("--json")
    args = ap.parse_args()
    out = {"strict": run(args.dataset, args.candidate, args.production, True, args.topk),
           "allLabels": run(args.dataset, args.candidate, args.production, False, args.topk)}
    for name, block in out.items():
        a = block["aggregate"]
        print(f"[{name}] 候选 {a['candidatePairAcc']} | 生产 {a['productionPairAcc']} | "
              f"位置 {a['positionBaseline']} | 短文本 {a['shortTextBaseline']} "
              f"(对 {a['pairs']}, 候选优于生产的用例 {a['sourcesWhereCandidateBeatsProduction']}/{a['sources']})")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print("written:", args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
