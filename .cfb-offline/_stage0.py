
# -*- coding: utf-8 -*-
# Stage 0 风险探针（$0）：RWKV7 底座对「英文思维链输入 + 中文压缩稿输出」的 token 效率。
# tokenizer 算法逐字取自 .cfb-offline/rwkv7/hf_rwkv_tokenizer.py（去掉 transformers 依赖）。
import io, json, os, sys

class TRIE:
    __slots__ = tuple("ch,to,values,front".split(","))
    def __init__(self, front=None, ch=None):
        self.ch = ch
        self.to = [None for ch in range(256)]
        self.values = set()
        self.front = front
    def add(self, key: bytes, idx: int = 0, val=None):
        if idx == len(key):
            if val is None: val = key
            self.values.add(val)
            return self
        ch = key[idx]
        if self.to[ch] is None: self.to[ch] = TRIE(front=self, ch=ch)
        return self.to[ch].add(key, idx=idx + 1, val=val)
    def find_longest(self, key: bytes, idx: int = 0):
        u = self
        ch = key[idx]
        ret = None
        while u.to[ch] is not None:
            u = u.to[ch]
            idx += 1
            if u.values: ret = idx, u, u.values
            if idx == len(key): break
            ch = key[idx]
        return ret

class RWKV_TOKENIZER:
    def __init__(self, file_name):
        self.idx2token = {}
        sorted_ = []
        with open(file_name, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for l in lines:
            idx = int(l[: l.index(" ")])
            x = eval(l[l.index(" ") : l.rindex(" ")])
            x = x.encode("utf-8") if isinstance(x, str) else x
            assert isinstance(x, bytes)
            assert len(x) == int(l[l.rindex(" ") :])
            sorted_ += [x]
            self.idx2token[idx] = x
        self.token2idx = {}
        for k, v in self.idx2token.items():
            self.token2idx[v] = int(k)
        self.root = TRIE()
        for t, i in self.token2idx.items():
            self.root.add(t, val=(t, i))
    def encodeBytes(self, src: bytes):
        idx = 0
        tokens = []
        while idx < len(src):
            _idx = idx
            r = self.root.find_longest(src, idx)
            assert r is not None, "no token at %d" % idx
            idx, _, values = r
            assert idx != _idx
            _, token = next(iter(values))
            tokens.append(token)
        return tokens
    def encode(self, src):
        if isinstance(src, str):
            return self.encodeBytes(src.encode("utf-8"))
        return [self.encodeBytes(s.encode("utf-8")) for s in src]

TK = RWKV_TOKENIZER(r"D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt")
OUT = io.open(r"D:\cfb\.cfb-offline\_stage0.txt", "w", encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a) + "\n")

p("vocab size =", len(TK.idx2token))

# ── 词表中文覆盖
cjk_tokens = 0
for i, b in TK.idx2token.items():
    try: s = b.decode("utf-8")
    except Exception: continue
    if len(s) == 1 and '\u4e00' <= s <= '\u9fff': cjk_tokens += 1
p("单字中文 token 数 =", cjk_tokens)

def stats(text, label):
    n_chars = len(text)
    toks = TK.encode(text)
    n_tok = len(toks)
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    nonascii = sum(1 for c in text if ord(c) > 127)
    p("  %-22s chars=%-7d tokens=%-7d chars/tok=%.2f  CJK=%d (%.0f%%)  非ASCII=%d" % (
        label, n_chars, n_tok, n_chars / max(1, n_tok), cjk, 100.0 * cjk / max(1, n_chars), nonascii))
    return n_chars, n_tok, cjk

# ── 真实数据：中文稿（输出侧）+ 英文思维链（输入侧）
p("")
p("=== A. 输出侧：真实中文压缩稿（transfer/gold + hand samples）===")
pairs = [json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\pairs-hand.jsonl", encoding="utf-8") if l.strip()]
drafts = [o["draft"] for o in pairs if o.get("draft")]
p("  稿数 =", len(drafts))
cn_chars = cn_tok = cn_cjk = 0
for d in drafts:
    c, t, j = stats(d, "draft(%d字)" % len(d)) if False else (len(d), len(TK.encode(d)), sum(1 for x in d if '\u4e00' <= x <= '\u9fff'))
    cn_chars += c; cn_tok += t; cn_cjk += j
p("  合计：chars=%d tokens=%d  chars/tok=%.2f  CJK=%d  每汉字 token=%.3f" % (
    cn_chars, cn_tok, cn_chars / max(1, cn_tok), cn_cjk, cn_tok / max(1, cn_cjk)))

p("")
p("=== B. 输入侧：raw 英文思维链（raw-mine-shortlist）===")
sl = [json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl", encoding="utf-8") if l.strip()][:200]
en_chars = en_tok = 0
per = []
for o in sl:
    r = o.get("raw") or ""
    t = len(TK.encode(r))
    en_chars += len(r); en_tok += t
    per.append(t)
p("  条数 =", len(sl))
p("  合计：chars=%d tokens=%d  chars/tok=%.2f" % (en_chars, en_tok, en_chars / max(1, en_tok)))
per.sort()
p("  每单元 raw token 数：min=%d med=%d p90=%d max=%d" % (per[0], per[len(per)//2], per[int(len(per)*0.9)], per[-1]))

# ── 窗口可行性：raw(输入) + 中文稿(输出) 是否塞得进 2048
p("")
p("=== C. 2048 窗口可行性 ===")
over = sum(1 for x in per if x > 2048)
p("  raw 单独超 2048 的单元：%d / %d" % (over, len(per)))
# 取中位单元，算 输入+输出 总 token
med_raw_tok = per[len(per)//2]
med_out_tok = int(cn_tok / max(1, len(drafts)) * 4)  # 稿约 400 字 -> 估
p("  中位 raw = %d tok；中位稿 ~%d tok；合计 ~%d" % (med_raw_tok, med_out_tok, med_raw_tok + med_out_tok))
p("  => 结论：%s" % ("塞不进 2048，需要截断或分段" if med_raw_tok + med_out_tok > 2048 else "塞得进 2048"))

# ── 对比基线：中文常用字覆盖率
p("")
p("=== D. 抽样：同一个中文句子的切分（看是否按词切） ===")
for s in ["落点：test/birth.selftest.mjs（只动这一处；其余路径不动）",
          "已落定的决定（原文逐字）：「The test should use DSH_HOME」",
          "验收：跑 node verify.mjs。若不再报 原判定失败 ⇒ 判这条修好。"]:
    toks = TK.encode(s)
    p("  %r" % s)
    p("     %d chars -> %d tokens (%.2f)" % (len(s), len(toks), len(s)/len(toks)))
OUT.close(); print("ok")
