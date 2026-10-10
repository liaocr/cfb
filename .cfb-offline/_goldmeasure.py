import io, json, glob, os
OUT = io.open(r'D:\cfb\.cfb-offline\_goldmeasure.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
rows = []
for f in sorted(glob.glob(r'D:\cfb\transfer\gold\*\*.json')):
    try: o = json.loads(io.open(f, encoding='utf-8').read())
    except Exception: continue
    if not isinstance(o, dict) or 'raw' not in o: continue
    raw = o.get('raw') or ''; dr = o.get('draft') or o.get('draftText') or ''
    st = o.get('stored') or ''
    rows.append((os.path.basename(f)[:-5], len(raw), len(dr), len(st), o.get('use'),
                 (len(dr)/len(raw) if raw else 0), o.get('family')))
p('transfer/gold 条目 = %d' % len(rows))
p('')
p('%-42s %7s %7s %7s %7s %6s %s' % ('id','raw字','draft','stored','d/r','use',''))
for r in sorted(rows, key=lambda x: x[6] or x[0]):
    p('%-42s %7d %7d %7d %7.3f %6s' % (r[0], r[1], r[2], r[3], r[5], r[4]))
if rows:
    ds = sorted(r[2] for r in rows); rs = sorted(r[5] for r in rows)
    p('')
    p('draft 长度：min %d 中位 %d max %d 均值 %.0f' % (ds[0], ds[len(ds)//2], ds[-1], sum(ds)/len(ds)))
    p('draft/raw ：min %.3f 中位 %.3f max %.3f 均值 %.3f' % (rs[0], rs[len(rs)//2], rs[-1], sum(rs)/len(rs)))
    p('raw   长度：min %d 中位 %d max %d' % (min(r[1] for r in rows), sorted(r[1] for r in rows)[len(rows)//2], max(r[1] for r in rows)))
OUT.close(); print('ok')