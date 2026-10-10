
# -*- coding: utf-8 -*-
# 检查词表里有没有多字中文词（决定「每汉字 1 token」是不是上限）
import io
exec(open(r"D:\cfb\.cfb-offline\_stage0.py", encoding="utf-8").read().split("TK = RWKV_TOKENIZER")[0])
TK = RWKV_TOKENIZER(r"D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt")
multi=[]
for i,b in TK.idx2token.items():
    try: s=b.decode("utf-8")
    except Exception: continue
    if len(s)>=2 and all('\u4e00'<=c<='\u9fff' for c in s):
        multi.append(s)
print("多字纯中文 token 数 =", len(multi))
print("样例 =", multi[:40])
for w in ["已落定","落点","验收","因为","所以","问题","修改","测试","函数","原文"]:
    print("  %-6s -> %d tok" % (w, len(TK.encode(w))))
