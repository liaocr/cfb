
# -*- coding: utf-8 -*-
"""量 effect-eval 五个任务喂给 RWKV7 时的真实 token 数（窗口 6144）。"""
import ast, io, json

class Node:
    __slots__ = ("to", "values")
    def __init__(self):
        self.to = [None] * 256
        self.values = set()

class RwkvTok:
    def __init__(self, path):
        self.idx2tok = {}
        for line in io.open(path, encoding="utf-8"):
            line = line.rstrip("\n")
            if not line:
                continue
            a = line.index(" "); b = line.rindex(" ")
            x = ast.literal_eval(line[a:b])
            self.idx2tok[int(line[:a])] = x.encode("utf-8") if isinstance(x, str) else x
        self.root = Node()
        for i, t in self.idx2tok.items():
            u = self.root
            for byte in t:
                if u.to[byte] is None:
                    u.to[byte] = Node()
                u = u.to[byte]
            u.values.add(i)
    def encode(self, s):
        src = s.encode("utf-8"); out = []; i = 0; n = len(src)
        while i < n:
            u = self.root; best = None; j = i
            while j < n and u.to[src[j]] is not None:
                u = u.to[src[j]]; j += 1
                if u.values:
                    best = (j, next(iter(u.values)))
            if best is None:
                out.append(src[i]); i += 1
            else:
                out.append(best[1]); i = best[0]
        return out

VOCAB = r"D:\cfb\.cfb-offline\kaggle-out\v10\rwkv7-compressor\model\rwkv_vocab_v20230424.txt"
tok = RwkvTok(VOCAB)
MAXLEN = 6144

pairs = [json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\effect\pairs.jsonl", encoding="utf-8") if l.strip()]
print("窗口 %d · 系统提示词与训练一致" % MAXLEN)
print("")
print("%-18s %8s %8s %8s %8s %8s   %s" % ("id", "sys", "ctx", "raw", "合计", "余量", "判定"))
over = 0
for p in pairs:
    ns = len(tok.encode(p["system"]))
    nc = len(tok.encode(p["ctx"]))
    nr = len(tok.encode(p["raw"]))
    # 训练序列 = prompt(模板) + assistant + 后缀；这里只看输入侧
    tot = ns + nc + nr
    room = MAXLEN - tot
    verdict = "OK" if room > 0 else "超窗 %d" % (-room)
    if room <= 0:
        over += 1
    print("%-18s %8d %8d %8d %8d %8d   %s" % (p["id"], ns, nc, nr, tot, room, verdict))
print("")
print("超窗 %d / %d 条" % (over, len(pairs)))
print("")
print("=== 对照：训练集里的实际分布（sft-train.jsonl）===")
tr = [json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\sft\train.jsonl", encoding="utf-8") if l.strip()]
lens = []
for r in tr[:200]:
    u = r["user"]
    i = u.index("\n\n[思考过程]\n")
    ctx = u[len("[题面]\n"):i]
    raw = u[i + len("\n\n[思考过程]\n"):]
    lens.append(len(tok.encode(r["system"])) + len(tok.encode(ctx)) + len(tok.encode(raw)))
lens.sort()
def p(q): return lens[int(len(lens) * q)]
print("  n=%d  p10 %d  p50 %d  p90 %d  max %d" % (len(lens), p(.1), p(.5), p(.9), max(lens)))
