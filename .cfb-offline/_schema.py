
import os, io, json, gzip, glob, collections
OUT=io.open(r"D:\cfb\.cfb-offline\_schema.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
ROOT=r"D:\cfb"
pat=os.path.join(ROOT,"transfer","models","micro-generator-v4flash-scenarios","birth-units-census-batch*.jsonl.gz")
recs=[]
for f in sorted(glob.glob(pat)):
    with gzip.open(f,"rt",encoding="utf-8",errors="replace") as fh:
        for i,l in enumerate(fh):
            l=l.strip()
            if not l: continue
            try: o=json.loads(l)
            except Exception: continue
            recs.append(o)
p("total", len(recs))
o=recs[0]
p("")
p("=== 一条完整样本（去掉 raw/ctx 正文）===")
slim={k:(v if not isinstance(v,str) or len(v)<300 else "<str len=%d>"%len(v)) for k,v in o.items()}
p(json.dumps(slim,ensure_ascii=False,indent=1)[:2500])
p("")
p("=== 字段类型分布 ===")
for k in o.keys():
    p("  %-18s %s" % (k, collections.Counter(type(r.get(k)).__name__ for r in recs).most_common()))
p("")
p("=== source 子字段 ===")
keys=collections.Counter()
for r in recs:
    s=r.get("source")
    if isinstance(s,dict):
        for k in s: keys[k]+=1
p(json.dumps(keys.most_common(),ensure_ascii=False))
p("")
p("=== source 去重基数 ===")
for k in ["dataset","config","split","teacherModel","reasoningEffort","repository","repositoryLicense"]:
    vals=collections.Counter()
    for r in recs:
        s=r.get("source") or {}
        if isinstance(s,dict): vals[str(s.get(k))]+=1
    p("  %-20s 唯一=%-6d top=%s" % (k, len(vals), json.dumps(vals.most_common(6),ensure_ascii=False)[:260]))
p("")
p("=== trajectoryId / instanceId / fileRowNumber ===")
for k in ["trajectoryId","instanceId","fileRowNumber","shardUrl"]:
    vals=set(); 
    for r in recs:
        s=r.get("source") or {}
        if isinstance(s,dict) and s.get(k) is not None: vals.add(str(s.get(k)))
    p("  %-16s 唯一=%d" % (k, len(vals)))
p("")
p("=== unitId 形态 ===")
for r in recs[:5]: p("  ", r.get("unitId"))
p("unique unitId=", len(set(str(r.get('unitId')) for r in recs)))
p("")
p("=== visibleAtBirth / after / offlineSignals ===")
for k in ["visibleAtBirth","after","offlineSignals","birthStep"]:
    p("  %-16s sample=%s" % (k, json.dumps([r.get(k) for r in recs[:3]],ensure_ascii=False)[:400]))
p("")
p("=== 重复率：同一 (trajectoryId,birthStep) 出现几次 ===")
c=collections.Counter()
for r in recs:
    s=r.get("source") or {}
    c[(str(s.get("trajectoryId")), r.get("birthStep"))]+=1
p("  pairs=", len(c), " 重复最多的:", json.dumps(c.most_common(5),ensure_ascii=False))
p("")
p("=== 每个 trajectory 有几个 unit ===")
tc=collections.Counter()
for r in recs:
    s=r.get("source") or {}
    tc[str(s.get("trajectoryId"))]+=1
import statistics
ns=list(tc.values())
p("  trajectories=",len(tc)," units/traj min=%d med=%d max=%d mean=%.2f"%(min(ns),statistics.median(ns),max(ns),sum(ns)/len(ns)))
p("  分布:", json.dumps(collections.Counter(ns).most_common(12),ensure_ascii=False))
OUT.close(); print("ok")
