
# -*- coding: utf-8 -*-
import io, json, collections
exec(open(r"D:\cfb\.cfb-offline\_stage0.py", encoding="utf-8").read().split("TK = RWKV_TOKENIZER")[0])
TK = RWKV_TOKENIZER(r"D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt")
OUT = io.open(r"D:\cfb\.cfb-offline\_stage0b.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")

# ── 1. 修正 C 段那个算错的窗口估算
p("=== 1. 修正：每稿真实 token 数 ===")
pairs=[json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\pairs-hand.jsonl",encoding="utf-8") if l.strip()]
dl=[len(TK.encode(o["draft"])) for o in pairs if o.get("draft")]
dl.sort()
p("  稿 token 数：min=%d med=%d p90=%d max=%d  （上一步我把中位稿乘了 4，是错的）"%(dl[0],dl[len(dl)//2],dl[int(len(dl)*0.9)],dl[-1]))
sl=[json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl",encoding="utf-8") if l.strip()]
rt=sorted(len(TK.encode(o["raw"])) for o in sl)
p("  全部 %d 条 raw token：min=%d med=%d p90=%d max=%d"%(len(rt),rt[0],rt[len(rt)//2],rt[int(len(rt)*0.9)],rt[-1]))
p("  raw 超 2048 的：%d / %d"%(sum(1 for x in rt if x>2048),len(rt)))
med=rt[len(rt)//2]+dl[len(dl)//2]
p("  中位 输入+输出 = %d + %d = %d  tok => %s"%(rt[len(rt)//2],dl[len(dl)//2],med,"塞得进 2048" if med<2048 else "塞不进"))

# ── 2. 关键：每个汉字单独要几个 token
p("")
p("=== 2. 汉字覆盖（决定性读数）===")
txt="".join(o["draft"] for o in pairs if o.get("draft"))
chars=collections.Counter(c for c in txt if '\u4e00'<=c<='\u9fff')
p("  稿中不同汉字数 =",len(chars)," 总汉字 =",sum(chars.values()))
cost={}
for ch in chars:
    cost[ch]=len(TK.encode(ch))
dist=collections.Counter(cost.values())
p("  单字 token 成本分布：",dict(sorted(dist.items())))
one=sum(n for c,n in chars.items() if cost[c]==1)
p("  1-token 汉字占比 = %.1f%%（按出现次数）"%(100.0*one/sum(chars.values())))
p("  最常见的 25 个汉字及其成本：")
for ch,n in chars.most_common(25):
    p("     %s x%-4d -> %d tok"%(ch,n,cost[ch]))

# ── 3. 全局：常用汉字在词表里的覆盖
p("")
p("=== 3. 常用汉字覆盖（3500 常用字表，若词表缺则退化成 3 字节 = 3 token）===")
common = [chr(c) for c in range(0x4e00,0x9fa6)]
inb=sum(1 for c in common if len(TK.encode(c))==1)
p("  CJK 统一表意区 U+4E00..U+9FA5 共 %d 字，词表单字覆盖 %d (%.1f%%)"%(len(common),inb,100.0*inb/len(common)))

# ── 4. 英文/代码侧
p("")
p("=== 4. 输入侧构成 ===")
allraw="".join(o["raw"] for o in sl[:200])
p("  raw: chars=%d tokens=%d chars/tok=%.2f"%(len(allraw),len(TK.encode(allraw)),len(allraw)/len(TK.encode(allraw))))
OUT.close(); print("ok")
