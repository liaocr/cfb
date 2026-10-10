import io, json, glob
files = sorted(glob.glob(r'D:\cfb\transfer\gold\*\*.json'))
OUT = io.open(r'D:\cfb\.cfb-offline\_gold2.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('%-32s %7s %6s %8s %7s %5s %5s %6s' % ('id','raw','draft','字符比','vsRaw','solved','rawSol','use'))
rs = []
for f in files:
    o = json.load(io.open(f, encoding='utf-8'))
    raw = o.get('raw') or ''; dr = o.get('draft') or ''
    oc = o.get('outcome') or {}
    ratio = len(dr)/max(1,len(raw))
    rs.append(ratio)
    p('%-32s %7d %6d %8.3f %7s %5s %5s %6s' % (o.get('id','?')[:32], len(raw), len(dr), ratio,
        oc.get('vsRaw'), oc.get('solved'), oc.get('rawSolved'), o.get('use')))
rs.sort()
p('')
n = len(rs)
p('金标字符比：n=%d min=%.3f 中位=%.3f max=%.3f 均值=%.3f' % (n, rs[0], rs[n//2], rs[-1], sum(rs)/n))
p('')
vs = {}
for f in files:
    o = json.load(io.open(f, encoding='utf-8'))
    v = (o.get('outcome') or {}).get('vsRaw')
    vs[v] = vs.get(v, 0) + 1
p('真机结局 vsRaw 分布 = ' + json.dumps(vs, ensure_ascii=False))
OUT.close(); print('ok')