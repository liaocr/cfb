import io, json, os, re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return w*0.81 + (len(s)-w)*0.26
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
OUT = io.open(r'D:\cfb\.cfb-offline\_v4final.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
def st(xs):
    xs = sorted(xs); n = len(xs); q = lambda t: xs[min(n-1,int(n*t))]
    return 'n=%d min %.3f p25 %.3f 中位 %.3f p75 %.3f p90 %.3f max %.3f 均值 %.3f' % (n,xs[0],q(.25),q(.5),q(.75),q(.9),xs[-1],sum(xs)/n)
p('有效稿 %d 条' % len(rows))
p('')
p('token 比  : %s' % st([est(o['draft'])/est(o['raw']) for o in rows]))
p('字符比    : %s' % st([len(o['draft'])/len(o['raw']) for o in rows]))
p('稿长(字符): %s' % st([len(o['draft']) for o in rows]))
p('原文(字符): %s' % st([len(o['raw']) for o in rows]))
p('中文占比  : %s' % st([len(RE_WIDE.findall(o['draft']))/max(1,len(o['draft'])) for o in rows]))
p('')
u = [o.get('usage') or {} for o in rows]
n = len(rows)
pt = sum(x.get('prompt',0) for x in u)/n; ct = sum(x.get('completion',0) for x in u)/n
p('每条 prompt %.0f tok / completion %.0f tok / 思考 0' % (pt, ct))
p('本批低谷官方价 $%.4f（100 条）⇒ 1000 条 $%.2f ⇒ 4687 条 $%.2f' % ((pt*n*0.15+ct*n*0.60)/1e6, (pt*n*0.15+ct*n*0.60)/1e6*10, (pt*n*0.15+ct*n*0.60)/1e6*46.87))
p('')
p('超 0.55 token 比的: %d/%d = %.0f%%' % (sum(1 for o in rows if est(o['draft'])/est(o['raw'])>0.55), n, 100.0*sum(1 for o in rows if est(o['draft'])/est(o['raw'])>0.55)/n))
OUT.close(); print('ok')