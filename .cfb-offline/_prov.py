import io, json, glob
rows = []
for f in sorted(glob.glob(r'D:\cfb\.cfb-runtime\traj\*\hand-samples.jsonl')):
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            try: rows.append(json.loads(l))
            except Exception: pass
OUT = io.open(r'D:\cfb\.cfb-offline\_prov.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
# 手写稿是否带模板四件套
import re
T = ['已落定的决定', '落点：', '验收：']
cnt = {t: 0 for t in T}
for o in rows:
    d = o.get('draft') or ''
    for t in T:
        if t in d: cnt[t] += 1
p('手写稿 %d 条中，含模板标记的：' % len(rows))
for t in T: p('   %-12s %d' % (t, cnt[t]))
p('')
o = rows[0]
p('production 字段 = ' + json.dumps(o.get('production'), ensure_ascii=False)[:600])
p('')
p('qualityAudit = ' + json.dumps(o.get('qualityAudit'), ensure_ascii=False)[:400])
OUT.close(); print('ok')