
# -*- coding: utf-8 -*-
import json, pathlib
rep = json.loads(pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\eval-sft.json").read_text(encoding="utf-8"))
rows = {r["id"]: r for r in rep["rows"]}
dv = {json.loads(l)["id"]: json.loads(l) for l in pathlib.Path(r"D:\cfb\.cfb-offline\sft\dev.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}
gen = {json.loads(l)["id"]: json.loads(l) for l in pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\dev-generations.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}
def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/max(1,len(s))

print("=== 学生在自己写英文的那些稿上，是不是更容易挂 G1 ===")
for who, f in [("教师", lambda i: dv[i]["assistant"]), ("学生", lambda i: gen[i]["draft"])]:
    print("  [%s]" % who)
    for lbl, pred in [("中文稿", lambda i: cjk(f(i))>0.15), ("英文稿", lambda i: cjk(f(i))<=0.15)]:
        g=[i for i in rows if pred(i)]
        g1=sum(1 for i in g if "G1 quote-grounded" in rows[i][("teacherFailed" if who=="教师" else "studentFailed")])
        print("    %s %3d 条 -> G1 挂 %2d = %.0f%%" % (lbl, len(g), g1, 100*g1/max(1,len(g))))
print()
print("=== 学生 vs 教师的语言是否一致（同一单元）===")
same=sum(1 for i in rows if (cjk(dv[i]["assistant"])>0.15)==(cjk(gen[i]["draft"])>0.15))
print("  语言一致的 %d/%d = %.0f%%" % (same, len(rows), 100*same/len(rows)))
print("  教师中文->学生英文 %d 条；教师英文->学生中文 %d 条" % (
    sum(1 for i in rows if cjk(dv[i]["assistant"])>0.15 and cjk(gen[i]["draft"])<=0.15),
    sum(1 for i in rows if cjk(dv[i]["assistant"])<=0.15 and cjk(gen[i]["draft"])>0.15)))
print()
print("=== 语言一致的那批，学生成绩如何 ===")
for lbl, pred in [("语言一致", lambda i: (cjk(dv[i]["assistant"])>0.15)==(cjk(gen[i]["draft"])>0.15)),
                  ("语言翻转", lambda i: (cjk(dv[i]["assistant"])>0.15)!=(cjk(gen[i]["draft"])>0.15))]:
    g=[i for i in rows if pred(i)]
    sp=sum(1 for i in g if rows[i]["studentPass"]); tp=sum(1 for i in g if rows[i]["teacherPass"])
    print("  %s %d 条：学生过 %d/%d=%.0f%% · 教师过 %d/%d=%.0f%%" %
          (lbl, len(g), sp, len(g), 100*sp/max(1,len(g)), tp, len(g), 100*tp/max(1,len(g))))
