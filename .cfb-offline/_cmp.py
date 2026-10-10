# -*- coding: utf-8 -*-
# 同一批单元上，v1（压缩稿）vs v2（决策交接稿）对照。字符比与 **token 比**都量。
import io, json, os, subprocess
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')

def load(p):
    d = {}
    if not os.path.exists(p): return d
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l); d[o['id']] = o
            except Exception: pass
    return d
V1 = load(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl')
V2 = load(r'D:\cfb\.cfb-offline\teacher\drafts-v2.jsonl')
ids = [k for k in V2.keys() if k in V1]
OUT = io.open(r'D:\cfb\.cfb-offline\_cmp.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('可比单元 = %d（v2 有 %d，v1 有 %d）' % (len(ids), len(V2), len(V1)))

def stat(xs):
    xs = sorted(xs); n = len(xs)
    if not n: return None
    q = lambda t: xs[min(n-1, int(n*t))]
    return (xs[0], q(.25), q(.5), q(.75), q(.9), xs[-1], sum(xs)/n)
def fmt(label, xs, unit):
    s = stat(xs)
    if not s: return label + ': (空)'
    return '%-22s n=%-4d min=%.3f p25=%.3f 中位=%.3f p75=%.3f p90=%.3f max=%.3f 均值=%.3f' % ((label, len(xs)) + s)

p('')
p('=== 字符比 draft/raw ===')
for tag, V in [('v1 压缩稿', V1), ('v2 交接稿', V2)]:
    xs = [len(V[i]['draft'])/max(1,len(V[i]['raw'])) for i in ids if V[i].get('draft')]
    p(fmt(tag, xs, 'char'))
p('')
p('=== token 比（真正的压缩比）===')
tokr = {}
for tag, V in [('v1 压缩稿', V1), ('v2 交接稿', V2)]:
    xs = []
    for i in ids:
        d = V[i].get('draft')
        if not d: continue
        rt = len(TK.encode(V[i]['raw'])); dt = len(TK.encode(d))
        xs.append(dt/max(1,rt))
    tokr[tag] = xs
    p(fmt(tag, xs, 'tok'))
p('')
p('=== 稿子长度（字符）===')
for tag, V in [('v1 压缩稿', V1), ('v2 交接稿', V2)]:
    p(fmt(tag, [len(V[i]['draft']) for i in ids if V[i].get('draft')], 'ch'))
p('')
p('=== 每单元逐条（前 25）===')
p('%-42s %7s %7s %7s %7s' % ('id','v1字比','v2字比','v1tok','v2tok'))
for i in ids[:25]:
    a = len(V1[i]['draft'])/max(1,len(V1[i]['raw'])); b = len(V2[i]['draft'])/max(1,len(V2[i]['raw']))
    at = len(TK.encode(V1[i]['draft']))/max(1,len(TK.encode(V1[i]['raw'])))
    bt = len(TK.encode(V2[i]['draft']))/max(1,len(TK.encode(V2[i]['raw'])))
    p('%-42s %7.3f %7.3f %7.3f %7.3f' % (i[:42], a, b, at, bt))
OUT.close(); print('ok')