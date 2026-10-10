import io, json, os
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
import re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return (w*0.81 + (len(s)-w)*0.26)
OUT = io.open(r'D:\cfb\.cfb-offline\_final4.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
V = {}
for tag in ['v1','v2','v3','v4']:
    d = {}
    for l in io.open(r'D:\cfb\.cfb-offline\_c-%s.jsonl' % tag, encoding='utf-8'):
        o = json.loads(l); d[o['id']] = o
    V[tag] = d
ids = sorted(V['v4'].keys())
def st(xs):
    xs = sorted(xs); n = len(xs); q = lambda t: xs[min(n-1,int(n*t))]
    return 'min %.3f p25 %.3f 中位 %.3f p75 %.3f max %.3f 均值 %.3f' % (xs[0],q(.25),q(.5),q(.75),xs[-1],sum(xs)/n)
p('=== token 比（校准 0.81/0.26）===')
for tag in ['v1','v2','v3','v4']:
    xs = [est(V[tag][i]['draft'])/est(V[tag][i]['raw']) for i in ids]
    p('%-4s %s' % (tag, st(xs)))
p('')
p('=== 字符比 ===')
for tag in ['v1','v2','v3','v4']:
    xs = [len(V[tag][i]['draft'])/len(V[tag][i]['raw']) for i in ids]
    p('%-4s %s' % (tag, st(xs)))
p('')
p('=== 稿子里的中文占比 ===')
for tag in ['v1','v2','v3','v4']:
    xs = []
    for i in ids:
        d = V[tag][i]['draft']; w = len(RE_WIDE.findall(d))
        xs.append(w/max(1,len(d)))
    p('%-4s %s' % (tag, st(xs)))
p('')
p('=== 稿长（字符）===')
for tag in ['v1','v2','v3','v4']:
    p('%-4s %s' % (tag, st([len(V[tag][i]['draft']) for i in ids])))
OUT.close(); print('ok')