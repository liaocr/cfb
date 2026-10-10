
# -*- coding: utf-8 -*-
import json, pathlib
from collections import Counter
def rd(p): return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]
tr = rd(r"D:\cfb\.cfb-offline\sft\train.jsonl")
dv = rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")

def cjk(s):
    if not s: return 0.0
    return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/len(s)
def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)]
def lang(s): return "CN" if cjk(s)>0.15 else "EN"

print("=== 稿子/原文 的语言分布 ===")
for name, rows, key in [("train assistant",tr,"assistant"), ("dev assistant",dv,"assistant"),
                        ("train raw",tr,"raw"), ("dev raw",dv,"raw"), ("train ctx",tr,"ctx")]:
    ls=[lang(r[key]) for r in rows]
    print("  %-16s CN %3d / EN %3d   (CJK p50 %.3f)" % (name, ls.count("CN"), ls.count("EN"), q([cjk(r[key]) for r in rows],.5)))
print()
print("=== 逐条：raw 语言 -> 教师稿语言（train 集）===")
for (a,b),n in Counter((lang(r["raw"]),lang(r["assistant"])) for r in tr).most_common():
    print("  raw %-2s -> draft %-2s : %d" % (a,b,n))
print()
print("=== 长度 ===")
print("  train assistant 字数 p50 %d | dev assistant p50 %d" % (q([len(r['assistant']) for r in tr],.5), q([len(r['assistant']) for r in dv],.5)))
print("  train raw 字数 p50 %d | dev raw p50 %d" % (q([len(r['raw']) for r in tr],.5), q([len(r['raw']) for r in dv],.5)))
print("  train ctx 字数 p50 %d | dev ctx p50 %d" % (q([len(r['ctx']) for r in tr],.5), q([len(r['ctx']) for r in dv],.5)))
print()
print("=== 仓库重叠（泄漏检查）===")
trr=set(r["repo"] for r in tr); dvr=set(r["repo"] for r in dv)
print("  train repos %d · dev repos %d · 交集 %d" % (len(trr),len(dvr),len(trr&dvr)))
