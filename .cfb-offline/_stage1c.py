
# -*- coding: utf-8 -*-
# Stage 1（修正版）：max_tokens 放宽到 8000 + 失败重试。跑 20 条，量过尺率与花费。
import io, json, os, time, urllib.request, urllib.error
ENVF = r"C:\Users\Liaocr\.secrets\keys.env"
env={}
for l in io.open(ENVF,encoding="utf-8"):
    l=l.strip()
    if l and not l.startswith("#") and "=" in l:
        k,v=l.split("=",1); env[k.strip()]=v.strip()
KEY,BASE,MODEL=env["DEEPSEEK_API_KEY"],env["DEEPSEEK_BASE_URL"],env["DEEPSEEK_MODEL"]
OUT=io.open(r"D:\cfb\.cfb-offline\_stage1c.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
F=io.open(r"D:\cfb\.cfb-offline\_stage1_drafts.jsonl","w",encoding="utf-8")

SYSTEM = """你是思维链压缩器。用户给你一次真实软件工程任务的题面，以及当时模型写下的完整思考过程（英文）。
请把那段思考压成一份**中文压缩稿**，供后续模型直接阅读以继续任务。

硬要求：
1) 保留所有承重的事实、结论、决定、落点、验收依据；删掉探索过程、重复、已被推翻的猜测。
2) 引用原文时必须是**真的逐字**，用「」包裹；不确定是否逐字就改写、不要加引号。
3) 必须写清「落点」——要动手改的那个文件路径，且必须是原文里确实在讨论要改的那个文件；不要用报错信息里出现的路径充数。
4) 不许编造原文与题面里都没有的文件名、命令、标识符、数字。
5) 长度不超过原文的 55%。

直接输出压缩稿，不要前言、不要解释。"""

def call(messages, max_tokens=8000, tries=4):
    body={"model":MODEL,"messages":messages,"max_tokens":max_tokens,"temperature":0.2}
    last=None
    for a in range(tries):
        req=urllib.request.Request(BASE+"/chat/completions",data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type":"application/json","Authorization":"Bearer "+KEY})
        t0=time.time()
        try:
            with urllib.request.urlopen(req,timeout=300) as r:
                return json.loads(r.read().decode("utf-8","replace")), time.time()-t0, None
        except urllib.error.HTTPError as e:
            last="HTTP %s %s"%(e.code,e.read()[:200]); 
        except Exception as e:
            last=repr(e)[:160]
        time.sleep(1.5*(a+1))
    return None,0,last

sl=[json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl",encoding="utf-8") if l.strip()]
seen=set(); picks=[]
for o in sl:
    if o["repository"] in seen: continue
    if not (1800<=o["rawChars"]<=6000): continue
    seen.add(o["repository"]); picks.append(o)
    if len(picks)>=20: break

p("单元数 =",len(picks))
res=[]; cost=0.0; tok=0; trunc=0; t0=time.time()
for i,o in enumerate(picks,1):
    user="[题面]\n"+o["ctx"]+"\n\n[思考过程]\n"+o["raw"]+"\n\n请输出中文压缩稿。"
    j,el,err=call([{"role":"system","content":SYSTEM},{"role":"user","content":user}])
    if err: p("[%2d] ERROR %s | %s"%(i,o["unitId"][:40],err)); continue
    ch=j["choices"][0]; msg=ch["message"]
    d=(msg.get("content") or "").strip()
    u=j.get("usage") or {}
    cost+=u.get("cost",0) or 0; tok+=u.get("total_tokens",0)
    if ch.get("finish_reason")=="length": trunc+=1
    res.append({"id":o["unitId"],"family":o["repository"],"raw":o["raw"],"ctx":o["ctx"],"draft":d})
    F.write(json.dumps(res[-1],ensure_ascii=False)+"\n")
    p("[%2d] %-40s %5.1fs raw=%d draft=%d ratio=%.2f finish=%s"%(i,o["unitId"][:40],el,len(o["raw"]),len(d),len(d)/max(1,len(o["raw"])),ch.get("finish_reason")))
p("")
p("=== 合计 ===")
p("  成功 %d  截断 %d  用时 %.0fs  token %d  报告花费 $%.6f"%(len(res),trunc,time.time()-t0,tok,cost))
if res:
    per=cost/len(res)
    p("  单条报告花费 $%.6f" % per)
    # 按官方 DeepSeek 价（输入 $0.28/M、输出 $0.42/M）保守估
    inp=sum(len(o["ctx"])+len(o["raw"]) for o in picks[:len(res)])/3.5
    out=tok-inp
    est=inp*0.28e-6+out*0.42e-6
    p("  按官方价保守估：输入≈%.0f tok 输出≈%.0f tok => 单条 $%.6f，3000 条 $%.2f"%(inp,out,est/len(res),est/len(res)*3000))
OUT.close(); F.close(); print("ok")
