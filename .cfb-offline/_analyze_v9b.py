
# -*- coding: utf-8 -*-
import pathlib, types, sys, json, re, collections

src = pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\model\hf_rwkv_tokenizer.py").read_text(encoding="utf-8")
head = src[: src.index("class RwkvTokenizer")]
tf=types.ModuleType("transformers"); tu=types.ModuleType("transformers.tokenization_utils"); tul=types.ModuleType("transformers.utils")
class _L:
    @staticmethod
    def get_logger(n): return __import__("logging").getLogger(n)
tu.AddedToken=object; tu.PreTrainedTokenizer=object; tul.logging=_L
tf.tokenization_utils=tu; tf.utils=tul
sys.modules.update({"transformers":tf,"transformers.tokenization_utils":tu,"transformers.utils":tul})
ns={"__name__":"rwv"}; exec(compile(head,"<rwv>","exec"),ns)
tk=ns["RWKV_TOKENIZER"](r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\model\rwkv_vocab_v20230424.txt")

def rd(p): return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]
dev={r["id"]:r for r in rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")}
gen={r["id"]:r for r in rd(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\dev-generations.jsonl")}
ids=[i for i in dev if i in gen]
def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)]

def cjk(s):
    if not s: return 0.0
    n=sum(1 for c in s if '\u4e00'<=c<='\u9fff')
    return n/len(s)

print("### 1. 语言：提示词要求「用原文本来的语言写」")
print("    教师稿 CJK 占比 p50 %.3f | 学生稿 p50 %.3f" % (q([cjk(dev[i]['assistant']) for i in ids],.5), q([cjk(gen[i]['draft']) for i in ids],.5)))
zh_t=sum(1 for i in ids if cjk(dev[i]['assistant'])>0.15); zh_s=sum(1 for i in ids if cjk(gen[i]['draft'])>0.15)
print("    以中文为主的稿：教师 %d/%d · 学生 %d/%d" % (zh_t,len(ids),zh_s,len(ids)))
flip=[i for i in ids if (cjk(dev[i]['assistant'])>0.15) != (cjk(gen[i]['draft'])>0.15)]
print("    **语言跟教师不一致的：%d/%d = %.0f%%**" % (len(flip),len(ids),100*len(flip)/len(ids)))
print()

print("### 2. 退化：学生是不是在吐重复/无意义串")
def rep_score(s):
    """最长重复子串占比（粗糙但够用）"""
    if len(s)<40: return 0.0
    best=0
    for L in (12,20,30):
        seen={}
        for j in range(len(s)-L):
            g=s[j:j+L]
            seen[g]=seen.get(g,0)+1
        if seen: best=max(best, max(seen.values()))
    return best
print("    重复片段峰值 p50：教师 %.1f | 学生 %.1f（>=3 视为明显复读）" %
      (q([rep_score(dev[i]['assistant']) for i in ids],.5), q([rep_score(gen[i]['draft']) for i in ids],.5)))
loopy=[i for i in ids if rep_score(gen[i]['draft'])>=3]
print("    学生明显复读的：%d 条" % len(loopy))
print()

print("### 3. 撞 max_new=768 上限（=没吐 EOS）")
hit=[i for i in ids if len(tk.encode(gen[i]['draft'])[0])>=760]
print("    %d/%d 条撞上限" % (len(hit),len(ids)))
print("    教师稿真 token p90 %d max %d（对比：教师最长也才这么长）" % (q([len(tk.encode(dev[i]['assistant'])[0]) for i in ids],.9), max(len(tk.encode(dev[i]['assistant'])[0]) for i in ids)))
print()

print("### 4. 学生赢的 10 条，长什么样")
rep=json.loads(pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\eval-sft.json").read_text(encoding="utf-8"))
rows={r["id"]:r for r in rep["rows"]}
so=[i for i in ids if rows[i]["studentPass"] and not rows[i]["teacherPass"]]
for i in so[:3]:
    print("  --- %s ---" % i)
    print("  学生稿(%d字): %s" % (len(gen[i]['draft']), gen[i]['draft'][:230].replace(chr(10),' ')))
print()
print("### 5. 学生输得最惨的：软分差最大")
d=sorted(ids, key=lambda i: rows[i]["studentScore"]-rows[i]["teacherScore"])
for i in d[:2]:
    print("  --- %s  学生软分 %.3f vs 教师 %.3f ---" % (i, rows[i]["studentScore"], rows[i]["teacherScore"]))
    print("  教师(%d字): %s" % (len(dev[i]['assistant']), dev[i]['assistant'][:230].replace(chr(10),' ')))
    print("  学生(%d字): %s" % (len(gen[i]['draft']), gen[i]['draft'][:230].replace(chr(10),' ')))
    print()
