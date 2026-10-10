import io, json, glob, os
OUT = io.open(r'D:\cfb\.cfb-offline\_hand.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
files = sorted(glob.glob(r'D:\cfb\.cfb-runtime\traj\*\hand-samples.jsonl'))
p('hand-samples 文件数 = %d' % len(files))
all_rows = []
for f in files:
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            try: all_rows.append((f, json.loads(l)))
            except Exception: pass
p('总行数 = %d' % len(all_rows))
if all_rows:
    p('字段 = ' + ', '.join(sorted(all_rows[0][1].keys())))
    p('')
    p('样例：' + json.dumps({k: (str(v)[:120] if not isinstance(v,(int,float,bool,type(None))) else v) for k,v in all_rows[0][1].items()}, ensure_ascii=False)[:900])
p('')
# 金标 id 是否在其中
gold_ids = set()
for f in glob.glob(r'D:\cfb\transfer\gold\*\*.json'):
    gold_ids.add(json.load(io.open(f, encoding='utf-8')).get('id'))
def key(o):
    t = o.get('task'); s = o.get('sample'); r = o.get('round')
    return '%s-s%s-r%s' % (t, s, r)
hs_keys = set()
for f, o in all_rows:
    hs_keys.add(key(o))
p('金标 id 在 hand-samples 里的：')
for g in sorted(gold_ids):
    p('   %-34s %s' % (g, 'YES' if g in hs_keys else 'no'))
p('')
# 手写稿比值分布（trainingEligible 的）
rr = []
for f, o in all_rows:
    dr = o.get('draft') or ''; raw = o.get('raw') or ''
    if dr and raw and o.get('trainingEligible'):
        rr.append(len(dr)/len(raw))
rr.sort()
if rr:
    n = len(rr)
    p('trainingEligible 手写稿 字符比：n=%d min=%.3f p25=%.3f 中位=%.3f p75=%.3f max=%.3f' % (n, rr[0], rr[n//4], rr[n//2], rr[3*n//4], rr[-1]))
OUT.close(); print('ok')