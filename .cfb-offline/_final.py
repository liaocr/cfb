import io, json
def load(p):
    d = {}
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l); d[o['id']] = o
            except Exception: pass
    return d
OUT = io.open(r'D:\cfb\.cfb-offline\_final.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
V1 = load(r'D:\cfb\.cfb-offline\teacher\v1-off.jsonl')
V2 = load(r'D:\cfb\.cfb-offline\teacher\v2-off.jsonl')
ids = sorted(k for k in V2 if k in V1)
p('两版都有稿的单元 = %d' % len(ids))
for tag, V in [('v1', V1), ('v2', V2)]:
    with io.open(r'D:\cfb\.cfb-offline\_off-%s.jsonl' % tag, 'w', encoding='utf-8') as F:
        for i in ids:
            F.write(json.dumps({'id': i, 'raw': V[i]['raw'], 'ctx': V[i]['ctx'], 'draft': V[i]['draft']}, ensure_ascii=False) + '\n')
# 空稿统计
for tag, V in [('v1-off', V1), ('v2-off', V2), ('v1-think', None), ('v2-think', None)]:
    pass
e1 = [i for i in ids if not (V1[i].get('draft') or '').strip()]
e2 = [i for i in ids if not (V2[i].get('draft') or '').strip()]
p('空稿：v1-off %d，v2-off %d' % (len(e1), len(e2)))
u1 = [V1[i]['usage'] for i in ids]
u2 = [V2[i]['usage'] for i in ids]
p('')
p('=== token 用量（每条均摊）===')
p('%-10s %10s %12s %10s' % ('', 'prompt', 'completion', 'reasoning'))
for tag, U in [('v1-off', u1), ('v2-off', u2)]:
    n = len(U)
    p('%-10s %10.0f %12.0f %10.0f' % (tag, sum(x['prompt'] for x in U)/n, sum(x['completion'] for x in U)/n, sum(x['reasoning'] for x in U)/n))
# 开思考版 v1 对比
VT = load(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl')
UT = [VT[i]['usage'] for i in ids if i in VT]
if UT:
    n = len(UT)
    p('%-10s %10.0f %12.0f %10.0f   <- 开思考' % ('v1-think', sum(x['prompt'] for x in UT)/n, sum(x['completion'] for x in UT)/n, sum(x['reasoning'] for x in UT)/n))
cost = lambda U: (sum(x['prompt'] for x in U)*0.15 + sum(x['completion'] for x in U)*0.60)/1e6
p('')
p('本批花费（关思考，低谷官方价）：v1-off $%.4f  v2-off $%.4f' % (cost(u1), cost(u2)))
OUT.close(); print('ok')