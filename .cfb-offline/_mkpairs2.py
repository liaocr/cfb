import io, json
def load(p):
    d = {}
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l); d[o['id']] = o
            except Exception: pass
    return d
V1 = load(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl')
V2 = load(r'D:\cfb\.cfb-offline\teacher\drafts-v2.jsonl')
ids = sorted(k for k in V2 if k in V1)
for tag, V in [('v1', V1), ('v2', V2)]:
    with io.open(r'D:\cfb\.cfb-offline\_pairs-%s.jsonl' % tag, 'w', encoding='utf-8') as F:
        for i in ids:
            F.write(json.dumps({'id': i, 'raw': V[i]['raw'], 'ctx': V[i]['ctx'], 'draft': V[i]['draft']}, ensure_ascii=False) + '\n')
print('ids', len(ids))