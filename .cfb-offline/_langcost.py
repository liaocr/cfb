
# -*- coding: utf-8 -*-
import pathlib, types, sys, json
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
def nt(s): return len(tk.encode(s)[0])

def rd(p): return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]
MARK = "\n\n[\u601d\u8003\u8fc7\u7a0b]\n"
tr = rd(r"D:\cfb\.cfb-offline\sft\train.jsonl")
for r in tr:
    u=r["user"]; i=u.index(MARK); r["ctx"]=u[4:i]; r["raw"]=u[i+len(MARK):]
dv = rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")

def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/max(1,len(s))
def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)] if s else 0

print("=== 提示词第 3 行：用原文的语言写，翻译会把 token 数改回去 ===")
print("    原文 raw 是 100% 英文；教师稿 76% 中文 —— 教师违反了自己的指令。")
print("    违反的代价（用 RWKV 真分词器数）：")
print()
for name, rows in [("train", tr), ("dev", dv)]:
    cn = [r for r in rows if cjk(r["assistant"])>0.15]
    en = [r for r in rows if cjk(r["assistant"])<=0.15]
    print("  [%s] 中文稿 %d 条 / 英文稿 %d 条" % (name, len(cn), len(en)))
    for lbl, grp in [("中文稿", cn), ("英文稿", en)]:
        if not grp: continue
        rt=[nt(r["raw"])+nt(r["ctx"]) for r in grp]
        dt=[nt(r["assistant"]) for r in grp]
        ratio=[d/max(1,t) for d,t in zip(dt,rt)]
        print("    %s：draft token p50 %4d · 比 p50 %.3f · 过 G7(<=0.55) %d/%d = %.0f%%" %
              (lbl, q(dt,.5), q(ratio,.5), sum(1 for x in ratio if x<=0.55), len(grp),
               100*sum(1 for x in ratio if x<=0.55)/len(grp)))
    print()
print("=== 结论 ===")
cn=[r for r in dv if cjk(r["assistant"])>0.15]; en=[r for r in dv if cjk(r["assistant"])<=0.15]
rc=[nt(r["assistant"])/max(1,nt(r["raw"])+nt(r["ctx"])) for r in cn]
re_=[nt(r["assistant"])/max(1,nt(r["raw"])+nt(r["ctx"])) for r in en]
print("  dev 中文稿 token 比 p50 %.3f · 英文稿 p50 %.3f -> 中文贵 %.2f 倍" % (q(rc,.5), q(re_,.5), q(rc,.5)/max(1e-9,q(re_,.5))))
print("  教师 G7 挂 38/89，其中中文稿挂 %d 条、英文稿挂 %d 条" %
      (sum(1 for r in cn if nt(r["assistant"])/max(1,nt(r["raw"])+nt(r["ctx"]))>0.55),
       sum(1 for r in en if nt(r["assistant"])/max(1,nt(r["raw"])+nt(r["ctx"]))>0.55)))
