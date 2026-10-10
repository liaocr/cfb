import io, json, os
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
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
T = os.path.join('D:\\', 'cfb', '.cfb-offline', 'teacher')
SETS = [('v1 比例55%', os.path.join(T,'v1-off.jsonl')), ('v2 交接稿', os.path.join(T,'v2-off.jsonl')), ('v3 教师稿', os.path.join(T,'v3-off.jsonl'))]
D = {}
for t, p_ in SETS:
    D[t] = load(p_)
    print('%-12s %d' % (t, len(D[t])))
base = sorted(D['v3 教师稿'].keys())
OUT = io.open(r'D:\cfb\.cfb-offline\_v3cmp.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('三版共同单元 %d' % sum(1 for i in base if all(i in D[t] for t,_ in SETS)))
def st(xs):
    xs = sorted(xs); n = len(xs)
    q = lambda t: xs[min(n-1, int(n*t))]
    return 'n=%-3d min %.3f p25 %.3f 中位 %.3f p75 %.3f p90 %.3f max %.3f 均值 %.3f' % (n, xs[0], q(.25), q(.5), q(.75), q(.9), xs[-1], sum(xs)/n)
p('')
p('=== 字符比 ===')
for t, _ in SETS:
    V = D[t]; xs = [len(V[i]['draft'])/max(1,len(V[i]['raw'])) for i in base if i in V]
    p('%-12s %s' % (t, st(xs)))
p('')
p('=== token 比（真压缩比）===')
for t, _ in SETS:
    V = D[t]; xs = []
    for i in base:
        if i not in V: continue
        xs.append(len(TK.encode(V[i]['draft']))/max(1,len(TK.encode(V[i]['raw']))))
    p('%-12s %s' % (t, st(xs)))
p('')
p('=== 稿长（字符）===')
for t, _ in SETS:
    V = D[t]; xs = [len(V[i]['draft']) for i in base if i in V]
    p('%-12s %s' % (t, st(xs)))
p('')
p('=== 超 900 字硬顶 ===')
for t, _ in SETS:
    V = D[t]; xs = [len(V[i]['draft']) for i in base if i in V]
    p('%-12s %d/%d = %.0f%%' % (t, sum(1 for x in xs if x>900), len(xs), 100.0*sum(1 for x in xs if x>900)/len(xs)))
OUT.close(); print('ok')