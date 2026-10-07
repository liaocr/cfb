#!/usr/bin/env python3
"""为「任务专用微模型」现训词表：纯 ByteLevel BPE，语料只有我们的训练文本。

为什么：Qwen3-0.6B 的 151,669 词表里 80% 在我们的语料上一次都没出现；
嵌入+输出层占模型 26%。自训 16k 词表把这块压到几近为零，且不损失字节级鲁棒性
（ByteLevel 保证任意 UTF-8 都能编码）。

用法：
  python3 micro-tokenizer.py --train <train.jsonl.gz> --vocab-size 16384 --out tokenizer.json
  python3 micro-tokenizer.py --config <micro-gen 目录>/model-config.json   # 用同目录 train.jsonl.gz 重训
"""
from __future__ import annotations

import argparse, gzip, importlib.util, json, time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FMT = _load("micro_format", HERE / "micro-format.py")


def train_tokenizer(texts, vocab_size: int, out_path: Path, special_tokens=None):
    """texts: 可迭代的字符串。返回 tokenizers.Tokenizer 并落盘。"""
    from tokenizers import Tokenizer, models, trainers, pre_tokenizers, decoders

    tok = Tokenizer(models.BPE(unk_token=None))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=True)
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        special_tokens=list(special_tokens or FMT.SPECIAL_TOKENS),
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),  # 字节全覆盖：零 OOV
        show_progress=False,
    )
    t0 = time.time()
    tok.train_from_iterator(texts, trainer=trainer)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tok.save(str(out_path))
    return tok, time.time() - t0


def iter_texts(path: Path, limit: int = 0):
    with gzip.open(path, "rt") as f:
        for i, line in enumerate(f):
            if not line.strip():
                continue
            if limit and i >= limit:
                break
            r = json.loads(line)
            _, full = FMT.row_to_texts(r)
            yield full


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default=None, help="train.jsonl.gz")
    ap.add_argument("--config", default=None, help="用某个 micro-gen 运行目录的 model-config.json 推断")
    ap.add_argument("--vocab-size", type=int, default=16384)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.config:
        cfg = json.loads(Path(args.config).read_text())
        args.vocab_size = cfg["vocab"]
        train = Path(args.config).parent / "train.jsonl.gz"
    else:
        train = Path(args.train)
    assert train.exists(), f"缺训练文本 {train}"

    tok, sec = train_tokenizer(iter_texts(train, args.limit), args.vocab_size, Path(args.out))
    v = tok.get_vocab_size()
    ids = tok.token_to_id(FMT.END)
    print(json.dumps(dict(out=args.out, vocab=v, sec=round(sec, 2), end_token_id=ids,
                          specials={t: tok.token_to_id(t) for t in FMT.SPECIAL_TOKENS}), ensure_ascii=False))


if __name__ == "__main__":
    main()
