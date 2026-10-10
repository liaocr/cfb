
# -*- coding: utf-8 -*-
"""独立的 RWKV World 分词器（照抄 hf_rwkv_tokenizer.py 的算法，不依赖 transformers）。

为什么自己实现：本地没有 GPU 也没有 transformers，但分词器是纯 trie 贪心匹配，
只需要词表文件。要回答的问题是**学生的稿子有没有被 --gen-max-new 768 截断** ——
日志里出现过一条 5178 字的稿子，若真按 768 token 截断，那是每 token 6.7 字，
远超任何合理比值，说明要么没截断、要么我对生成配置的理解是错的。这个必须量出来。
"""
import ast, io, json

class Node:
    __slots__ = ("to", "values")
    def __init__(self):
        self.to = [None] * 256
        self.values = set()

class RwkvTok:
    def __init__(self, path):
        self.idx2tok = {}
        with io.open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                a = line.index(" ")
                b = line.rindex(" ")
                idx = int(line[:a])
                x = ast.literal_eval(line[a:b])
                x = x.encode("utf-8") if isinstance(x, str) else x
                self.idx2tok[idx] = x
        self.root = Node()
        for i, t in self.idx2tok.items():
            u = self.root
            for byte in t:
                if u.to[byte] is None:
                    u.to[byte] = Node()
                u = u.to[byte]
            u.values.add(i)

    def encode(self, s):
        src = s.encode("utf-8")
        out = []
        i = 0
        n = len(src)
        while i < n:
            u = self.root
            best = None
            j = i
            while j < n and u.to[src[j]] is not None:
                u = u.to[src[j]]
                j += 1
                if u.values:
                    best = (j, next(iter(u.values)))
            if best is None:
                out.append(src[i]); i += 1
            else:
                out.append(best[1]); i = best[0]
        return out

VOCAB = r"D:\cfb\.cfb-offline\kaggle-out\v10\rwkv7-compressor\model\rwkv_vocab_v20230424.txt"
tok = RwkvTok(VOCAB)
print("词表载入:", len(tok.idx2tok), "个 token")
print("自检 encode('hello world') =", tok.encode("hello world"))
print("自检 encode('你好') =", tok.encode("你好"), "长度", len(tok.encode("你好")))
print("")

def rd(p):
    return [json.loads(l) for l in io.open(p, encoding="utf-8").read().strip().split("\n") if l]

dev = rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")
byid = {r["id"]: r for r in dev}

def stats(name, drafts):
    lens, toks = [], []
    for d in drafts:
        lens.append(len(d))
        toks.append(len(tok.encode(d)))
    toks_s = sorted(toks); lens_s = sorted(lens)
    def p(a, q): return a[int(len(a) * q)]
    over = sum(1 for t in toks if t >= 760)
    print(name.ljust(18) + "n=" + str(len(toks)).ljust(5) +
          "字数 p50 " + str(p(lens_s, .5)).ljust(7) +
          "token p50 " + str(p(toks_s, .5)).ljust(7) +
          "token p90 " + str(p(toks_s, .9)).ljust(7) +
          "token max " + str(max(toks)).ljust(7) +
          "字/token " + "%.2f" % (sum(lens) / max(1, sum(toks))) +
          "  >=760 token: " + str(over))

print("=== 稿子的真实 token 长度（--gen-max-new 768）===")
stats("教师 dev", [r["assistant"] for r in dev])
for name, f in [("v9 学生", r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\dev-generations.jsonl"),
                ("v10 学生", r"D:\cfb\.cfb-offline\kaggle-out\v10\rwkv7-compressor\dev-generations.jsonl")]:
    rows = rd(f)
    stats(name, [str(r.get("draft") or "") for r in rows])
    mx = max(rows, key=lambda r: len(tok.encode(str(r.get("draft") or ""))))
    print("   最长一条: " + str(mx["id"]) + " · " + str(len(str(mx["draft"]))) + " 字 · " +
          str(len(tok.encode(str(mx["draft"])))) + " token")
print("")
print("=== 训练目标（教师稿）的 token 长度 ===")
train = rd(r"D:\cfb\.cfb-offline\sft\train.jsonl")
stats("train 目标", [r["assistant"] for r in train])
