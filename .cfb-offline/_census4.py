
import os, io, json, glob, collections
OUT=io.open(r"D:\cfb\.cfb-offline\_census4.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
ROOT=r"D:\cfb"
rows=[]
rs=sorted(glob.glob(os.path.join(ROOT,".cfb-runtime","**","results.jsonl"),recursive=True))
for f in rs:
    for l in io.open(f,encoding="utf-8",errors="replace"):
        l=l.strip()
        if not l: continue
        try: o=json.loads(l)
        except Exception: continue
        o["_f"]=os.path.relpath(f,ROOT); rows.append(o)
p("rows=%d"%len(rows))
# rows with task/variant
tv=[r for r in rows if r.get("task") and r.get("variant")]
p("rows with task+variant=%d"%len(tv))
p("fixed values:", dict(collections.Counter(str(r.get("fixed")) for r in tv)))
p("fixedAtRound:", dict(collections.Counter(str(r.get("fixedAtRound")) for r in tv)))
p("verifiedAfterFix:", dict(collections.Counter(str(r.get("verifiedAfterFix")) for r in tv)))
p("")
p("=== task x variant  (fixed / fixedAtRound / claimJustified) ===")
tab=collections.defaultdict(dict)
for r in tv:
    tab[str(r.get("task"))[:52]][str(r.get("variant"))[:28]] = (r.get("fixed"), r.get("fixedAtRound"), r.get("verifiedAfterFix"))
for t in sorted(tab):
    p("  %-54s %s"%(t, json.dumps(tab[t],ensure_ascii=False,default=str)[:400]))
p("")
p("=== perturb rows ===")
pr=[r for r in rows if r.get("perturb")]
p("count=%d"%len(pr))
if pr:
    o=pr[0]
    p("keys=%s"%list(o.keys()))
    p("perturb=%s"%json.dumps(o.get("perturb"),ensure_ascii=False)[:1200])
    p("task=%s variant=%s"% (str(o.get("task"))[:60], o.get("variant")))
p("")
p("=== claim / claimJustified sample ===")
for r in tv[:6]:
    p("  task=%s var=%s fixed=%s just=%s"%(str(r.get("task"))[:40],r.get("variant"),r.get("fixed"),str(r.get("claimJustified"))[:60]))
p("")
p("=== rejected / transcript shape ===")
o=tv[0]
p("rejected type=%s len=%s"%(type(o.get("rejected")).__name__, len(o.get("rejected") or [])))
rj=o.get("rejected")
if rj: p("rejected[0]=%s"%json.dumps(rj[0],ensure_ascii=False)[:800])
tr=o.get("transcript")
p("transcript n=%s"%len(tr or []))
if tr:
    p("transcript[0] keys=%s"%list(tr[0].keys()) if isinstance(tr[0],dict) else p("t0 type",type(tr[0])))
    p(json.dumps(tr[0],ensure_ascii=False)[:800])
rm=o.get("roundMessages")
p("roundMessages n=%s"%(len(rm or [])))
if rm and isinstance(rm[0],dict): p("rm[0] keys=%s"%list(rm[0].keys()))
# contextReasoningChars comparison raw vs hand
p("")
p("=== contextReasoningChars by variant ===")
for v in ["raw","hand"]:
    xs=[r.get("contextReasoningChars") for r in tv if r.get("variant")==v and isinstance(r.get("contextReasoningChars"),(int,float))]
    if xs: p("  %s n=%d mean=%.0f med=%d max=%d"%(v,len(xs),sum(xs)/len(xs),sorted(xs)[len(xs)//2],max(xs)))
# per-task raw vs hand fixed
p("")
p("=== per-task: did variant fix it? ===")
for t in sorted(set(str(r.get("task"))[:60] for r in tv)):
    sub=[r for r in tv if str(r.get("task"))[:60]==t]
    p("  %-56s %s"%(t, {r.get("variant"):(r.get("fixed"),r.get("fixedAtRound")) for r in sub}))
OUT.close(); print("ok")
