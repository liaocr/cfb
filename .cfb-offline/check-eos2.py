# -*- coding: utf-8 -*-
import io, pathlib
p = pathlib.Path(r"D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt")
raw = p.read_bytes()
txt = raw.decode("utf-8")
lines = txt.split("\n")
print("total lines", len(lines))
for i in list(range(6)) + [65529, 65530, 65531, 65532]:
    if i < len(lines):
        print(i, repr(lines[i]))
print("last line", repr(lines[-1]))

# 贪心最长匹配编码器（RWKV world tokenizer 的做法）
vocab = lines[:65536] if len(lines) >= 65536 else lines
tri = {}
for i, t in enumerate(vocab):
    if not t:
        continue
    node = tri
    for ch in t:
        node = node.setdefault(ch, {})
    node[""] = i

def enc(s):
    out, i, n = [], 0, len(s)
    while i < n:
        node, j, best = tri, i, None
        while j < n and s[j] in node:
            node = node[s[j]]
            j += 1
            if "" in node:
                best = (node[""], j)
        if best is None:
            out.append(("<unk>", s[i]))
            i += 1
        else:
            out.append((best[0], s[i:best[1]]))
            i = best[1]
    return out

print()
for s in ["\n\n", "\n", "\n\n\n", "Assistant: ", "</think>"]:
    print(f"{s!r:16} -> {[(i, t) for i, t in enc(s)]}")

print()
full = "Assistant: 一段压缩稿\n\n"
e = enc(full)
print("full ->", e)
print("末尾 token id:", e[-1][0], " 是不是 65530 ？", e[-1][0] == 65530)
