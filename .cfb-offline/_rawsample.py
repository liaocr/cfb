
import os, io, json, gzip, glob, random
OUT=io.open(r"D:\cfb\.cfb-offline\_rawsample.txt","w",encoding="utf-8")
ROOT=r"D:\cfb"
pat=os.path.join(ROOT,"transfer","models","micro-generator-v4flash-scenarios","birth-units-census-batch*.jsonl.gz")
recs=[]
for f in sorted(glob.glob(pat)):
    with gzip.open(f,"rt",encoding="utf-8",errors="replace") as fh:
        for l in fh:
            l=l.strip()
            if not l: continue
            try: recs.append(json.loads(l))
            except Exception: pass
random.seed(7)
sel=random.sample(recs,3)
for i,o in enumerate(sel):
    OUT.write("="*80+"\n[%d] unitId=%s birthStep=%s rawChars=%d ctxChars=%d repo=%s\n"%(i,o.get("unitId"),o.get("birthStep"),len(o.get("raw") or ""),len(o.get("ctx") or ""),(o.get("source") or {}).get("repository")))
    OUT.write("--- offlineSignals keys: %s\n"%json.dumps(list((o.get("offlineSignals") or {}).keys()),ensure_ascii=False))
    OUT.write("--- offlineSignals: %s\n"%json.dumps(o.get("offlineSignals"),ensure_ascii=False)[:1500])
    OUT.write("--- notes: %s\n"%json.dumps(o.get("notes"),ensure_ascii=False)[:400])
    OUT.write("--- CTX (first 2000) ---\n"+ (o.get("ctx") or "")[:2000] +"\n")
    OUT.write("--- RAW (full, %d) ---\n"%(len(o.get("raw") or ""))+ (o.get("raw") or "") +"\n")
OUT.close(); print("ok")
