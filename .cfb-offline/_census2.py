
import os, io, json, gzip, glob, collections
OUT = io.open(r"D:\cfb\.cfb-offline\_census2.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
ROOT=r"D:\cfb"
def cjk(s): return sum(1 for c in s if '\u4e00'<=c<='\u9fff')
def pct(xs,q):
    xs=sorted(xs)
    return xs[min(len(xs)-1,int(len(xs)*q))] if xs else 0

p("="*70); p("A) FULL census scan"); p("="*70)
pat=os.path.join(ROOT,"transfer","models","micro-generator-v4flash-scenarios","birth-units-census-batch*.jsonl.gz")
allraw=[]; sources=collections.Counter(); notes=collections.Counter(); sample_src=None
for f in sorted(glob.glob(pat)):
    with gzip.open(f,"rt",encoding="utf-8",errors="replace") as fh:
        for line in fh:
            line=line.strip()
            if not line: continue
            try: o=json.loads(line)
            except Exception: continue
            allraw.append(len(o.get("raw") or ""))
            s=o.get("source")
            if sample_src is None and isinstance(s,dict): sample_src=s
            sources[json.dumps(s,ensure_ascii=False,sort_keys=True)[:90] if isinstance(s,dict) else str(s)[:90]] += 1
            notes[str(o.get("notes"))[:50]] += 1
n=len(allraw)
p("units=%d"%n); p("rawChars total=%d (%.1f MB)"%(sum(allraw),sum(allraw)/1048576))
p("median=%d p10=%d p25=%d p75=%d p90=%d p99=%d max=%d"%(pct(allraw,.5),pct(allraw,.1),pct(allraw,.25),pct(allraw,.75),pct(allraw,.9),pct(allraw,.99),max(allraw)))
p("buckets:", {("%d-%d"%(lo,hi)):sum(1 for x in allraw if lo<=x<hi) for lo,hi in [(0,500),(500,1000),(1000,2000),(2000,4000),(4000,8000),(8000,10**9)]})
p("source sample:", json.dumps(sample_src,ensure_ascii=False)[:500] if sample_src else None)
p("source top:", dict(sources.most_common(15)))
p("notes:", dict(notes.most_common(10)))

p(""); p("="*70); p("B) hand-samples.jsonl"); p("="*70)
hs=glob.glob(os.path.join(ROOT,".cfb-runtime","**","hand-samples.jsonl"),recursive=True)
for f in hs:
    p("---",os.path.relpath(f,ROOT),os.path.getsize(f))
    try:
        lines=[l for l in io.open(f,encoding="utf-8",errors="replace") if l.strip()]
        p("  lines=%d"%len(lines))
        o=json.loads(lines[0]); p("  keys=%s"%list(o.keys()))
        for k,v in o.items():
            if isinstance(v,str) and len(v)>100: p("  longstr %s len=%d cjk=%d"%(k,len(v),cjk(v)))
            if isinstance(v,list): p("  list %s len=%d"%(k,len(v)))
            if isinstance(v,dict): p("  dict %s keys=%s"%(k,list(v.keys())[:15]))
    except Exception as e: p("  err",repr(e)[:180])

p(""); p("="*70); p("C) results.jsonl sample"); p("="*70)
rs=sorted(glob.glob(os.path.join(ROOT,".cfb-runtime","**","results.jsonl"),recursive=True), key=lambda z:-os.path.getsize(z))
p("found %d results.jsonl"%len(rs))
for f in rs[:3]:
    p("---",os.path.relpath(f,ROOT),os.path.getsize(f))
    try:
        lines=[l for l in io.open(f,encoding="utf-8",errors="replace") if l.strip()]
        p("  lines=%d"%len(lines))
        o=json.loads(lines[0]); p("  keys=%s"%list(o.keys()))
        for k,v in o.items():
            if isinstance(v,str) and len(v)>100: p("  longstr %s len=%d cjk=%d"%(k,len(v),cjk(v)))
            if isinstance(v,list): p("  list %s len=%d"%(k,len(v)))
            if isinstance(v,dict): p("  dict %s keys=%s"%(k,list(v.keys())[:15]))
    except Exception as e: p("  err",repr(e)[:180])

for rel in [r"transfer\gold-rejected\README.md", r"transfer\gold\README.md"]:
    fp=os.path.join(ROOT,rel)
    p(""); p("="*70); p("D) "+rel); p("="*70)
    if os.path.exists(fp): p(io.open(fp,encoding="utf-8",errors="replace").read())

fp=os.path.join(ROOT,r"transfer\gold-rejected\audit.json")
p(""); p("="*70); p("E) gold-rejected/audit.json"); p("="*70)
if os.path.exists(fp):
    o=json.load(io.open(fp,encoding="utf-8",errors="replace"))
    s=json.dumps(o,ensure_ascii=False)
    p("type=%s len=%d"%(type(o).__name__,len(s)))
    if isinstance(o,dict): p("keys=%s"%list(o.keys()))
    p(s[:3500])
OUT.close(); print("ok")
