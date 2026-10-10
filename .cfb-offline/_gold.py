import io, json, glob, os
files = sorted(glob.glob(r'D:\cfb\transfer\gold\*\*.json'))
OUT = io.open(r'D:\cfb\.cfb-offline\_gold.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('金标条目 = %d' % len(files))
if files:
    k = json.load(io.open(files[0], encoding='utf-8'))
    p('顶层字段 = ' + ', '.join(sorted(k.keys())))
p('')
p('%-34s %7s %7s %7s %7s  %-22s' % ('id','raw','ctx','draft','stored','keys'))
rows = []
for f in files:
    o = json.load(io.open(f, encoding='utf-8'))
    raw = o.get('raw') or ''; ctx = o.get('ctx') or ''; dr = o.get('draft') or ''; st = o.get('stored') or ''
    ratio = len(dr)/max(1,len(raw))
    rows.append((o.get('id'), o, raw, ctx, dr, st, ratio))
    p('%-34s %7d %7d %7d %7d' % (o.get('id','?')[:34], len(raw), len(ctx), len(dr), len(st)))
p('')
p('=== 每条的额外字段（除 raw/ctx/draft/stored 外） ===')
for i, o, raw, ctx, dr, st, ratio in rows:
    extra = {k: v for k, v in o.items() if k not in ('raw','ctx','draft','stored','calls','schema','id','family','task','sample','round','plan','split','at')}
    p('-- %s  字符比=%.3f' % (i, ratio))
    p('   ' + json.dumps(extra, ensure_ascii=False)[:900])
OUT.close(); print('ok')