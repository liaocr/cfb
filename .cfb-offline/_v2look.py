import io, json
d = {}
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts-v2.jsonl', encoding='utf-8'):
    if l.strip():
        o = json.loads(l)
        if (o.get('draft') or '').strip(): d[o['id']] = o
v1 = {}
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl', encoding='utf-8'):
    if l.strip():
        o = json.loads(l); v1.setdefault(o['id'], o)
OUT = io.open(r'D:\cfb\.cfb-offline\_v2look.txt','w',encoding='utf-8')
ks = [k for k in d if k in v1][:4]
for k in ks:
    a, b = v1[k], d[k]
    OUT.write('='*80 + '\n' + k + '  raw=%d\n' % len(a['raw']))
    OUT.write('--- CTX ---\n' + a['ctx'][:500] + '\n')
    OUT.write('--- RAW[:700] ---\n' + a['raw'][:700] + '\n')
    OUT.write('--- v1 (%d字) ---\n%s\n' % (len(a['draft']), a['draft'][:900]))
    OUT.write('--- v2 (%d字) ---\n%s\n\n' % (len(b['draft']), b['draft'][:1400]))
OUT.close(); print('ok', len(d))