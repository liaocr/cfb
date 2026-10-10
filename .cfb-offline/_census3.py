
import os, io, json, glob, collections
OUT=io.open(r"D:\cfb\.cfb-offline\_census3.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
ROOT=r"D:\cfb"
def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')

# ---- hand-samples aggregate ----
rows=[]
for f in glob.glob(os.path.join(ROOT,".cfb-runtime","**","hand-samples.jsonl"),recursive=True):
    for l in io.open(f,encoding="utf-8",errors="replace"):
        l=l.strip()
        if not l: continue
        try: o=json.loads(l)
        except Exception: continue
        o["_src"]=os.path.relpath(f,ROOT)
        rows.append(o)
p("hand-samples total=%d from %d files"%(len(rows), len(set(r["_src"] for r in rows))))
te=collections.Counter(str(r.get("trainingEligible")) for r in rows)
p("trainingEligible:", dict(te))
gv=collections.Counter()
for r in rows:
    g=r.get("gate") or {}
    for v in (g.get("violations") or []):
        gv[str(v)[:60]] += 1
    if g.get("ok"): gv["<ok>"] += 1
p("gate violations:", dict(gv.most_common(15)))
qa=collections.Counter()
for r in rows:
    q=r.get("qualityAudit") or {}
    qa[str(q.get("status"))] += 1
p("qualityAudit.status:", dict(qa))
p("unique id=%d  unique task=%d"%(len(set(r.get("id") for r in rows)), len(set(str(r.get("task")) for r in rows))))
def pct(xs,q):
    xs=sorted(xs); return xs[min(len(xs)-1,int(len(xs)*q))] if xs else 0
rl=[len(r.get("raw") or "") for r in rows]
dl=[len(r.get("draft") or "") for r in rows]
sl=[len(r.get("stored") or "") for r in rows]
p("raw len med=%d p90=%d max=%d"%(pct(rl,.5),pct(rl,.9),max(rl)))
p("draft len med=%d p90=%d max=%d"%(pct(dl,.5),pct(dl,.9),max(dl)))
p("stored len med=%d p90=%d max=%d"%(pct(sl,.5),pct(sl,.9),max(sl)))
p("ratio draft/raw med=%.3f"%(pct([d/max(1,r) for d,r in zip(dl,rl)],.5)))
rc=[cjk(r.get("raw") or "")/max(1,len(r.get("raw") or "")) for r in rows]
dc=[cjk(r.get("draft") or "")/max(1,len(r.get("draft") or "")) for r in rows]
p("raw cjk ratio mean=%.4f  draft cjk ratio mean=%.4f"%(sum(rc)/len(rc), sum(dc)/len(dc)))
p("")
p("sample ids:")
for r in rows[:30]:
    p("  %-46s raw=%-6d draft=%-6d te=%s gate_ok=%s"%(str(r.get("id"))[:46], len(r.get("raw") or ""), len(r.get("draft") or ""), r.get("trainingEligible"), (r.get("gate") or {}).get("ok")))

# dump 4 full examples
EX=io.open(r"D:\cfb\.cfb-offline\_examples.txt","w",encoding="utf-8")
golds=[r for r in rows if r.get("trainingEligible") and (r.get("draft") or "")]
sel = golds[:4] if len(golds)>=4 else rows[:4]
EX.write("TRAINING-ELIGIBLE COUNT=%d / %d\n\n"%(len(golds),len(rows)))
for i,r in enumerate(sel):
    EX.write("="*78+"\n[%d] id=%s task=%s round=%s src=%s\n"%(i,r.get("id"),str(r.get("task"))[:80],r.get("round"),r.get("_src")))
    EX.write("rawChars=%s draftChars=%s outChars=%s gate=%s te=%s\n"%(r.get("rawChars"),r.get("draftChars"),r.get("outChars"),json.dumps(r.get("gate"),ensure_ascii=False)[:200],r.get("trainingEligible")))
    EX.write("--- CTX ---\n"+(r.get("ctx") or "")[:2500]+"\n")
    EX.write("--- RAW ---\n"+(r.get("raw") or "")[:4000]+"\n")
    EX.write("--- DRAFT ---\n"+(r.get("draft") or "")+"\n")
    EX.write("--- STORED ---\n"+(r.get("stored") or "")[:3000]+"\n")
    EX.write("--- qualityAudit ---\n"+json.dumps(r.get("qualityAudit"),ensure_ascii=False)[:600]+"\n")
EX.close()

# ---- traj dir census ----
p("")
p("="*70); p("traj dir census")
byk=collections.Counter(); sizes=collections.Counter()
for dp,dn,fn in os.walk(os.path.join(ROOT,".cfb-runtime")):
    for x in fn:
        e=os.path.splitext(x)[1] or x
        byk[e]+=1
        sizes[e]+=os.path.getsize(os.path.join(dp,x))
for k,v in byk.most_common():
    p("  %-10s n=%-5d bytes=%d"%(k,v,sizes[k]))
p("")
p("json file names in .cfb-runtime/traj/*/ (top-level only):")
names=collections.Counter()
for d in glob.glob(os.path.join(ROOT,".cfb-runtime","traj","*")):
    if os.path.isdir(d):
        for x in os.listdir(d):
            names[x]+=1
p(dict(names.most_common(40)))

# results.jsonl global
p("")
p("="*70); p("results.jsonl aggregate")
rs=sorted(glob.glob(os.path.join(ROOT,".cfb-runtime","**","results.jsonl"),recursive=True))
tot=0; keys=collections.Counter(); variants=collections.Counter(); pert=0
for f in rs:
    for l in io.open(f,encoding="utf-8",errors="replace"):
        l=l.strip()
        if not l: continue
        try: o=json.loads(l)
        except Exception: continue
        tot+=1
        for k in o: keys[k]+=1
        variants[str(o.get("variant"))[:60]]+=1
        if o.get("perturb"): pert+=1
p("files=%d rows=%d"% (len(rs),tot))
p("perturb rows=%d"%pert)
p("variants:", dict(variants.most_common(12)))
p("keys:", dict(keys.most_common(40)))
OUT.close(); print("ok")
