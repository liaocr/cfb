
# -*- coding: utf-8 -*-
# 为什么 4/7 的稿是空的？看完整响应结构。
import io, json, time, urllib.request, urllib.error
ENVF = r"C:\Users\Liaocr\.secrets\keys.env"
env = {}
for l in io.open(ENVF, encoding="utf-8"):
    l=l.strip()
    if l and not l.startswith("#") and "=" in l:
        k,v=l.split("=",1); env[k.strip()]=v.strip()
KEY, BASE, MODEL = env["DEEPSEEK_API_KEY"], env["DEEPSEEK_BASE_URL"], env["DEEPSEEK_MODEL"]
OUT = io.open(r"D:\cfb\.cfb-offline\_stage1b.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")

def call(messages, **kw):
    body = {"model": MODEL, "messages": messages, "temperature": 0.2}
    body.update(kw)
    req = urllib.request.Request(BASE+"/chat/completions", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":"Bearer "+KEY})
    t0=time.time()
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return json.loads(r.read().decode("utf-8","replace")), time.time()-t0, None
    except urllib.error.HTTPError as e:
        return None, time.time()-t0, "HTTP %s %s"%(e.code, e.read()[:400])
    except Exception as e:
        return None, time.time()-t0, repr(e)[:300]

sl=[json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl",encoding="utf-8") if l.strip()]
o=[x for x in sl if x["unitId"]=="adamchainz_apig-wsgi_pr93#b7"][0]
user="[题面]\n"+o["ctx"]+"\n\n[思考过程]\n"+o["raw"]+"\n\n请输出中文压缩稿。"

for label, kw in [("default(max_tokens=1600)", {"max_tokens":1600}),
                  ("max_tokens=8000", {"max_tokens":8000}),
                  ("no-thinking?", {"max_tokens":2000, "reasoning_effort":"minimal"}),
                  ("chat_template_kwargs", {"max_tokens":2000, "chat_template_kwargs":{"enable_thinking":False}})]:
    j, el, err = call([{"role":"user","content":user}], **kw)
    p("=== %s  (%.1fs) ==="%(label,el))
    if err: p("  ERROR", err); continue
    ch=j["choices"][0]; msg=ch["message"]
    rc=msg.get("reasoning_content") or ""
    ct=msg.get("content") or ""
    p("  finish_reason =", ch.get("finish_reason"))
    p("  reasoning_content len =", len(rc))
    p("  content len =", len(ct))
    p("  usage =", json.dumps(j.get("usage"),ensure_ascii=False)[:400])
    if ct: p("  content[:200] =", ct[:200].replace(chr(10)," / "))
    p("")
OUT.close(); print("ok")
