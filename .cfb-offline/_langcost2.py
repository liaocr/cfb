
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
gen = {json.loads(l)["id"]: json.loads(l) for l in pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\dev-generations.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}

def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')/max(1,len(s))
def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)] if s else 0

print("=== G7 的判据是 draft/raw 的 token 比 <= 0.55（raw 单独，不含 ctx）===")
print("    下面用 **RWKV 真分词器** 数（尺子里用的是 DeepSeek 系数估算，两者会有差）")
print()
for name, rows in [("train 教师稿", tr), ("dev 教师稿", dv)]:
    cn=[r for r in rows if cjk(r["assistant"])>0.15]; en=[r for r in rows if cjk(r["assistant"])<=0.15]
    print("  [%s] 中文 %d / 英文 %d" % (name, len(cn), len(en)))
    for lbl, grp in [("中文稿", cn), ("英文稿", en)]:
        if not grp: continue
        ratio=[nt(r["assistant"])/max(1,nt(r["raw"])) for r in grp]
        print("    %s：token 比 p50 %.3f · p90 %.3f · 过 0.55 的 %d/%d = %.0f%%" %
              (lbl, q(ratio,.5), q(ratio,.9), sum(1 for x in ratio if x<=0.55), len(grp),
               100*sum(1 for x in ratio if x<=0.55)/len(grp)))
    print()
print("=== dev 上 学生 vs 教师，按语言分 ===")
for who, f in [("教师", lambda r: r["assistant"]), ("学生", lambda r: gen[r["id"]]["draft"])]:
    cn=[r for r in dv if cjk(f(r))>0.15]; en=[r for r in dv if cjk(f(r))<=0.15]
    rc=[nt(f(r))/max(1,nt(r["raw"])) for r in cn]; re_=[nt(f(r))/max(1,nt(r["raw"])) for r in en]
    print("  %s：中文稿 %d 条 token 比 p50 %.3f | 英文稿 %d 条 p50 %.3f" %
          (who, len(cn), q(rc,.5), len(en), q(re_,.5)))
print()
print("=== 教师的 G7 失败到底出在哪 ===")
bad=[r for r in dv if nt(r["assistant"])/max(1,nt(r["raw"]))>0.55]
print("  dev 教师稿按 RWKV 真 token 比 >0.55 的：%d/89" % len(bad))
print("  其中中文 %d · 英文 %d" % (sum(1 for r in bad if cjk(r["assistant"])>0.15), sum(1 for r in bad if cjk(r["assistant"])<=0.15)))
print("  （尺子报的是 38/89 —— 差异来自 estimateTokens 与 RWKV 分词器的口径不同）")
