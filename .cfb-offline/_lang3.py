
# -*- coding: utf-8 -*-
import json, pathlib
from collections import Counter
def rd(p): return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]
tr = rd(r"D:\cfb\.cfb-offline\sft\train.jsonl")
dv = rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")
# train 行没有 raw/ctx 字段，得从 user 里按标记切回来（eval-sft.mjs 用的是同一个标记）
MARK = "\n\n[\u601d\u8003\u8fc7\u7a0b]\n"
def split_u(r):
    u = r["user"]
    i = u.index(MARK)
    ctx = u[len("[\u9898\u9762]\n"):i]
    return ctx, u[i+len(MARK):]
for r in tr:
    r["ctx"], r["raw"] = split_u(r)

def cjk(s):
    if not s: return 0.0
    return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/len(s)
def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)]
def lang(s): return "CN" if cjk(s)>0.15 else "EN"

print("=== 语言分布 ===")
for name, rows, key in [("train assistant",tr,"assistant"), ("dev assistant",dv,"assistant"),
                        ("train raw",tr,"raw"), ("dev raw",dv,"raw"),
                        ("train ctx",tr,"ctx"), ("dev ctx",dv,"ctx")]:
    ls=[lang(r[key]) for r in rows]
    print("  %-16s CN %3d / EN %3d   (CJK p50 %.3f)" % (name, ls.count("CN"), ls.count("EN"), q([cjk(r[key]) for r in rows],.5)))
print()
print("=== raw 语言 -> 教师稿语言（train）===")
for (a,b),n in Counter((lang(r["raw"]),lang(r["assistant"])) for r in tr).most_common():
    print("  raw %-2s -> draft %-2s : %3d  (%.0f%%)" % (a,b,n,100*n/len(tr)))
print()
print("=== raw 语言 -> 教师稿语言（dev）===")
for (a,b),n in Counter((lang(r["raw"]),lang(r["assistant"])) for r in dv).most_common():
    print("  raw %-2s -> draft %-2s : %3d  (%.0f%%)" % (a,b,n,100*n/len(dv)))
print()
print("=== 长度 ===")
for k in ["assistant","raw","ctx"]:
    print("  %-10s train p50 %5d | dev p50 %5d" % (k, q([len(r[k]) for r in tr],.5), q([len(r[k]) for r in dv],.5)))
print()
trr=set(r["repo"] for r in tr); dvr=set(r["repo"] for r in dv)
print("=== 泄漏检查：train repos %d · dev repos %d · 交集 %d ===" % (len(trr),len(dvr),len(trr&dvr)))
