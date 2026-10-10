import io, json, os
T = os.path.join('D:\\','cfb','.cfb-offline','teacher')
def load(p):
    d = {}
    if not os.path.exists(p): return d
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l)
                if (o.get('draft') or '').strip(): d[o['id']] = o
            except Exception: pass
    return d
V4 = load(os.path.join(T,'v4-30.jsonl'))
ids = sorted(V4.keys())
print('v4 单元数', len(ids))
for tag, fn in [('v1','v1-off.jsonl'),('v2','v2-off.jsonl'),('v3','v3-off.jsonl'),('v4','v4-30.jsonl')]:
    V = load(os.path.join(T, fn))
    with io.open(r'D:\cfb\.cfb-offline\_c-%s.jsonl' % tag, 'w', encoding='utf-8') as F:
        for i in ids:
            if i in V: F.write(json.dumps({'id':i,'raw':V[i]['raw'],'ctx':V[i]['ctx'],'draft':V[i]['draft']}, ensure_ascii=False)+'\n')
    print('  %s -> %d' % (tag, sum(1 for i in ids if i in V)))