import io, json
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
def load(p):
    d = {}
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l); d[o['id']] = o
            except Exception: pass
    return d
SETS = [('v1 开思考', r'D:\cfb\.cfb-offline\teacher\drafts.jsonl'),
        ('v1 关思考', r'D:\cfb\.cfb-offline\teacher\v1-off.jsonl'),
        ('v2 关思考', r'D:\cfb\.cfb-offline\teacher\v2-off.jsonl')]
OUT = io.open(r'D:\cfb\.cfb-offline\_final2.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
def st(xs):
    xs = sorted(xs); n = len(xs)
    q = lambda t: xs[min(n-1, int(n*t))]
    return 'n=%-4d min=%.3f p25=%.3f 中位=%.3f p75=%.3f p90=%.3f max=%.3f 均值=%.3f' % (n, xs[0], q(.25), q(.5), q(.75), q(.9), xs[-1], sum(xs)/n)
D = {t: load(p_) for t, p_ in SETS}
base = sorted(D['v2 关思考'].keys())
p('=== 字符比（draft/raw）===')
for t, _ in SETS:
    V = D[t]
    xs = [len(V[i]['draft'])/max(1,len(V[i]['raw'])) for i in base if i in V and V[i].get('draft')]
    p('%-10s %s' % (t, st(xs)))
p('')
p('=== token 比（真正的压缩比）===')
for t, _ in SETS:
    V = D[t]
    xs = []
    for i in base:
        if i not in V or not V[i].get('draft'): continue
        rt = len(TK.encode(V[i]['raw'])); dt = len(TK.encode(V[i]['draft']))
        xs.append(dt/max(1,rt))
    p('%-10s %s' % (t, st(xs)))
p('')
p('=== 稿子字符长度 ===')
for t, _ in SETS:
    V = D[t]
    p('%-10s %s' % (t, st([len(V[i]['draft']) for i in base if i in V and V[i].get('draft')])))
OUT.close(); print('ok')