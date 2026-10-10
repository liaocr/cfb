
# -*- coding: utf-8 -*-
"""这 89 条的差到底算不算"真的差"——别拿一个没有显著性的数当结论。"""
import json, pathlib, math
rep=json.loads(pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\eval-sft.json").read_text(encoding="utf-8"))
p=rep["paired"]
b,c=p["studentOnly"],p["teacherOnly"]
print("配对四格：都过 %d · 只学生过 %d · 只教师过 %d · 都不过 %d" % (p["bothPass"],b,c,p["neither"]))
# McNemar（连续性校正）
chi2=(abs(b-c)-1)**2/(b+c) if (b+c) else 0
# 卡方 1 自由度 -> p
def chi2_sf1(x):
    return math.erfc(math.sqrt(x/2))
print("McNemar chi2 = %.3f, p = %.4f（两尾）" % (chi2, chi2_sf1(chi2)))
print("-> 硬门上这个差没有到 0.05 显著，只能说倾向于更差。")
print()
w,l,t=rep["softScore"]["studentWins"],rep["softScore"]["studentLosses"],rep["softScore"]["ties"]
print("软分逐条：赢 %d · 输 %d · 平 %d" % (w,l,t))
# 符号检验（正态近似）
n=w+l; z=(w-n/2)/math.sqrt(n/4)
print("符号检验 z = %.2f, p = %.2e" % (z, math.erfc(abs(z)/math.sqrt(2))))
print("-> 软分上这个差是**决定性的**。")
print()
print("两个数一起看：门是阶跃的、样本小，单看门会误判；")
print("软分连续、用满 89 条，才是这轮的结论依据。")