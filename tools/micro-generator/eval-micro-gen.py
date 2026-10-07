#!/usr/bin/env python3
"""对已训好的微模型 checkpoint 重跑 dev 生成评测，落盘预测文本（供 7 轴判读）。

用途：训练器只存指标；判读需要的是「每条 dev 的预测稿」。
     本工具从 micro-gen-best.pt（优先）或 micro-gen.pt 载入，贪心生成，
     写 out/dev-predictions.jsonl（unitId / prediction / gold / 代理指标），并打印摘要与样例。

用法（Kaggle，训练完成后新开 cell）：
  python3 eval-micro-gen.py --ckpt <run目录> --corpus transfer/models/micro-generator-gen-v3 \
      --out <run目录> [--limit N] [--device cuda|cpu] [--max-new N]
"""
from __future__ import annotations

import argparse, importlib.util, json, sys, time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FMT = _load("micro_format", HERE / "micro-format.py")
TM = _load("train_micro_gen", HERE / "train-micro-gen.py")  # 复用 MicroGPT / greedy_gen / anchor_recall / load_rows


def pick_ckpt(ckpt: Path) -> Path:
    if ckpt.is_dir():
        best = ckpt / "micro-gen-best.pt"
        last = ckpt / "micro-gen.pt"
        if best.exists():
            return best
        assert last.exists(), f"{ckpt} 下没有 micro-gen-best.pt / micro-gen.pt"
        return last
    return ckpt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, help="run 目录或 .pt 文件")
    ap.add_argument("--corpus", required=True, help="含 dev.jsonl.gz 的目录")
    ap.add_argument("--out", default=None, help="输出目录（默认同 --ckpt 目录）")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--device", default=None, help="cuda | cpu（默认自动）")
    ap.add_argument("--max-new", type=int, default=0, help="0=按每条 gold 长度自适应（×1.6+96，上限 2048）")
    ap.add_argument("--examples", type=int, default=3, help="打印几条样例")
    args = ap.parse_args()

    ckpt_p = pick_ckpt(Path(args.ckpt))
    out = Path(args.out) if args.out else ckpt_p.parent
    out.mkdir(parents=True, exist_ok=True)
    state = torch.load(ckpt_p, map_location="cpu")
    meta = state.get("meta", {})
    cfg = meta.get("cfg") or json.loads((ckpt_p.parent / "model-config.json").read_text())
    print(f"[ckpt] {ckpt_p} · cfg {cfg} · bestStep {meta.get('bestStep', -1)}", flush=True)

    from tokenizers import Tokenizer
    tok_p = ckpt_p.parent / "tokenizer.json"
    assert tok_p.exists(), f"缺词表 {tok_p}"
    tok = Tokenizer.from_file(str(tok_p))

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    # cfg 里存的是 d_model，构造参数名是 d
    model = TM.MicroGPT(vocab=cfg["vocab"], d=cfg["d_model"], layers=cfg["layers"],
                        heads=cfg["heads"], ctx=cfg["ctx"], ffn_mult=cfg.get("ffn_mult", 4))
    model.load_state_dict(state["model"])
    model.to(device).eval()

    dev_rows = TM.load_rows(Path(args.corpus) / "dev.jsonl.gz")
    if args.limit:
        dev_rows = dev_rows[: args.limit]

    t0 = time.time()
    acc = dict(n=0, em=0, invented=0, recalls=[], gold_chars=0, pred_chars=0, truncated=0, empty=0)
    dump_p = out / "dev-predictions.jsonl"
    with open(dump_p, "w") as f:
        for i, r in enumerate(dev_rows):
            prompt, _ = FMT.row_to_texts(r)
            gold = FMT.assistant_text(r)
            if args.max_new:
                max_new = args.max_new
            else:
                g_tok = len(tok.encode(gold).ids)
                max_new = int(min(2048, max(256, g_tok * 1.6 + 96)))
            pred = TM.greedy_gen(model, tok, prompt, max_new=max_new, ctx=cfg["ctx"], device=device)
            rec, inv, na = TM.anchor_recall(gold, pred)
            truncated = len(tok.encode(pred).ids) >= max_new
            rec_json = dict(unitId=r.get("unitId"), prediction=pred, gold=gold,
                            proxy=dict(recall=round(rec, 4), nAnchors=na, invented=inv,
                                       em=pred.strip() == gold.strip(),
                                       goldLen=len(gold), predLen=len(pred),
                                       truncated=truncated, maxNew=max_new))
            f.write(json.dumps(rec_json, ensure_ascii=False) + "\n")
            acc["n"] += 1
            acc["em"] += rec_json["proxy"]["em"]
            acc["invented"] += inv
            acc["recalls"].append(rec)
            acc["gold_chars"] += len(gold); acc["pred_chars"] += len(pred)
            acc["truncated"] += truncated
            acc["empty"] += (len(pred.strip()) == 0)
            if (i + 1) % 16 == 0:
                print(f"[eval] {i+1}/{len(dev_rows)} · {time.time()-t0:.0f}s", flush=True)

    rs = sorted(acc["recalls"])
    summary = dict(n=acc["n"], exactMatch=round(acc["em"] / max(1, acc["n"]), 4),
                   anchorRecallMean=round(sum(acc["recalls"]) / max(1, acc["n"]), 4),
                   anchorRecallMedian=round(rs[len(rs)//2] if rs else 0.0, 4),
                   anchorRecallP10=round(rs[max(0, len(rs)//10 - 1)] if rs else 0.0, 4),
                   inventedAnchorsTotal=acc["invented"],
                   charRatioGoldToPred=round(acc["gold_chars"] / max(1, acc["pred_chars"]), 4),
                   truncatedOutputs=acc["truncated"], emptyOutputs=acc["empty"],
                   elapsedSec=round(time.time() - t0, 1), ckpt=str(ckpt_p))
    (out / "dev-predictions-summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print("[summary] " + json.dumps(summary, ensure_ascii=False), flush=True)

    if args.examples:
        print("\n=== 样例（前几条，各截 300 字）===", flush=True)
        with open(dump_p) as f:
            for line in list(f)[: args.examples]:
                d = json.loads(line)
                print(f"--- {d['unitId']} · recall {d['proxy']['recall']} · "
                      f"ratio {d['proxy']['goldLen']/max(1,d['proxy']['predLen']):.2f}")
                print("GOLD:", d["gold"][:300].replace("\n", " ⏎ "))
                print("PRED:", d["prediction"][:300].replace("\n", " ⏎ ") or "<空>", flush=True)

    print(f"\n[done] 预测已落盘 {dump_p}（{dump_p.stat().st_size/1024:.0f} KB）", flush=True)
    print("下一步：把 dev-predictions.jsonl 交回，跑 7 轴判读（唯一验收）。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
