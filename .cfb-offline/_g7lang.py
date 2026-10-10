
# -*- coding: utf-8 -*-
import json, pathlib
rep = json.loads(pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\eval-sft.json").read_text(encoding="utf-8"))
rows = rep["rows"]
def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/max(1,len(s))

# 教师稿在 dev.jsonl
dv = {json.loads(l)["id"]: json.loads(l) for l in pathlib.Path(r"D:\cfb\.cfb-offline\sft\dev.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}

g7t = [r for r in rows if "G7 compressed" in r["teacherFailed"]]
print("=== 尺子自己判的：教师 G7 挂 %d 条 ===" % len(g7t))
cn = sum(1 for r in g7t if cjk(dv[r["id"]]["assistant"])>0.15)
print("    其中中文稿 %d 条 · 英文稿 %d 条" % (cn, len(g7t)-cn))
print("    dev 全体：中文稿 %d 条 · 英文稿 %d 条" % (
    sum(1 for r in rows if cjk(dv[r["id"]]["assistant"])>0.15),
    sum(1 for r in rows if cjk(dv[r["id"]]["assistant"])<=0.15)))
print()
print("=== 换个说法：各语言的 G7 通过率（尺子口径）===")
for lbl, f in [("中文稿", lambda r: cjk(dv[r["id"]]["assistant"])>0.15),
               ("英文稿", lambda r: cjk(dv[r["id"]]["assistant"])<=0.15)]:
    g=[r for r in rows if f(r)]
    ok=sum(1 for r in g if "G7 compressed" not in r["teacherFailed"])
    print("    %s：G7 过 %d/%d = %.0f%%" % (lbl, ok, len(g), 100*ok/len(g)))
print()
print("=== 如果教师按提示词全用英文，教师总分能到多少（上界估计）===")
# 把中文稿的 G7 失败换成英文稿的通过率来粗估
cn_rows=[r for r in rows if cjk(dv[r["id"]]["assistant"])>0.15]
en_rows=[r for r in rows if cjk(dv[r["id"]]["assistant"])<=0.15]
en_g7_pass = sum(1 for r in en_rows if "G7 compressed" not in r["teacherFailed"])/max(1,len(en_rows))
# 中文稿里，除 G7 外全过的那些，如果 G7 也过了就翻盘
flip = sum(1 for r in cn_rows if r["teacherFailed"]==["G7 compressed"])
print("    中文稿 %d 条；英文稿 G7 通过率 %.0f%%" % (len(cn_rows), 100*en_g7_pass))
print("    中文稿里「只挂 G7」的 %d 条 —— 若 G7 也过，教师从 %d/%d 涨到 %d/%d = %.1f%%" % (
    flip, rep["teacher"]["pass"], rep["n"], rep["teacher"]["pass"]+flip, rep["n"],
    100*(rep["teacher"]["pass"]+flip)/rep["n"]))
