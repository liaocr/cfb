
# -*- coding: utf-8 -*-
"""上一版我把 gen[id]["draft"] 同时当成了教师稿和学生稿 —— 生成文件里只有学生稿。
教师稿在 .cfb-offline/sft/dev.jsonl 的 assistant 字段。这版改正。"""
import pathlib, types, sys, json

src = pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\model\hf_rwkv_tokenizer.py").read_text(encoding="utf-8")
head = src[: src.index("class RwkvTokenizer")]
tf = types.ModuleType("transformers"); tu = types.ModuleType("transformers.tokenization_utils"); tul = types.ModuleType("transformers.utils")
class _Log:
    @staticmethod
    def get_logger(n): return __import__("logging").getLogger(n)
tu.AddedToken = object; tu.PreTrainedTokenizer = object; tul.logging = _Log
tf.tokenization_utils = tu; tf.utils = tul
sys.modules.update({"transformers": tf, "transformers.tokenization_utils": tu, "transformers.utils": tul})
ns = {"__name__": "rwv"}
exec(compile(head, "<rwv>", "exec"), ns)
tk = ns["RWKV_TOKENIZER"](r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\model\rwkv_vocab_v20230424.txt")

def rd(p): return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]
dev = {r["id"]: r for r in rd(r"D:\cfb\.cfb-offline\sft\dev.jsonl")}          # 教师稿在这里
gen = {r["id"]: r for r in rd(r"D:\cfb\.cfb-offline\kaggle-out\rwkv7-compressor\dev-generations.jsonl")}  # 学生稿
rep = json.loads(pathlib.Path(r"D:\cfb\.cfb-offline\kaggle-out\eval-sft.json").read_text(encoding="utf-8"))
rows = rep["rows"]

def q(a,p):
    s=sorted(a); return s[int((len(s)-1)*p)]

ids = [r["id"] for r in rows if r["id"] in gen and r["id"] in dev]
print("配对上的：%d 条" % len(ids))

ident = sum(1 for i in ids if gen[i]["draft"].strip() == dev[i]["assistant"].strip())
print("学生稿与教师稿**逐字相同**的：%d / %d = %.1f%%" % (ident, len(ids), 100*ident/len(ids)))
print("（dev 是按仓库切的，无泄漏；逐字相同只能是学会了照抄，不是背答案）")
print()

st = [len(tk.encode(gen[i]["draft"])[0]) for i in ids]
tt = [len(tk.encode(dev[i]["assistant"])[0]) for i in ids]
print("真 token：教师 p50 %d / 学生 p50 %d" % (q(tt,.5), q(st,.5)))
print("生成 1164 s / %d token -> 实测 %.1f token/s" % (sum(st), sum(st)/1164))
print("（我上轮按 64-token 自检外推的是 2.1 token/s，差 %.0f 倍 —— 那个自检不可信，实测定案）" % ((sum(st)/1164)/2.1))
print()

def show(i, n=520):
    print("=" * 74)
    print("id:", i)
    r = next(x for x in rows if x["id"] == i)
    print("  教师失败:", r["teacherFailed"] or "（无）", "| 学生失败:", r["studentFailed"] or "（无）")
    print("--- 教师稿 %d 字 ---" % len(dev[i]["assistant"])); print(dev[i]["assistant"][:n])
    print("--- 学生稿 %d 字 ---" % len(gen[i]["draft"]));    print(gen[i]["draft"][:n])
    print()

print("### 病灶：教师过 G1 而学生挂 G1（36 条）")
f1 = [r["id"] for r in rows if "G1 quote-grounded" in r["studentFailed"] and "G1 quote-grounded" not in r["teacherFailed"] and r["id"] in gen]
for i in f1[:2]: show(i)

print("### 学生唯一赢的那类：教师只挂 G7（压不够），学生过了")
so = [r["id"] for r in rows if r["studentPass"] and not r["teacherPass"] and r["id"] in gen]
print("共 %d 条，教师失败原因分布：" % len(so),
      {k: sum(1 for r in rows if r["id"] in so and k in r["teacherFailed"]) for k in ["G7 compressed","G1 quote-grounded","G3 anchors-kept","G4 actionable"]})
for i in so[:1]: show(i)