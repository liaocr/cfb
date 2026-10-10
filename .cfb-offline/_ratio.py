import io, json
rep = json.load(io.open(r'D:\cfb\.cfb-offline\ruler\report-teacher-all.json', encoding='utf-8'))
rows = rep['rows'] if isinstance(rep, dict) and 'rows' in rep else rep
OUT = io.open(r'D:\cfb\.cfb-offline\_ratio.txt','w',encoding='utf-8')
def stats(xs, label):
    xs = sorted(xs); n = len(xs)
    if not n:
        OUT.write(label + ': (empty)\n'); return
    q = lambda t: xs[min(n-1, int(n*t))]
    OUT.write('%-32s n=%-5d min=%.3f p25=%.3f MED=%.3f p75=%.3f p90=%.3f max=%.3f mean=%.3f\n' % (label, n, xs[0], q(.25), q(.5), q(.75), q(.9), xs[-1], sum(xs)/n))
OUT.write('total = %d\n\n' % len(rows))
stats([x['ratio'] for x in rows], 'ALL drafts')
stats([x['ratio'] for x in rows if x['pass']], 'PASS (trainable)')
stats([x['ratio'] for x in rows if not x['pass']], 'REJECT')
np_ = sum(1 for x in rows if x['pass'])
OUT.write('\npass rate = %d/%d = %.1f%%\n' % (np_, len(rows), 100.0*np_/len(rows)))
OUT.write('ratio > 0.55 : %d (%.1f%%)\n' % (sum(1 for x in rows if x['ratio']>0.55), 100.0*sum(1 for x in rows if x['ratio']>0.55)/len(rows)))
OUT.write('ratio < 0.25 : %d (%.1f%%)\n' % (sum(1 for x in rows if x['ratio']<0.25), 100.0*sum(1 for x in rows if x['ratio']<0.25)/len(rows)))
OUT.close(); print('ok')