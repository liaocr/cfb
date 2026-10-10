
import os, io, json, glob, gzip
ROOT=r"D:\cfb"
os.makedirs(os.path.join(ROOT,".cfb-offline","ruler"), exist_ok=True)

# 1) hand samples -> pairs
seen=set(); out=[]
for f in sorted(glob.glob(os.path.join(ROOT,".cfb-runtime","**","hand-samples.jsonl"),recursive=True)):
    for l in io.open(f,encoding="utf-8",errors="replace"):
        l=l.strip()
        if not l: continue
        try: o=json.loads(l)
        except Exception: continue
        if not (o.get("raw") and o.get("draft")): continue
        key=(str(o.get("id")), len(o.get("raw") or ""), len(o.get("draft") or ""))
        if key in seen: continue
        seen.add(key)
        out.append({"id":"hand:"+str(o.get("id")), "raw":o.get("raw"), "ctx":o.get("ctx"),
                    "draft":o.get("draft"), "family":str(o.get("id","")).rsplit("-s",1)[0],
                    "trainingEligible":o.get("trainingEligible")})
with io.open(os.path.join(ROOT,".cfb-offline","ruler","pairs-hand.jsonl"),"w",encoding="utf-8") as fh:
    for o in out: fh.write(json.dumps(o,ensure_ascii=False)+"\n")
print("hand pairs", len(out))

# 2) v5 corpus -> pairs (sample 400)
vf=os.path.join(ROOT,"transfer","models","micro-generator-gen-v5","train.jsonl.gz")
n=0
with io.open(os.path.join(ROOT,".cfb-offline","ruler","pairs-v5.jsonl"),"w",encoding="utf-8") as fh:
    with gzip.open(vf,"rt",encoding="utf-8",errors="replace") as g:
        for l in g:
            l=l.strip()
            if not l: continue
            try: o=json.loads(l)
            except Exception: continue
            ms=o.get("messages") or []
            usr=[m for m in ms if m.get("role")=="user"]
            ast=[m for m in ms if m.get("role")=="assistant"]
            if not usr or not ast: continue
            fh.write(json.dumps({"id":"v5:"+str(o.get("unitId")), "raw":usr[-1].get("content",""), "ctx":"", "draft":ast[-1].get("content",""), "family":"v5"},ensure_ascii=False)+"\n")
            n+=1
            if n>=400: break
print("v5 pairs", n)

# 3) export/ gold-ish pairs
for nm in ["train","test","selection"]:
    fp=os.path.join(ROOT,".cfb-offline","train","export",nm+".jsonl")
    if not os.path.exists(fp): continue
    cnt=0
    with io.open(os.path.join(ROOT,".cfb-offline","ruler","pairs-export-"+nm+".jsonl"),"w",encoding="utf-8") as fh:
        for l in io.open(fp,encoding="utf-8",errors="replace"):
            l=l.strip()
            if not l: continue
            try: o=json.loads(l)
            except Exception: continue
            ms=o.get("messages") or []
            usr=[m for m in ms if m.get("role")=="user"]; ast=[m for m in ms if m.get("role")=="assistant"]
            if not usr or not ast: continue
            fh.write(json.dumps({"id":"exp-"+nm+":"+str(o.get("id") or cnt), "raw":usr[-1].get("content",""), "ctx":"", "draft":ast[-1].get("content",""), "family":"export-"+nm},ensure_ascii=False)+"\n")
            cnt+=1
    print("export",nm,cnt)
